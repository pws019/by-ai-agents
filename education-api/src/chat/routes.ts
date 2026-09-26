// 会话的读写接口（POST /conversations/:id/messages 的流式部分在后续步骤）。
// 所有接口都是"本人的会话"：不存在和不是本人的一律 404，不泄露别人会话是否存在。
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth, requireRole } from "../auth/middleware.js";
import type { Db } from "../db/pool.js";
import { conversations, messages } from "../db/schema.js";
import { errorJson } from "../http/errors.js";
import { findOwnedConversation, latestRun } from "./runs.js";

const MESSAGE_PAGE = 200;

export function createConversationRoutes(db: Db): Hono {
  const app = new Hono();
  const student = requireRole("student");

  app.post("/conversations", requireAuth, student, async (c) => {
    const actor = c.get("actor")!;
    const [row] = await db.insert(conversations).values({ ownerId: actor.id }).returning();
    return c.json({ id: row!.id, mode: row!.mode, createdAt: row!.createdAt }, 201);
  });

  app.get("/conversations", requireAuth, student, async (c) => {
    const actor = c.get("actor")!;
    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.ownerId, actor.id))
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(50);
    return c.json({ items: rows.map((r) => ({ id: r.id, mode: r.mode, createdAt: r.createdAt })) });
  });

  // 断线后的恢复入口：已存消息 + 最近一次运行的状态（含"租约过期 → 失败"的判定，见 latestRun）。
  app.get("/conversations/:conversationId/messages", requireAuth, student, async (c) => {
    const actor = c.get("actor")!;
    const conversation = await findOwnedConversation(db, c.req.param("conversationId")!, actor.id);
    if (!conversation) return errorJson(c, 404, "NOT_FOUND", "会话不存在");

    const recent = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(MESSAGE_PAGE);
    return c.json({
      items: recent.reverse().map((m) => ({ id: m.id, role: m.role, content: m.content, runId: m.runId, createdAt: m.createdAt })),
      run: await latestRun(db, conversation.id),
    });
  });

  return app;
}

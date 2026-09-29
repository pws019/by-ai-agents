// 转人工接口（契约见 contracts/education/openapi.yaml）：
//   POST /conversations/:id/handoff            学员请求老师接管（owner）
//   POST /teacher/handoffs/:id/claim           老师接管（expectedRevision）
//   POST /teacher/handoffs/:id/release         老师结束接管，会话回到 bot（expectedRevision）
//   POST /teacher/conversations/:id/messages   接管中的老师发消息（clientMessageId 去重）
// 这些路径都在 app.ts 里对 Agent 通道关闭（/conversations/*、/teacher/*）：接管由学员本人或 BFF 发起，
// Agent 服务不直接读写会话——它只通过事件流告诉 BFF"我认为该转人工"，由 BFF 落库（见 chat/supervisor.ts）。
import { Hono, type Context } from "hono";
import { requireAuth, requireRole } from "../auth/middleware.js";
import type { Db } from "../db/pool.js";
import { findOwnedConversation } from "../chat/runs.js";
import { errorJson } from "../http/errors.js";
import { claimHandoff, releaseHandoff, requestHandoff, teacherSendMessage, toHandoff, type TransitionResult } from "./handoffs.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MAX = 500;

export function createHandoffRoutes(db: Db): Hono {
  const app = new Hono();

  app.post("/conversations/:conversationId/handoff", requireAuth, requireRole("student"), async (c) => {
    const actor = c.get("actor")!;
    const conversationId = c.req.param("conversationId")!;
    const conversation = UUID.test(conversationId) ? await findOwnedConversation(db, conversationId, actor.id) : null;
    if (!conversation) return errorJson(c, 404, "NOT_FOUND", "会话不存在");

    const body = await c.req.json().catch(() => ({}));
    const reason = body?.reason;
    if (reason !== undefined && (typeof reason !== "string" || reason.length > REASON_MAX)) {
      return errorJson(c, 422, "VALIDATION_ERROR", `reason 必须是不超过 ${REASON_MAX} 字符的字符串`);
    }

    const result = await requestHandoff(db, { conversationId: conversation.id, reason: reason?.trim() || null });
    if (result.kind === "closed") return errorJson(c, 409, "INVALID_STATE", "这个会话已经关闭");
    return c.json(toHandoff(result.handoff, "student"));
  });

  // 以下都是老师专属：先登录、再校验角色。
  app.use("/teacher/handoffs/*", requireAuth, requireRole("teacher"));
  app.use("/teacher/conversations/*", requireAuth, requireRole("teacher"));

  const transition = (op: typeof claimHandoff | typeof releaseHandoff) => async (c: Context) => {
    const actor = c.get("actor")!;
    const handoffId = c.req.param("handoffId")!;
    const body = await c.req.json().catch(() => null);
    if (!body || !Number.isInteger(body.expectedRevision)) return errorJson(c, 422, "VALIDATION_ERROR", "expectedRevision 必填");
    if (!UUID.test(handoffId)) return errorJson(c, 404, "NOT_FOUND", "接管记录不存在");

    return respondTransition(c, await op(db, { handoffId, teacherId: actor.id, expectedRevision: body.expectedRevision }));
  };
  app.post("/teacher/handoffs/:handoffId/claim", transition(claimHandoff));
  app.post("/teacher/handoffs/:handoffId/release", transition(releaseHandoff));

  app.post("/teacher/conversations/:conversationId/messages", async (c) => {
    const actor = c.get("actor")!;
    const conversationId = c.req.param("conversationId")!;
    const body = await c.req.json().catch(() => null);
    const { clientMessageId, text } = body ?? {};
    if (typeof clientMessageId !== "string" || clientMessageId.length < 1 || clientMessageId.length > 100
      || typeof text !== "string" || text.length < 1 || text.length > 4000) {
      return errorJson(c, 422, "VALIDATION_ERROR", "clientMessageId（1-100 字符）与 text（1-4000 字符）必填");
    }
    if (!UUID.test(conversationId)) return errorJson(c, 404, "NOT_FOUND", "会话不存在");

    const result = await teacherSendMessage(db, { conversationId, teacherId: actor.id, clientMessageId, text });
    switch (result.kind) {
      case "not_found": return errorJson(c, 404, "NOT_FOUND", "会话不存在");
      case "not_human": return errorJson(c, 409, "INVALID_STATE", "这个会话当前不在人工接管中，请先接管");
      case "forbidden": return errorJson(c, 403, "FORBIDDEN", "这个会话正被另一位老师接管");
      case "id_taken": return errorJson(c, 422, "VALIDATION_ERROR", "clientMessageId 已被使用");
      case "duplicate": return c.json(toMessage(result.message), 200);
      case "sent": return c.json(toMessage(result.message), 201);
    }
  });

  return app;
}

function respondTransition(c: Context, result: TransitionResult) {
  switch (result.kind) {
    case "ok": return c.json(toHandoff(result.handoff, "teacher"));
    case "not_found": return errorJson(c, 404, "NOT_FOUND", "接管记录不存在");
    case "forbidden": return errorJson(c, 403, "FORBIDDEN", "只有接管这个会话的老师可以结束接管");
    case "invalid_state": return errorJson(c, 409, "INVALID_STATE", "接管记录当前的状态不允许这个操作（可能已被其他老师接管或已结束）");
    case "revision_conflict": return errorJson(c, 409, "REVISION_CONFLICT", "接管记录已被修改，请刷新后重试");
  }
}

function toMessage(row: { id: string; role: string; content: string; runId: string | null; createdAt: Date }) {
  return { id: row.id, role: row.role, content: row.content, runId: row.runId, createdAt: row.createdAt };
}

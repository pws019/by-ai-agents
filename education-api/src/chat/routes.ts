// 会话接口：创建/列表/读消息，以及两个会驱动 Agent 的流式接口——发消息与"确认后恢复"。
// 所有接口都是"本人的会话"：不存在和不是本人的一律 404，不泄露别人会话是否存在。
import { desc, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { requireAuth, requireRole } from "../auth/middleware.js";
import type { Db } from "../db/pool.js";
import { conversations, messages } from "../db/schema.js";
import { errorJson } from "../http/errors.js";
import type { AgentClient, AgentEvent } from "./agentClient.js";
import { findActiveHandoff, listConversationMessages, toHandoff } from "../handoffs/handoffs.js";
import { findPendingConfirmationForConversation } from "../routes/applications.js";
import { findOwnedConversation, latestRun, startMessageRun, startResumeRun } from "./runs.js";
import { beginRun, type BeginResult, type RunChannel } from "./supervisor.js";

// 单表查询里 drizzle 会把 ${conversations.id} 渲染成不带表名的 "id"，放进子查询就被解析成 messages 自己的 id、永远匹配不上，
// 所以子查询里对外层会话 id 的引用必须显式带上表名。
const OUTER_CONVERSATION_ID = sql.raw('"app"."conversations"."id"');
const TITLE_MAX_CHARS = 24;

// 会话标题：首条用户消息截断（首版不提供改名）。按字符而不是字节截断，不会把汉字切成两半。
const titleOf = (content: string | null) => {
  if (!content) return null;
  const chars = [...content.trim()];
  return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS).join("")}…` : chars.join("");
};
const RUN_ERROR_CODES = new Set(["DEPENDENCY_UNAVAILABLE", "BUDGET_EXCEEDED", "TOOL_FAILED", "INTERNAL"]);

export interface ChatDeps {
  agent?: AgentClient;
  internalSecret?: string;
  heartbeatIntervalMs?: number;
}

export function createConversationRoutes(db: Db, deps: ChatDeps = {}): Hono {
  const app = new Hono();
  const student = requireRole("student");
  const supervisorDeps = () => (deps.agent && deps.internalSecret ? { db, agent: deps.agent, internalSecret: deps.internalSecret, heartbeatIntervalMs: deps.heartbeatIntervalMs } : null);

  /** 把 beginRun 的结果变成 HTTP 响应：开流前的失败是普通的错误响应，成功才开始 SSE。 */
  const respondToBegin = (c: Context, begin: BeginResult) => {
    if (begin.kind === "unavailable") return errorJson(c, 503, "DEPENDENCY_UNAVAILABLE", "智能助手暂时不可用，请稍后重试");
    if (begin.kind === "rejected") {
      if (begin.status === 409) return errorJson(c, 409, "INVALID_STATE", "当前没有等待确认的申请");
      return errorJson(c, 503, "DEPENDENCY_UNAVAILABLE", "智能助手暂时不可用，请稍后重试");
    }
    return sse(c, begin.channel);
  };

  app.post("/conversations", requireAuth, student, async (c) => {
    const actor = c.get("actor")!;
    const [row] = await db.insert(conversations).values({ ownerId: actor.id }).returning();
    return c.json({ id: row!.id, mode: row!.mode, createdAt: row!.createdAt, title: null }, 201);
  });

  app.get("/conversations", requireAuth, student, async (c) => {
    const actor = c.get("actor")!;
    const rows = await db
      .select({
        id: conversations.id,
        mode: conversations.mode,
        createdAt: conversations.createdAt,
        firstMessage: sql<string | null>`(select m.content from ${messages} m where m.conversation_id = ${OUTER_CONVERSATION_ID} and m.role = 'user' order by m.created_at, m.id limit 1)`,
      })
      .from(conversations)
      .where(eq(conversations.ownerId, actor.id))
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(50);
    return c.json({ items: rows.map((r) => ({ id: r.id, mode: r.mode, createdAt: r.createdAt, title: titleOf(r.firstMessage) })) });
  });

  // 断线后的恢复入口：已存消息 + 最近一次运行的状态（含"租约过期 → 失败"的判定，见 latestRun）。
  // 不传 after 是完整快照（首次打开/断线重连）；轮询时带上目前看到的最后一条消息 id 作为 after，
  // 只拿增量——排队/接管期间前端要反复轮询才能看到对方的消息，不加这个游标每次都要重传整个窗口。
  app.get("/conversations/:conversationId/messages", requireAuth, student, async (c) => {
    const actor = c.get("actor")!;
    const conversation = await findOwnedConversation(db, c.req.param("conversationId")!, actor.id);
    if (!conversation) return errorJson(c, 404, "NOT_FOUND", "会话不存在");

    return c.json({
      items: await listConversationMessages(db, conversation.id, c.req.query("after")),
      run: await latestRun(db, conversation.id),
      // 排队/人工接管的状态：前端据此显示"排队中 / 老师处理中"，刷新页面后也能找回。
      mode: conversation.mode,
      handoff: await findActiveHandoff(db, conversation.id).then((h) => (h ? toHandoff(h, "student") : null)),
      // 断线重连后找回待确认的草稿：确认卡在实时流里发出过，但不在消息里。
      pendingConfirmation: await findPendingConfirmationForConversation(db, conversation.id),
    });
  });

  // 发送消息：先判重与抢锁（runs.ts），再让 Agent 跑；响应是 SSE。
  app.post("/conversations/:conversationId/messages", requireAuth, student, async (c) => {
    const actor = c.get("actor")!;
    const conversation = await findOwnedConversation(db, c.req.param("conversationId")!, actor.id);
    if (!conversation) return errorJson(c, 404, "NOT_FOUND", "会话不存在");

    const body = await c.req.json().catch(() => null);
    const clientMessageId = body?.clientMessageId;
    const text = body?.text;
    if (typeof clientMessageId !== "string" || clientMessageId.length < 1 || clientMessageId.length > 100
      || typeof text !== "string" || text.length < 1 || text.length > 4000) {
      return errorJson(c, 422, "VALIDATION_ERROR", "clientMessageId（1-100 字符）与 text（1-4000 字符）必填");
    }

    const deps_ = supervisorDeps();
    if (!deps_) return errorJson(c, 503, "DEPENDENCY_UNAVAILABLE", "智能助手未配置");

    const started = await startMessageRun(db, { conversationId: conversation.id, clientMessageId, text });
    if (started.kind === "busy") return errorJson(c, 409, "RUN_IN_PROGRESS", "上一条消息还在处理中");
    if (started.kind === "closed") return errorJson(c, 409, "INVALID_STATE", "这个会话已经关闭");
    if (started.kind === "recorded") {
      // 排队或老师接管中：消息已存下来给老师看，机器人不回复。响应仍是 SSE，只有一个 handoff.status 事件，
      // 这样前端沿用同一套流处理。这个事件不属于任何 Agent 运行，runId 取被记录消息的 id，只用于客户端关联。
      return replayOnce(c, {
        eventId: "1", conversationId: conversation.id, runId: started.userMessageId, type: "handoff.status", payload: { mode: started.mode },
      });
    }
    if (started.kind === "duplicate") {
      const { run, assistantMessage } = started;
      if (run.status === "running") return errorJson(c, 409, "RUN_IN_PROGRESS", "这条消息正在处理中");
      // 已经有结果：回放它（要重试一个失败的请求，请换新的 clientMessageId）。
      const replay: AgentEvent = run.status === "completed" && assistantMessage
        ? { eventId: "1", conversationId: conversation.id, runId: run.id, type: "message.completed", payload: { messageId: assistantMessage.id, text: assistantMessage.content } }
        : { eventId: "1", conversationId: conversation.id, runId: run.id, type: "run.error", payload: { code: contractErrorCode(run.errorCode), message: "上一次处理没有成功，请重新发送。" } };
      return replayOnce(c, replay);
    }

    return respondToBegin(c, await beginRun(deps_, { runId: started.runId, ownerId: actor.id, conversationId: conversation.id, text }));
  });

  // 学员已在界面上处理了确认卡：让 Agent 恢复，读取申请最新状态并回话。请求体为空，"确认"这件事本身
  // 已经由业务 API 的 POST 完成，这里没有任何内容参与授权（design.md：不把"确认"文本当成授权）。
  app.post("/conversations/:conversationId/resume", requireAuth, student, async (c) => {
    const actor = c.get("actor")!;
    const conversation = await findOwnedConversation(db, c.req.param("conversationId")!, actor.id);
    if (!conversation) return errorJson(c, 404, "NOT_FOUND", "会话不存在");
    const deps_ = supervisorDeps();
    if (!deps_) return errorJson(c, 503, "DEPENDENCY_UNAVAILABLE", "智能助手未配置");

    const started = await startResumeRun(db, conversation.id);
    if (started.kind === "busy") return errorJson(c, 409, "RUN_IN_PROGRESS", "上一条消息还在处理中");
    if (started.kind === "handoff_active") return errorJson(c, 409, "HANDOFF_ACTIVE", "这个会话正在由老师处理，机器人暂时不会回复");
    return respondToBegin(c, await beginRun(deps_, { runId: started.runId, ownerId: actor.id, conversationId: conversation.id, resume: true }));
  });

  return app;
}

/** 把运行通道里的事件写成 SSE。浏览器断开只是停止订阅，不影响后台任务。 */
function sse(c: Context, channel: RunChannel) {
  return streamSSE(c, async (stream) => {
    const gone = new AbortController();
    stream.onAbort(() => gone.abort());
    for await (const e of channel.subscribe(gone.signal)) {
      await stream.writeSSE({ id: e.eventId, event: e.type, data: JSON.stringify(e) });
    }
  });
}

function replayOnce(c: Context, event: AgentEvent) {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ id: event.eventId, event: event.type, data: JSON.stringify(event) });
  });
}

// 库里记的失败原因可能是 LEASE_EXPIRED 等内部值，对外只给契约允许的错误码。
const contractErrorCode = (code: string | null) => (code && RUN_ERROR_CODES.has(code) ? code : "INTERNAL");

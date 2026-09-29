// 聊天事件流的类型与校验。形状以 contracts/education/events.schema.json 为准；这里只列前端当前会处理的类型，
// 契约里其它类型（citation、replay.card）归为 "other"：认得是合法事件，但界面暂不展示，不当作错误。

export type ToolStatusValue = "started" | "succeeded" | "failed";
/** 会话此刻由谁应答，见 GET /conversations/:id/messages 的 mode 字段。 */
export type ConversationMode = "bot" | "queued" | "human" | "closed";

export interface ConfirmationCard {
  applicationId: string;
  confirmationId: string;
  revision: number;
  expiresAt: string;
  summary: Record<string, unknown>;
}

interface Envelope {
  eventId: string;
  conversationId: string;
  runId: string;
}

export type StreamEvent = Envelope &
  (
    | { type: "message.delta"; payload: { text: string } }
    | { type: "tool.status"; payload: { tool: string; status: ToolStatusValue } }
    | { type: "application.confirmation"; payload: ConfirmationCard }
    | { type: "message.completed"; payload: { messageId: string; text: string } }
    | { type: "run.error"; payload: { code: string; message: string } }
    // 排队/接管期间学员发消息只被记录，机器人不回复（AC-012）：这是那次发送唯一会收到的事件，不跟着 message.completed。
    // 也会在 Agent 自己判断该转人工时，作为“已进入排队”的通知先于最终回复出现。
    | { type: "handoff.status"; payload: { mode: ConversationMode } }
    | { type: "other"; payload: unknown }
  );

/** 服务端发来的东西不符合协议。和"网络断了"是两回事：前者是对方的 bug，重试也不会好。 */
export class StreamProtocolError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

const KNOWN_TYPES = new Set(["citation", "replay.card"]);
const TOOL_STATUSES = new Set(["started", "succeeded", "failed"]);
const MODES = new Set(["bot", "queued", "human", "closed"]);

export function parseStreamEvent(raw: unknown): StreamEvent {
  if (!isObject(raw) || !isString(raw.eventId) || !isString(raw.conversationId) || !isString(raw.runId) || !isString(raw.type) || !isObject(raw.payload)) {
    throw new StreamProtocolError("事件缺少 eventId/conversationId/runId/type/payload");
  }
  const envelope: Envelope = { eventId: raw.eventId, conversationId: raw.conversationId, runId: raw.runId };
  const p = raw.payload;

  switch (raw.type) {
    case "message.delta":
      if (!isString(p.text)) break;
      return { ...envelope, type: "message.delta", payload: { text: p.text } };
    case "tool.status":
      if (!isString(p.tool) || !isString(p.status) || !TOOL_STATUSES.has(p.status)) break;
      return { ...envelope, type: "tool.status", payload: { tool: p.tool, status: p.status as ToolStatusValue } };
    case "application.confirmation":
      if (!isString(p.applicationId) || !isString(p.confirmationId) || typeof p.revision !== "number" || !isString(p.expiresAt) || !isObject(p.summary)) break;
      return { ...envelope, type: "application.confirmation", payload: { applicationId: p.applicationId, confirmationId: p.confirmationId, revision: p.revision, expiresAt: p.expiresAt, summary: p.summary } };
    case "message.completed":
      if (!isString(p.messageId) || !isString(p.text)) break;
      return { ...envelope, type: "message.completed", payload: { messageId: p.messageId, text: p.text } };
    case "run.error":
      if (!isString(p.code) || !isString(p.message)) break;
      return { ...envelope, type: "run.error", payload: { code: p.code, message: p.message } };
    case "handoff.status":
      if (!isString(p.mode) || !MODES.has(p.mode)) break;
      return { ...envelope, type: "handoff.status", payload: { mode: p.mode as ConversationMode } };
    default:
      if (KNOWN_TYPES.has(raw.type)) return { ...envelope, type: "other", payload: p };
      throw new StreamProtocolError(`未知的事件类型: ${raw.type}`);
  }
  throw new StreamProtocolError(`${raw.type} 事件的载荷不符合契约`);
}

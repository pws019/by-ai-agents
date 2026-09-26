// 聊天事件流的类型与校验。形状以 contracts/education/events.schema.json 为准；这里只列前端当前会处理的类型，
// 契约里其它类型（citation、replay.card、handoff.status）归为 "other"：认得是合法事件，但界面暂不展示，不当作错误。

export type ToolStatusValue = "started" | "succeeded" | "failed";

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
    | { type: "other"; payload: unknown }
  );

/** 服务端发来的东西不符合协议。和"网络断了"是两回事：前者是对方的 bug，重试也不会好。 */
export class StreamProtocolError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

const KNOWN_TYPES = new Set(["citation", "replay.card", "handoff.status"]);
const TOOL_STATUSES = new Set(["started", "succeeded", "failed"]);

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
    default:
      if (KNOWN_TYPES.has(raw.type)) return { ...envelope, type: "other", payload: p };
      throw new StreamProtocolError(`未知的事件类型: ${raw.type}`);
  }
  throw new StreamProtocolError(`${raw.type} 事件的载荷不符合契约`);
}

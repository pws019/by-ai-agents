import type { ChatMessage, ChatRole, SessionSummary, ToolCallInfo } from "../types";

// @mastra/client-js 对外暴露的类型比较宽松（很多字段是可选/联合类型），
// 这里统一做“防御性”字段提取，把 SDK 返回的原始对象翻译成前端自己的展示类型，
// 避免 SDK 内部字段命名变化时到处改组件代码。

type UnknownRecord = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeThread(raw: UnknownRecord): SessionSummary {
  const id = asString(raw.id) ?? asString(raw.threadId) ?? "";
  const title = asString(raw.title) || "未命名会话";
  const updatedAt =
    asString(raw.updatedAt) ?? asString(raw.updated_at) ?? asString(raw.createdAt) ?? null;

  return { id, title, updatedAt };
}

// 消息正文可能是：
// - 字符串
// - { content: string }（dbMessage 风格）
// - { parts: [{ type: "text", text: string }, ...] }（uiMessage 风格，content 或顶层都可能有）
function extractText(raw: UnknownRecord): string {
  if (typeof raw.content === "string") return raw.content;

  const content = raw.content as UnknownRecord | undefined;
  if (content && typeof content.content === "string") return content.content;

  const partsSource = (content?.parts ?? raw.parts) as unknown;
  if (Array.isArray(partsSource)) {
    return partsSource
      .filter(
        (part): part is { type: string; text: string } =>
          typeof part === "object" && part !== null && (part as UnknownRecord).type === "text",
      )
      .map((part) => part.text)
      .join("");
  }

  return "";
}

// 历史消息里的工具调用记录存在 content.parts 里，跟正文 text part 平级：
// { type: "tool-invocation", toolInvocation: { toolCallId, toolName, args, result, state } }。
// 实测发现（见 todo.md）：不管工具调用当时是成功还是失败，存储下来的 state 都是 "result"，
// 失败时 result 字段就是错误信息字符串——存储层面没法干净地区分成功/失败，所以历史消息里
// 统一按 "done" 处理，只有实时流式过程中才能准确展示 "running"/"error" 这些中间状态。
function extractToolCalls(raw: UnknownRecord): ToolCallInfo[] {
  const content = raw.content as UnknownRecord | undefined;
  const partsSource = (content?.parts ?? raw.parts) as unknown;
  if (!Array.isArray(partsSource)) return [];

  return partsSource
    .filter(
      (part): part is { type: string; toolInvocation: UnknownRecord } =>
        typeof part === "object" &&
        part !== null &&
        (part as UnknownRecord).type === "tool-invocation" &&
        typeof (part as UnknownRecord).toolInvocation === "object",
    )
    .map((part) => {
      const inv = part.toolInvocation;
      return {
        toolCallId: asString(inv.toolCallId) ?? crypto.randomUUID(),
        toolName: asString(inv.toolName) ?? "unknown",
        args: inv.args,
        result: inv.result,
        status: "done" as const,
      };
    });
}

// tool-error chunk 的 payload.error 是个嵌套结构（见 useChat.ts 里实测记录的样本），
// 常见字段路径是 error.cause.message 或 error.details.errorMessage，兜底用 error.message/name。
export function extractToolErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  const e = error as UnknownRecord | undefined;
  const cause = e?.cause as UnknownRecord | undefined;
  const details = e?.details as UnknownRecord | undefined;
  return (
    asString(cause?.message) ??
    asString(details?.errorMessage) ??
    asString(e?.message) ??
    asString(e?.name) ??
    "工具调用失败"
  );
}

export function normalizeMessage(raw: UnknownRecord): ChatMessage {
  const role = raw.role === "assistant" ? "assistant" : ("user" satisfies ChatRole);
  const toolCalls = extractToolCalls(raw);
  return {
    id: asString(raw.id) ?? crypto.randomUUID(),
    role,
    content: extractText(raw),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

// 前端自己的展示层类型，跟 @mastra/client-js 返回的原始数据结构解耦——
// 各个 hook 负责把 SDK 返回值“翻译”成这些类型，组件只认这些类型，
// 以后 SDK 返回结构变了，改动只影响 hooks，不影响组件。

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: string | null;
};

export type ChatRole = "user" | "assistant";

export type ToolCallStatus = "running" | "done" | "error";

export type ToolCallInfo = {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  status: ToolCallStatus;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  // 附着在这条助手消息上的工具调用记录，实时流和历史消息都会填充这个字段
  // （历史消息统一按 "done" 处理，因为存储阶段成功/失败都是 state: "result"，
  // 无法干净地区分，见 lib/normalize.ts 里的说明）。
  toolCalls?: ToolCallInfo[];
};

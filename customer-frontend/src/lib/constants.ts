// mastra dev 默认监听地址；同一台机器本地开发时用这个就够了，
// 部署到别处时通过环境变量覆盖。
export const MASTRA_BASE_URL =
  import.meta.env.VITE_MASTRA_BASE_URL ?? "http://localhost:4111";

// 目前只对接这一个 agent，不做多 agent 选择器（见 PRD "明确不做"）。
export const AGENT_ID = "customer-service-agent";

// 匿名身份 Cookie 的名字和有效期。
export const ANONYMOUS_ID_COOKIE_NAME = "cf_resource_id";
export const ANONYMOUS_ID_COOKIE_MAX_AGE_DAYS = 365;

// 会话标题的截断长度（首版直接用首条消息内容截断当标题，见 PRD）。
export const SESSION_TITLE_MAX_LENGTH = 24;

// 流式响应过程中，模型调用工具时展示的中间状态文案，对应
// customer-agents 里 knowledgeRagTool / logisticsLookupTool 这两个工具。
// 没匹配到名字的工具（理论上不会发生，agent 目前只有这两个工具）用兜底文案。
export const TOOL_STATUS_LABELS: Record<string, string> = {
  knowledgeRagTool: "正在查询知识库…",
  logisticsLookupTool: "正在查询物流…",
};
export const DEFAULT_STATUS_LABEL = "正在处理…";

// 持久化展示在消息气泡里的工具调用卡片用的名字（不带"正在…"这种进行时语气，
// 因为这个卡片对话结束后还留在聊天记录里）。
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  knowledgeRagTool: "知识库检索",
  logisticsLookupTool: "物流查询",
};
export const DEFAULT_TOOL_DISPLAY_NAME = "工具调用";

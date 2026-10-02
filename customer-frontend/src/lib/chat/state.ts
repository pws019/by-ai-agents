// 聊天界面的状态与"事件 → 状态"的纯函数。没有任何副作用、不依赖 React，所以可以直接单元测试。
// 界面拿到的永远是新的状态对象（不原地修改），React 才能可靠地感知变化。
import type { CitationPayload, ConfirmationCard, ConversationMode, StreamEvent, ToolStatusValue } from "./events";

export interface ToolStatus {
  tool: string;
  status: ToolStatusValue;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "teacher" | "system";
  content: string;
  tools: ToolStatus[];
  // searchKnowledge 命中时服务端发的引用（T-28）；有 segmentId 且 startSeconds/endSeconds 都不是
  // null 的才能渲染回放卡片——讲义没有时间轴，只是一条文字引用，没有可以跳转播放的位置。
  citations: CitationPayload[];
  // streaming：还在生成；done：完整；error：这次运行失败了（content 是已收到的部分文字，error 是原因）
  state: "streaming" | "done" | "error";
  error?: string;
}

export interface ChatState {
  messages: ChatMessage[];
  /** 待用户确认的申请草稿。不属于某一条消息：它可能来自实时事件，也可能是断线重连后从服务端找回的。 */
  pendingConfirmation: ConfirmationCard | null;
  /** idle 空闲；streaming 正在接收；reconnecting 连接断了，正在向服务端查询这次运行的结果。 */
  phase: "idle" | "streaming" | "reconnecting";
  /** 给用户看的整体提示（不是某条消息的错误）。 */
  notice: string | null;
  /** 会话此刻由谁应答：bot 机器人；queued 已请求人工、排队中；human 老师接管中；closed 已关闭。 */
  mode: ConversationMode;
}

export interface ServerMessage {
  id: string;
  role: ChatMessage["role"];
  content: string;
}

export const emptyChat = (): ChatState => ({ messages: [], pendingConfirmation: null, phase: "idle", notice: null, mode: "bot" });

/** 用户发出一条消息：先把它和一条"正在生成"的助手消息放进去。用户消息的 id 就是 clientMessageId，重试时保持不变。 */
export function startTurn(state: ChatState, clientMessageId: string, text: string): ChatState {
  return {
    ...state,
    phase: "streaming",
    notice: null,
    messages: [
      ...state.messages,
      { id: clientMessageId, role: "user", content: text, tools: [], citations: [], state: "done" },
      { id: `pending-${clientMessageId}`, role: "assistant", content: "", tools: [], citations: [], state: "streaming" },
    ],
  };
}

/** 只有"恢复"（用户在界面确认后让 Agent 回话）：没有用户消息，只有一条正在生成的助手消息。 */
export function startResume(state: ChatState): ChatState {
  return {
    ...state,
    phase: "streaming",
    notice: null,
    messages: [...state.messages, { id: `pending-resume-${state.messages.length}`, role: "assistant", content: "", tools: [], citations: [], state: "streaming" }],
  };
}

export function applyEvent(state: ChatState, event: StreamEvent): ChatState {
  switch (event.type) {
    case "message.delta":
      return updateAssistant(state, (m) => ({ ...m, content: m.content + event.payload.text }));
    case "tool.status":
      return updateAssistant(state, (m) => ({ ...m, tools: applyToolStatus(m.tools, event.payload.tool, event.payload.status) }));
    case "citation":
      return updateAssistant(state, (m) => ({ ...m, citations: [...m.citations, event.payload] }));
    case "replay.card":
      // 不单独存：总是跟在一条带完整时间范围的 citation 后面发出（见 education-agent 的
      // graphs/loop.py），界面直接用那条 citation 的 segmentId/startSeconds/endSeconds 渲染
      // 回放卡片，这个事件目前只是同一份信息的子集，不重复维护一份状态。
      return state;
    case "application.confirmation":
      return { ...state, pendingConfirmation: event.payload };
    case "message.completed":
      // 以完整文本为准：即使中间有 delta 丢失或重复，最终显示的也是服务端确认的完整回答；同时拿到真实的 messageId。
      return {
        ...updateAssistant(state, (m) => ({ ...m, id: event.payload.messageId, content: event.payload.text, state: "done", error: undefined })),
        phase: "idle",
      };
    case "run.error":
      return { ...updateAssistant(state, (m) => ({ ...m, state: "error", error: event.payload.message })), phase: "idle" };
    case "handoff.status":
      // 排队/接管期间发的消息不会有机器人回复：把那条空的"正在生成"占位去掉，不留下永远转圈的气泡。
      // （Agent 自己判断该转人工时，这个事件先于最终的 message.completed 到达；那时占位还没被填内容，
      // 同样会被这里清掉——随后 message.completed 到达时 updateAssistant 找不到占位，会自动新建一条，见下方实现。）
      return {
        ...state,
        mode: event.payload.mode,
        phase: "idle",
        messages: state.messages.filter((m) => !(m.role === "assistant" && m.state === "streaming" && m.content === "")),
      };
  }
}

/** 连接断了、没有收到收尾事件：把正在生成的那条标记为中断，进入"重连查询"阶段。 */
export function markDisconnected(state: ChatState): ChatState {
  return { ...state, phase: "reconnecting", notice: "连接中断，正在确认这条消息的处理结果…" };
}

/** 请求在开流之前就被拒绝了（如上一条还在处理、Agent 不可用）：那条占位的助手消息标记为失败。 */
export function failTurn(state: ChatState, message: string): ChatState {
  return { ...state, phase: "idle", notice: null, messages: state.messages.map((m, i) => (i === lastAssistantIndex(state) && m.state === "streaming" ? { ...m, state: "error", error: message } : m)) };
}

export function clearConfirmation(state: ChatState): ChatState {
  return { ...state, pendingConfirmation: null };
}

export function withNotice(state: ChatState, notice: string | null): ChatState {
  return { ...state, notice };
}

/** 以服务端为准重建状态：打开会话、以及断线后查询到结果时用。 */
export function fromServer(
  messages: ServerMessage[],
  pendingConfirmation: ConfirmationCard | null,
  mode: ConversationMode,
  keep?: Pick<ChatState, "notice">,
): ChatState {
  return {
    messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, tools: [], citations: [], state: "done" as const })),
    pendingConfirmation,
    mode,
    phase: "idle",
    notice: keep?.notice ?? null,
  };
}

/**
 * 轮询增量结果：只把新消息接到已有列表后面，不重建整个状态（用于排队/接管期间的轮询，避免每次
 * 把整个消息列表重新替换一遍）。items 为空数组时只更新 pendingConfirmation/mode。
 * 调用前提：本地消息列表自上一次全量同步（fromServer）以来没有被别的来源改过——调用方（useChat）
 * 负责保证这一点：任何本地产生的更新（发消息、确认、转人工……）都会让下一次轮询改走全量快照，
 * 而不是继续在这里追加，避免本地乐观消息（用 clientMessageId 占位，还没换成服务端真实 id）
 * 和服务端返回的同一条消息重复出现。
 */
export function appendServer(state: ChatState, items: ServerMessage[], pendingConfirmation: ConfirmationCard | null, mode: ConversationMode): ChatState {
  if (items.length === 0) return { ...state, pendingConfirmation, mode };
  return {
    ...state,
    messages: [...state.messages, ...items.map((m) => ({ id: m.id, role: m.role, content: m.content, tools: [] as ToolStatus[], citations: [] as CitationPayload[], state: "done" as const }))],
    pendingConfirmation,
    mode,
    phase: "idle",
  };
}

// ---- 内部 ---------------------------------------------------------------------------------

function lastAssistantIndex(state: ChatState): number {
  for (let i = state.messages.length - 1; i >= 0; i--) if (state.messages[i]!.role === "assistant") return i;
  return -1;
}

/** 更新"最后一条正在生成的助手消息"。找不到就新建一条（比如重复提交时服务端只回放了一个 message.completed）。 */
function updateAssistant(state: ChatState, update: (m: ChatMessage) => ChatMessage): ChatState {
  const last = state.messages.at(-1);
  if (last && last.role === "assistant" && last.state === "streaming") {
    return { ...state, messages: [...state.messages.slice(0, -1), update(last)] };
  }
  const fresh: ChatMessage = { id: `pending-${state.messages.length}`, role: "assistant", content: "", tools: [], citations: [], state: "streaming" };
  return { ...state, messages: [...state.messages, update(fresh)] };
}

/** tool.status 没有调用 id：started 追加一项；succeeded/failed 更新同名工具里最近一个还在进行中的。 */
function applyToolStatus(tools: ToolStatus[], tool: string, status: ToolStatusValue): ToolStatus[] {
  if (status === "started") return [...tools, { tool, status }];
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i]!.tool === tool && tools[i]!.status === "started") return tools.map((t, j) => (j === i ? { tool, status } : t));
  }
  return [...tools, { tool, status }];
}

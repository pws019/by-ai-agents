// 聊天的流程：发送消息、断线后恢复、确认草稿后让 Agent 回话、打开已有会话。
// 每个流程是一个异步生成器：每产生一个新的界面状态就 yield 一次，界面只需要 `for await` 后 setState。
// 所有网络操作都通过注入的 ChatApi，所以可以用假 API 测试各种断线、超时、冲突，不必起服务。
import { ApiError } from "../../education/api";
import { StreamProtocolError, type ConfirmationCard, type ConversationMode, type StreamEvent } from "./events";
import {
  applyEvent, clearConfirmation, failTurn, fromServer, markDisconnected, startResume, startTurn, withNotice,
  type ChatState, type ServerMessage,
} from "./state";

export interface RunView {
  id: string;
  kind: "message" | "resume";
  status: "running" | "completed" | "failed";
  errorCode: string | null;
}

export interface MessagesResponse {
  items: ServerMessage[];
  run: RunView | null;
  pendingConfirmation: ConfirmationCard | null;
  mode: ConversationMode;
}

export interface ChatApi {
  /** 开流之前就被拒绝（409/503 等）时 reject 为 ApiError；成功则返回事件流。 */
  sendMessage(conversationId: string, body: { clientMessageId: string; text: string }): Promise<AsyncIterable<StreamEvent>>;
  resume(conversationId: string): Promise<AsyncIterable<StreamEvent>>;
  /** after：只要某条消息 id 之后的新消息（轮询增量用）；不传是最近 200 条快照。见 education-api 的同名参数。 */
  getMessages(conversationId: string, after?: string): Promise<MessagesResponse>;
  /** 用户本人对业务 API 的确认（不是 Agent 的能力）。 */
  confirmApplication(applicationId: string, body: { confirmationId: string; expectedRevision: number }): Promise<unknown>;
  /** 用户本人请求老师接管（不是 Agent 的能力）：会话 bot → queued。 */
  requestHandoff(conversationId: string, reason?: string): Promise<unknown>;
}

export interface SettleOptions {
  intervalMs?: number;
  timeoutMs?: number; // 要长于服务端的运行租约（90 秒），否则会在服务端判定失败之前就放弃
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULTS = { intervalMs: 1000, timeoutMs: 100_000 };

// ---- 发送消息 -----------------------------------------------------------------------------

export async function* sendTurn(
  api: ChatApi, conversationId: string, state: ChatState, text: string, clientMessageId: string, opts?: SettleOptions,
): AsyncGenerator<ChatState> {
  const started = startTurn(state, clientMessageId, text);
  yield started;
  yield* streamAndRecover(api, conversationId, () => api.sendMessage(conversationId, { clientMessageId, text }), started, opts);
}

// ---- 确认草稿后恢复 -----------------------------------------------------------------------

/**
 * 用户点了"确认"：先对业务 API 确认（这是用户本人的操作，Agent 没有这个能力），成功后再让 Agent 恢复、读取最新状态回话。
 * 确认没成功时保留确认卡，让用户能重试或核对；确认已经成功但 Agent 那边没法回话时，不报错——申请已经提交了。
 */
export async function* confirmDraft(api: ChatApi, conversationId: string, state: ChatState, opts?: SettleOptions): AsyncGenerator<ChatState> {
  const card = state.pendingConfirmation;
  if (!card) return;

  try {
    await api.confirmApplication(card.applicationId, { confirmationId: card.confirmationId, expectedRevision: card.revision });
  } catch (err) {
    if (err instanceof ApiError && (err.code === "STALE_CONFIRMATION" || err.code === "INVALID_STATE" || err.code === "REVISION_CONFLICT")) {
      // 确认卡已经失效（草稿被改过、已被确认过或已过期）：以服务端为准重新加载，可能会带回一张新的确认卡。
      yield* reload(api, conversationId, "这张确认卡已经失效，请核对最新内容。");
    } else {
      yield withNotice(state, describe(err, "确认没有成功，请检查网络后重试。"));
    }
    return;
  }

  const resuming = clearConfirmation(startResume(state));
  yield resuming;
  yield* streamAndRecover(api, conversationId, () => api.resume(conversationId), resuming, opts, (err) => {
    if (err.code === "INVALID_STATE") return "你的确认已提交，可以在“我的申请”里查看进度。";
    // 接管期间恢复 Agent 会被拒绝（只有机器人能做这件事）：确认本身已经成功了，不是错误。
    if (err.code === "HANDOFF_ACTIVE") return "你的确认已提交；这个会话正由老师处理，我暂时不会自动回复。";
    return null;
  });
}

// ---- 转人工 -------------------------------------------------------------------------------

/**
 * 学员点"转人工"：这是用户本人对业务 API 的操作，不经过 Agent（同 confirmDraft 里的确认）。
 * 成功后不用本地拼状态——直接以服务端为准重新加载，mode/handoff 一次性对齐，避免和后续事件推导出两套结论。
 */
export async function* requestHandoff(api: ChatApi, conversationId: string, state: ChatState, reason?: string): AsyncGenerator<ChatState> {
  try {
    await api.requestHandoff(conversationId, reason);
  } catch (err) {
    yield withNotice(state, describe(err, "请求转人工失败，请重试。"));
    return;
  }
  yield* reload(api, conversationId, "已经为你转接老师，请耐心等待。");
}

// ---- 打开会话 -----------------------------------------------------------------------------

/** 打开（或刷新）一个会话：以服务端为准；如果它此刻还有运行在生成，就等它结束再给出最终结果。 */
export async function* openConversation(api: ChatApi, conversationId: string, opts?: SettleOptions): AsyncGenerator<ChatState> {
  const first = await api.getMessages(conversationId);
  const initial = fromServer(first.items, first.pendingConfirmation, first.mode);
  yield initial;
  if (first.run?.status === "running") yield* recover(api, conversationId, markDisconnected(initial), opts);
}

// ---- 内部 ---------------------------------------------------------------------------------

async function* streamAndRecover(
  api: ChatApi, conversationId: string, open: () => Promise<AsyncIterable<StreamEvent>>, state: ChatState, opts?: SettleOptions,
  softError?: (err: ApiError) => string | null,
): AsyncGenerator<ChatState> {
  let s = state;
  let finished = false;
  try {
    for await (const event of await open()) {
      s = applyEvent(s, event);
      yield s;
      // handoff.status 也是终态：排队/接管中发的消息只被记录，不会再有 message.completed 跟着来。
      if (event.type === "message.completed" || event.type === "run.error" || event.type === "handoff.status") finished = true;
    }
  } catch (err) {
    if (err instanceof ApiError) {
      // 开流之前就被拒绝：不是"断线"，没有必要去查询。
      const soft = softError?.(err);
      yield soft ? { ...withNotice(s, soft), phase: "idle", messages: s.messages.filter((m) => !(m.role === "assistant" && m.state === "streaming" && m.content === "")) } : failTurn(s, describe(err, "发送失败，请重试。"));
      return;
    }
    if (err instanceof StreamProtocolError || err instanceof SyntaxError) {
      yield failTurn(s, "服务返回了无法识别的数据，请稍后重试。");
      return;
    }
    // 其它（网络中断）：服务端仍会把这次运行跑完，去查询结果。
  }
  if (finished) return;
  yield* recover(api, conversationId, markDisconnected(s), opts);
}

/** 断线后：反复向服务端查询，直到这次运行结束，然后以服务端的记录为准。 */
async function* recover(api: ChatApi, conversationId: string, state: ChatState, opts?: SettleOptions): AsyncGenerator<ChatState> {
  yield state;
  const outcome = await pollUntilSettled(() => api.getMessages(conversationId), opts);
  if (outcome.kind === "unreachable") {
    yield { ...state, phase: "idle", notice: "无法连接到服务，请检查网络后刷新页面查看结果。" };
    return;
  }
  const { items, run, pendingConfirmation, mode } = outcome.value;
  const notice = outcome.kind === "timeout" ? "这条消息仍在处理中，请稍后刷新页面查看结果。"
    : run?.status === "failed" ? "这条消息没有处理成功，请重新发送。" : null;
  yield fromServer(items, pendingConfirmation, mode, { notice });
}

async function* reload(api: ChatApi, conversationId: string, notice: string): AsyncGenerator<ChatState> {
  try {
    const res = await api.getMessages(conversationId);
    yield fromServer(res.items, res.pendingConfirmation, res.mode, { notice });
  } catch {
    yield emptyWithNotice(notice);
  }
}

const emptyWithNotice = (notice: string): ChatState => ({ messages: [], pendingConfirmation: null, phase: "idle", notice, mode: "bot" });

export type Settled =
  | { kind: "settled"; value: MessagesResponse }
  | { kind: "timeout"; value: MessagesResponse } // 服务端仍说在运行，但我们等够久了
  | { kind: "unreachable" }; // 一直没能查询成功

export async function pollUntilSettled(load: () => Promise<MessagesResponse>, opts?: SettleOptions): Promise<Settled> {
  const { intervalMs, timeoutMs } = { ...DEFAULTS, ...opts };
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts?.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let last: MessagesResponse | null = null;

  while (true) {
    try {
      last = await load();
      if (last.run?.status !== "running") return { kind: "settled", value: last };
    } catch {
      // 查询本身失败（网络还没恢复）：继续等，直到超时。
    }
    if (now() >= deadline) return last ? { kind: "timeout", value: last } : { kind: "unreachable" };
    await sleep(intervalMs);
  }
}

const ERROR_TEXT: Record<string, string> = {
  RUN_IN_PROGRESS: "上一条消息还在处理中，请稍候再发。",
  DEPENDENCY_UNAVAILABLE: "智能助手暂时不可用，请稍后重试。",
  UNAUTHORIZED: "登录已过期，请重新登录。",
  VALIDATION_ERROR: "消息格式不对，请检查后重试。",
  NOT_FOUND: "找不到这个会话。",
  FORBIDDEN: "没有权限执行这个操作。",
  HANDOFF_ACTIVE: "这个会话正由老师处理，机器人暂时不会回复。",
};

function describe(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (ERROR_TEXT[err.code] ?? fallback) : fallback;
}

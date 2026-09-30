// 测试辅助（不属于运行时代码）：构造事件、把文本变成可被任意切碎的字节流、假的 ChatApi。
import { ApiError } from "../../education/api";
import type { ConfirmationCard, StreamEvent } from "./events";
import type { ChatApi, MessagesResponse, RunView } from "./session";

export const CONV = "c-1";
export const CARD: ConfirmationCard = { applicationId: "app-1", confirmationId: "conf-1", revision: 1, expiresAt: "2030-01-01T00:00:00Z", summary: { type: "refund" } };

let seq = 0;
export const ev = <T extends StreamEvent["type"]>(type: T, payload: Extract<StreamEvent, { type: T }>["payload"]): StreamEvent =>
  ({ eventId: String(++seq), conversationId: CONV, runId: "run-1", type, payload }) as StreamEvent;

export const delta = (text: string) => ev("message.delta", { text });
export const completed = (text: string, messageId = "m-assistant") => ev("message.completed", { messageId, text });
export const tool = (name: string, status: "started" | "succeeded" | "failed") => ev("tool.status", { tool: name, status });
export const handoffStatus = (mode: "bot" | "queued" | "human" | "closed") => ev("handoff.status", { mode });

export const sseText = (events: unknown[]): string => events.map((e, i) => `id: ${i + 1}\nevent: x\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** 把字节按给定位置切成多块，模拟网络把数据切得很碎。 */
export function streamOf(bytes: Uint8Array, cuts: number[]): ReadableStream<Uint8Array> {
  const points = [0, ...cuts, bytes.length];
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < points.length - 1; i++) controller.enqueue(bytes.slice(points[i], points[i + 1]));
      controller.close();
    },
  });
}

export async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

export const run = (status: RunView["status"], errorCode: string | null = null): RunView => ({ id: "run-1", kind: "message", status, errorCode });
export const server = (over: Partial<MessagesResponse> = {}): MessagesResponse => ({ items: [], run: null, pendingConfirmation: null, mode: "bot", ...over });

/** 事件流：先吐给定事件；如果给了 dropAfter，在吐完后抛出网络错误（模拟中途断线）。 */
export async function* events(list: StreamEvent[], dropAfter?: Error): AsyncGenerator<StreamEvent> {
  for (const e of list) yield e;
  if (dropAfter) throw dropAfter;
}

export interface FakeApiOptions {
  send?: (call: number) => Promise<AsyncIterable<StreamEvent>>;
  resume?: () => Promise<AsyncIterable<StreamEvent>>;
  messages?: (call: number, after?: string) => Promise<MessagesResponse>;
  confirm?: () => Promise<unknown>;
  handoff?: () => Promise<unknown>;
}

export function fakeApi(o: FakeApiOptions = {}) {
  const calls = { send: 0, resume: 0, messages: 0, confirm: 0, handoff: 0, sentBodies: [] as { clientMessageId: string; text: string }[], messagesAfter: [] as (string | undefined)[] };
  const api: ChatApi = {
    sendMessage: async (_id, body) => { calls.send++; calls.sentBodies.push(body); return o.send!(calls.send); },
    resume: async () => { calls.resume++; return o.resume!(); },
    getMessages: async (_id, after) => { calls.messages++; calls.messagesAfter.push(after); return o.messages!(calls.messages, after); },
    confirmApplication: async () => { calls.confirm++; return o.confirm ? o.confirm() : {}; },
    requestHandoff: async () => { calls.handoff++; return o.handoff ? o.handoff() : {}; },
  };
  return { api, calls };
}

export const apiError = (status: number, code: string) => new ApiError(status, code);
/** 不真的等待、时间按每次 sleep 推进的选项。 */
export function fastClock(intervalMs = 1000, timeoutMs = 5000) {
  let t = 0;
  return { intervalMs, timeoutMs, sleep: async (ms: number) => { t += ms; }, now: () => t };
}

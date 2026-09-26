// 一次 Agent 运行的"监督"：调用 Agent、后台消费它的事件流、续租、落库，并把事件扇出给订阅者（浏览器的 SSE 响应）。
//
// 关键设计：运行的生命周期不绑在浏览器连接上。消费 Agent 事件流的是一个独立的后台任务，
// 浏览器的 SSE 响应只是这个任务的"订阅者"——订阅者断开只是不再收事件，任务照常跑完并把结果落库。
// 这样"断线后可查询完成消息"才成立（AC-021）。
import { signInternalContext } from "../auth/internalContext.js";
import type { Db } from "../db/pool.js";
import type { AgentClient, AgentEvent } from "./agentClient.js";
import { completeRun, failRun, heartbeat } from "./runs.js";

// 契约 events.schema.json 里允许出现的事件类型；Agent 发来的其它类型一律丢弃，不转发给浏览器。
const FORWARDED_TYPES = new Set([
  "message.delta", "tool.status", "citation", "replay.card", "application.confirmation", "handoff.status", "message.completed", "run.error",
]);
const RUN_ERROR_CODES = new Set(["DEPENDENCY_UNAVAILABLE", "BUDGET_EXCEEDED", "TOOL_FAILED", "INTERNAL"]);

// 工作证有效期要覆盖一次运行：Agent 在每次工具调用时都会检查它是否过期。运行超过它会以"登录过期"话术结束，而不是崩溃。
export const RUN_CONTEXT_TTL_SECONDS = 120;

export interface SupervisorDeps {
  db: Db;
  agent: AgentClient;
  internalSecret: string;
  heartbeatIntervalMs?: number;
}

export type BeginResult =
  | { kind: "streaming"; channel: RunChannel }
  | { kind: "unavailable" } // Agent 不可达
  | { kind: "rejected"; status: number; code: string | null }; // Agent 在开流前明确拒绝

export class RunChannel {
  private readonly events: AgentEvent[] = [];
  private finished = false;
  private readonly wakeups = new Set<() => void>();

  push(event: AgentEvent) {
    this.events.push(event);
    this.wake();
  }

  finish() {
    this.finished = true;
    this.wake();
  }

  /** 从头回放已有事件，再接着收新事件，直到运行结束或订阅者的 signal 被取消（浏览器断开）。 */
  async *subscribe(signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    let i = 0;
    while (true) {
      while (i < this.events.length) yield this.events[i++]!;
      if (this.finished || signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          this.wakeups.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        this.wakeups.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  private wake() {
    for (const w of [...this.wakeups]) w();
  }
}

export async function beginRun(
  deps: SupervisorDeps,
  args: { runId: string; ownerId: string; conversationId: string; text?: string; resume?: boolean },
): Promise<BeginResult> {
  const token = signInternalContext({ actorId: args.ownerId, role: "student", requestId: args.runId }, deps.internalSecret, {
    ttlSeconds: RUN_CONTEXT_TTL_SECONDS,
  });
  const abort = new AbortController();

  let started;
  try {
    started = await deps.agent.start({ token, conversationId: args.conversationId, text: args.text, resume: args.resume, signal: abort.signal });
  } catch {
    await failRun(deps.db, args.runId, "DEPENDENCY_UNAVAILABLE");
    return { kind: "unavailable" };
  }
  if (started.kind === "rejected") {
    await failRun(deps.db, args.runId, started.code ?? "AGENT_REJECTED");
    return { kind: "rejected", status: started.status, code: started.code };
  }

  const channel = new RunChannel();
  void consume(deps, args, started.events, channel, abort).catch(() => {}); // consume 自己处理了所有错误，这里只防止未捕获的 rejection
  return { kind: "streaming", channel };
}

async function consume(
  deps: SupervisorDeps,
  args: { runId: string; conversationId: string },
  events: AsyncIterable<AgentEvent>,
  channel: RunChannel,
  abort: AbortController,
) {
  const interval = deps.heartbeatIntervalMs ?? 10_000;
  let lastBeat = Date.now();
  let count = 0;
  let terminal = false;

  // 覆盖 conversationId/runId：不信任 Agent 在这两个字段上说了什么，浏览器看到的永远是我们自己的值。
  const forward = (e: Pick<AgentEvent, "type" | "payload"> & Partial<AgentEvent>) => {
    count += 1;
    channel.push({ eventId: e.eventId ?? String(count), conversationId: args.conversationId, runId: args.runId, type: e.type, payload: e.payload });
  };
  const forwardError = (code: string, message: string) => forward({ type: "run.error", payload: { code, message } });

  try {
    for await (const event of events) {
      if (Date.now() - lastBeat >= interval) {
        lastBeat = Date.now();
        if (!(await heartbeat(deps.db, args.runId))) {
          // 租约已经过期并被别的运行接管：这个运行不再有效，停止工作，不写任何结果。
          forwardError("INTERNAL", "运行已超时，请重新发送。");
          return;
        }
      }
      if (!FORWARDED_TYPES.has(event.type)) continue;

      if (event.type === "message.completed") {
        const text = String(event.payload?.text ?? "");
        const messageId = await completeRun(deps.db, args.runId, text);
        if (messageId === null) forwardError("INTERNAL", "运行已超时，请重新发送。"); // 迟到的结果被丢弃（见 completeRun）
        else forward({ ...event, payload: { messageId, text } });
        terminal = true;
        break;
      }
      if (event.type === "run.error") {
        const raw = String(event.payload?.code ?? "");
        const code = RUN_ERROR_CODES.has(raw) ? raw : "INTERNAL";
        await failRun(deps.db, args.runId, code);
        forward({ ...event, payload: { code, message: String(event.payload?.message ?? "服务暂时出错，请稍后重试。") } });
        terminal = true;
        break;
      }
      forward(event);
    }
    if (!terminal) {
      // Agent 的流没有以完成或错误事件收尾就结束了：这个运行既不算完成也不该悬着。
      await failRun(deps.db, args.runId, "INTERNAL");
      forwardError("INTERNAL", "服务暂时出错，请稍后重试。");
    }
  } catch {
    await failRun(deps.db, args.runId, "INTERNAL").catch(() => {});
    forwardError("INTERNAL", "服务暂时出错，请稍后重试。");
  } finally {
    channel.finish();
    abort.abort(); // 释放到 Agent 的连接
  }
}

// 调用 Agent 服务（education-agent 的 POST /internal/runs）并解析它返回的 SSE 事件流。
// 把它抽成接口，是为了让路由和监督器的测试可以用假 Agent，不必起 Python 进程。

export interface AgentEvent {
  eventId: string;
  conversationId: string;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface AgentRequest {
  token: string; // BFF 签发的工作证（X-Actor-Context）
  conversationId: string;
  text?: string;
  resume?: boolean;
  signal: AbortSignal;
}

export type AgentStart =
  | { kind: "stream"; events: AsyncIterable<AgentEvent> }
  // Agent 在开流之前就拒绝了（如没有可恢复的确认 → 409）。此时还没有任何事件，调用方可以返回普通的错误响应。
  | { kind: "rejected"; status: number; code: string | null };

export interface AgentClient {
  /** 网络不可达等失败直接 throw；Agent 明确拒绝返回 rejected。 */
  start(req: AgentRequest): Promise<AgentStart>;
}

export function createHttpAgentClient(baseUrl: string): AgentClient {
  return {
    async start(req) {
      const res = await fetch(`${baseUrl}/internal/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Actor-Context": req.token },
        body: JSON.stringify(req.resume ? { conversationId: req.conversationId, resume: true } : { conversationId: req.conversationId, text: req.text }),
        signal: req.signal,
      });
      if (!res.ok || !res.body) {
        const code = await res.json().then((b) => (b?.error?.code as string | undefined) ?? null).catch(() => null);
        return { kind: "rejected", status: res.status, code };
      }
      return { kind: "stream", events: parseSse(res.body) };
    },
  };
}

/** 解析 SSE：事件之间以空行分隔；一个事件里取 data 行的 JSON。字节块的边界可以落在任何位置（含一个汉字的中间）。 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const decoder = new TextDecoder(); // stream: true 会把被切断的多字节字符留到下一块
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) yield JSON.parse(data) as AgentEvent;
    }
  }
}

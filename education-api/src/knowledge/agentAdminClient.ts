// 调用 Agent 服务的 /internal/knowledge/* 接口（T-29）：发布/撤回一个资料版本。
// 跟 chat/agentClient.ts 同一个理由抽成接口——路由测试可以用假的，不用真起 Python 进程；
// 真正的并发/状态机正确性在 Python 那边的 ingestion.db（T-26）已经测过，这里只是个薄客户端。
export type AgentAdminResult<T> = { kind: "ok"; data: T } | { kind: "error"; status: number; code: string | null };

export interface AgentKnowledgeAdminClient {
  activate(documentId: string, token: string): Promise<AgentAdminResult<void>>;
  withdraw(documentId: string, token: string): Promise<AgentAdminResult<{ withdrawn: boolean }>>;
}

async function call<T>(url: string, token: string, expectBody: boolean): Promise<AgentAdminResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "X-Actor-Context": token } });
  } catch {
    return { kind: "error", status: 503, code: "DEPENDENCY_UNAVAILABLE" };
  }
  if (!res.ok) {
    const code = await res.json().then((b) => (b?.error?.code as string | undefined) ?? null).catch(() => null);
    return { kind: "error", status: res.status, code };
  }
  return { kind: "ok", data: expectBody ? ((await res.json()) as T) : (undefined as T) };
}

export function createHttpAgentKnowledgeAdminClient(baseUrl: string): AgentKnowledgeAdminClient {
  return {
    activate: (documentId, token) => call(`${baseUrl}/internal/knowledge/documents/${documentId}/activate`, token, false),
    withdraw: (documentId, token) => call(`${baseUrl}/internal/knowledge/documents/${documentId}/withdraw`, token, true),
  };
}

// 聊天相关的真实网络实现。走 vite dev server 的 /api 代理，浏览器眼里与页面同源，session cookie 自动带上。
import { ApiError, confirmApplication, requestHandoff } from "../../education/api";
import type { StreamEvent } from "./events";
import type { ChatApi, MessagesResponse } from "./session";
import { readEvents } from "./sse";

const BASE = "/api/v1";

export interface ConversationSummary {
  id: string;
  mode: string;
  createdAt: string;
  title: string | null;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? "UNKNOWN");
  return body as T;
}

async function stream(path: string, body?: unknown): Promise<AsyncIterable<StreamEvent>> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const errBody = await res.json().catch(() => null);
    throw new ApiError(res.status, errBody?.error?.code ?? "UNKNOWN");
  }
  return readEvents(res.body);
}

export const createConversation = () => json<ConversationSummary>("/conversations", { method: "POST" });
export const listConversations = () => json<{ items: ConversationSummary[] }>("/conversations");

export const chatApi: ChatApi = {
  sendMessage: (conversationId, body) => stream(`/conversations/${conversationId}/messages`, body),
  resume: (conversationId) => stream(`/conversations/${conversationId}/resume`),
  getMessages: (conversationId) => json<MessagesResponse>(`/conversations/${conversationId}/messages`),
  confirmApplication,
  requestHandoff,
};

export const newClientMessageId = () => crypto.randomUUID();

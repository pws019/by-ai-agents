import { useCallback, useEffect, useState } from "react";

import { getOrCreateResourceId } from "../lib/anonymous-id";
import {
  AGENT_ID,
  DEFAULT_STATUS_LABEL,
  SESSION_TITLE_MAX_LENGTH,
  TOOL_STATUS_LABELS,
} from "../lib/constants";
import { mastraClient } from "../lib/mastra-client";
import { extractToolErrorMessage, normalizeMessage } from "../lib/normalize";
import type { ChatMessage, ToolCallInfo } from "../types";

function truncateTitle(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SESSION_TITLE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, SESSION_TITLE_MAX_LENGTH)}…`;
}

type UseChatOptions = {
  threadId: string | undefined;
  // threadId 为空时（"待创建"态）发第一条消息会先建 thread，
  // 建好之后用这个回调通知调用方（路由层）跳转到 /sessions/:newThreadId。
  onThreadCreated: (newThreadId: string) => void;
};

export function useChat({ threadId, onThreadCreated }: UseChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 流式响应过程中的中间状态文案（"正在查询知识库…" 之类）。
  // 非空 = 模型还没开始吐正文，要么在思考、要么在等工具调用返回；
  // 一旦第一段 text-delta 到达就清空——那之后真实的回复气泡已经在 messages 里了，
  // 不需要再显示这个占位状态。
  const [statusLabel, setStatusLabel] = useState<string | null>(null);

  // 已经懒创建出来的 thread id——用于"thread 建了但 stream 失败"这种中间态下的重试，
  // 重试时要复用这个 id，不能再调一次 createMemoryThread（否则会建出重复的空会话）。
  // 见 todo.md 第 4 节里明确提到的这个边界情况。
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);

  useEffect(() => {
    setPendingThreadId(null);
    setError(null);

    if (!threadId) {
      setMessages([]);
      return;
    }

    let cancelled = false;
    setLoadingHistory(true);
    const thread = mastraClient.getMemoryThread({ threadId, agentId: AGENT_ID });
    thread
      .listMessages({})
      .then((result) => {
        if (cancelled) return;
        const raw = (result.messages ?? []) as Record<string, unknown>[];
        setMessages(raw.map(normalizeMessage));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "历史消息加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      setSending(true);
      setError(null);
      setStatusLabel(DEFAULT_STATUS_LABEL);

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
      };
      setMessages((prev) => [...prev, userMessage]);

      const assistantMessageId = crypto.randomUUID();
      let assistantMessageStarted = false;

      // 把助手消息（正文 + toolCalls）保证存在，不存在就先插入一条空壳。
      // tool-call 和 text-delta 都可能是"这条消息的第一个信号"，谁先来谁负责建这条消息。
      function ensureAssistantMessage() {
        if (assistantMessageStarted) return;
        assistantMessageStarted = true;
        setMessages((prev) => [
          ...prev,
          { id: assistantMessageId, role: "assistant", content: "", toolCalls: [] },
        ]);
      }

      function updateToolCall(toolCallId: string, patch: Partial<ToolCallInfo>) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId
              ? {
                  ...m,
                  toolCalls: (m.toolCalls ?? []).map((tc) =>
                    tc.toolCallId === toolCallId ? { ...tc, ...patch } : tc,
                  ),
                }
              : m,
          ),
        );
      }

      try {
        const resourceId = getOrCreateResourceId();

        // 待创建态：先建 thread，但先不跳转——如果一建完就 navigate，路由切换会把当前
        // ChatPanel 整个卸载重挂载，新实例这时候去拉 listMessages() 会跟还没跑完的对话
        // 竞态，大概率拉到空历史（后端还没来得及把这轮消息存进去）。
        // 用 pendingThreadId 记住已建的 id（重试时复用，不重复创建），等真正拿到完整回复、
        // 消息已经写进本地状态之后，再统一跳转，避免这个竞态。
        let activeThreadId = threadId ?? pendingThreadId;
        const isNewThread = !activeThreadId;
        if (!activeThreadId) {
          const thread = await mastraClient.createMemoryThread({
            title: truncateTitle(trimmed),
            resourceId,
            agentId: AGENT_ID,
          });
          activeThreadId = (thread as { id?: string }).id ?? "";
          setPendingThreadId(activeThreadId);
        }

        const agent = mastraClient.getAgent(AGENT_ID);
        const response = await agent.stream(trimmed, {
          memory: { thread: activeThreadId, resource: resourceId },
        });

        await response.processDataStream({
          onChunk: async (chunk) => {
            if (chunk.type === "tool-call") {
              const { toolCallId, toolName, args } = chunk.payload ?? {};
              if (!toolCallId || !toolName) return;

              ensureAssistantMessage();
              setStatusLabel(TOOL_STATUS_LABELS[toolName] || DEFAULT_STATUS_LABEL);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMessageId
                    ? {
                        ...m,
                        toolCalls: [
                          ...(m.toolCalls ?? []),
                          { toolCallId, toolName, args, status: "running" as const },
                        ],
                      }
                    : m,
                ),
              );
              return;
            }

            if (chunk.type === "tool-result") {
              const { toolCallId, result } = chunk.payload ?? {};
              if (!toolCallId) return;
              updateToolCall(toolCallId, { status: "done", result });
              return;
            }

            if (chunk.type === "tool-error") {
              const { toolCallId, error } = chunk.payload ?? {};
              if (!toolCallId) return;
              updateToolCall(toolCallId, {
                status: "error",
                result: extractToolErrorMessage(error),
              });
              return;
            }

            if (chunk.type === "text-delta") {
              const delta = chunk.payload?.text ?? "";
              if (!delta) return;

              // 第一段正文到达：工具调用（如果有）已经结束，中间状态可以收起了，
              // 真实的回复气泡从这里开始接管展示（工具调用卡片还在，只是不再是唯一内容）。
              ensureAssistantMessage();
              setStatusLabel(null);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMessageId ? { ...m, content: m.content + delta } : m,
                ),
              );
            }
          },
        });

        // 保底：如果整段回复只有工具调用、没有任何 text-delta（理论上不该发生，
        // 但网络/后端异常时不排除），至少留一条空的助手消息占位，不要让用户以为没回复。
        ensureAssistantMessage();

        // 消息已经完整落进本地状态，这时候再跳转，新挂载的 ChatPanel 拉历史时后端
        // 已经存好了，不会拉到空列表。
        if (isNewThread) onThreadCreated(activeThreadId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "发送失败，请重试");
      } finally {
        setSending(false);
        setStatusLabel(null);
      }
    },
    [threadId, pendingThreadId, sending, onThreadCreated],
  );

  return { messages, loadingHistory, sending, statusLabel, error, sendMessage };
}

import { useCallback, useEffect, useState } from "react";

import { getOrCreateResourceId } from "../lib/anonymous-id";
import { AGENT_ID } from "../lib/constants";
import { mastraClient } from "../lib/mastra-client";
import { normalizeThread } from "../lib/normalize";
import type { SessionSummary } from "../types";

// 会话（Memory Thread）的增删改查。
//
// 注意：这里不包含"创建"——创建是懒创建，发生在用户发第一条消息的那一刻
// （见 useChat 里的 sendMessage），不是通过这个 hook 主动触发的，
// 所以这里没有 createSession，只有 refresh / rename / remove。
export function useSessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resourceId = getOrCreateResourceId();
      const response = await mastraClient.listMemoryThreads({ resourceId, agentId: AGENT_ID });
      // 返回的是 { threads, total, page, perPage, hasMore }，不是裸数组。
      const list = (response.threads ?? []) as Record<string, unknown>[];
      const normalized = list
        .map(normalizeThread)
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      setSessions(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : "会话列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const renameSession = useCallback(
    async (threadId: string, title: string) => {
      // update() 的 title/metadata/resourceId 都是必填，这里没有用到 metadata，
      // 传空对象即可（这个项目目前没有往 thread 上写过 metadata，不存在覆盖丢失的问题）。
      const thread = mastraClient.getMemoryThread({ threadId, agentId: AGENT_ID });
      await thread.update({ title, metadata: {}, resourceId: getOrCreateResourceId() });
      setSessions((prev) => prev.map((s) => (s.id === threadId ? { ...s, title } : s)));
    },
    [],
  );

  const deleteSession = useCallback(async (threadId: string) => {
    const thread = mastraClient.getMemoryThread({ threadId, agentId: AGENT_ID });
    await thread.delete();
    setSessions((prev) => prev.filter((s) => s.id !== threadId));
  }, []);

  return { sessions, loading, error, refresh, renameSession, deleteSession };
}

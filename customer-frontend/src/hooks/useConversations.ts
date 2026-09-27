import { useCallback, useEffect, useState } from "react";

import { listConversations, type ConversationSummary } from "../lib/chat/api";

// 会话列表（education-api 的 GET /conversations）。创建是懒创建：发第一条消息时才建，
// 所以这里没有 create，只有 refresh。首版不提供重命名/删除（契约里没有这两个操作）。
export function useConversations() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setConversations((await listConversations()).items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "会话列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { conversations, loading, error, refresh };
}

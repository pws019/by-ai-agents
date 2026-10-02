import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../education/api";
import { deleteConversation, listConversations, type ConversationSummary } from "../lib/chat/api";

// 会话列表（education-api 的 GET /conversations）。创建是懒创建：发第一条消息时才建，
// 所以这里没有 create，只有 refresh。首版不提供重命名，删除见 remove（硬删除，物理从库里去掉）。
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

  /**
   * 删掉一个会话。本地列表先按乐观更新移除——删除这个动作本身不可逆，犹豫的空间应该在调用方
   * 弹确认框那一步用完，不是删完了还得等一轮网络请求才让它从列表上消失。
   * 409（正在生成中）会把它加回来并报错，调用方可借此提示"请稍后再删"；其它错误原样抛出。
   */
  const remove = useCallback(async (id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    try {
      await deleteConversation(id);
    } catch (err) {
      await refresh();
      if (err instanceof ApiError && err.code === "RUN_IN_PROGRESS") throw new Error("会话正在处理中，请稍后再删除");
      throw err;
    }
  }, [refresh]);

  return { conversations, loading, error, refresh, remove };
}

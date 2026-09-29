import { useCallback, useEffect, useRef, useState } from "react";

import { chatApi, createConversation, newClientMessageId } from "../lib/chat/api";
import { confirmDraft, openConversation, requestHandoff as requestHandoffFlow, sendTurn } from "../lib/chat/session";
import { emptyChat, withNotice, type ChatState } from "../lib/chat/state";

type UseChatOptions = {
  conversationId: string | undefined;
  // conversationId 为空（"待创建"态）时发第一条消息会先建会话；建好、这一轮也完整结束之后，用这个回调通知路由层跳转。
  onCreated: (conversationId: string) => void;
};

// 聊天页面的 hook：只负责把"流程层（lib/chat/session）产生的状态"接进 React，自己没有业务逻辑。
// 所有流程都是异步生成器；这里用一个递增的 token 判断"这个流程还是不是当前的"——
// 切换会话/离开页面后，旧流程后续产生的状态会被直接丢弃，不会写进新会话的界面。
export function useChat({ conversationId, onCreated }: UseChatOptions) {
  const [state, setState] = useState<ChatState>(emptyChat());
  const [loadingHistory, setLoadingHistory] = useState(false);
  // 已经建好、但这一轮还没结束所以还没跳转的会话（重试/确认时要复用，不能再建一个）。
  const [pendingId, setPendingId] = useState<string | null>(null);

  const stateRef = useRef(state);
  const flow = useRef(0);

  const update = useCallback((s: ChatState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  useEffect(() => {
    const token = ++flow.current;
    setPendingId(null);
    if (!conversationId) {
      update(emptyChat());
      setLoadingHistory(false);
      return;
    }
    setLoadingHistory(true);
    void (async () => {
      try {
        for await (const s of openConversation(chatApi, conversationId)) {
          if (flow.current !== token) return;
          update(s);
          setLoadingHistory(false);
        }
      } catch {
        if (flow.current === token) update({ ...emptyChat(), notice: "会话加载失败，请刷新页面重试。" });
      } finally {
        if (flow.current === token) setLoadingHistory(false);
      }
    })();
    return () => {
      flow.current++;
    };
  }, [conversationId, update]);

  const drive = useCallback(
    async (gen: AsyncGenerator<ChatState>, token: number) => {
      for await (const s of gen) {
        if (flow.current !== token) return false;
        update(s);
      }
      return flow.current === token;
    },
    [update],
  );

  const busy = state.phase !== "idle";

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || stateRef.current.phase !== "idle") return;
      const token = ++flow.current;
      let id = conversationId ?? pendingId;
      const isNew = !id;
      try {
        if (!id) {
          id = (await createConversation()).id;
          setPendingId(id);
        }
        const finished = await drive(sendTurn(chatApi, id, stateRef.current, trimmed, newClientMessageId()), token);
        if (isNew && finished) onCreated(id);
      } catch {
        if (flow.current === token) update({ ...withNotice(stateRef.current, "发送失败，请检查网络后重试。"), phase: "idle" });
      }
    },
    [conversationId, pendingId, drive, onCreated, update],
  );

  /** 上一次失败了：把那一对（用户消息 + 失败的助手消息）从界面上拿掉，用新的 clientMessageId 重新发同样的文字。 */
  const retryLast = useCallback(async () => {
    const msgs = stateRef.current.messages;
    const failed = msgs.at(-1);
    const userMsg = msgs.at(-2);
    if (!failed || failed.state !== "error" || !userMsg || userMsg.role !== "user") return;
    update({ ...stateRef.current, messages: msgs.slice(0, -2) });
    await sendMessage(userMsg.content);
  }, [sendMessage, update]);

  const confirm = useCallback(async () => {
    const id = conversationId ?? pendingId;
    if (!id || !stateRef.current.pendingConfirmation || stateRef.current.phase !== "idle") return;
    const token = ++flow.current;
    try {
      await drive(confirmDraft(chatApi, id, stateRef.current), token);
    } catch {
      if (flow.current === token) update({ ...withNotice(stateRef.current, "确认没有成功，请检查网络后重试。"), phase: "idle" });
    }
  }, [conversationId, pendingId, drive, update]);

  // 转人工：用户本人对业务 API 的操作（同 confirm），没有会话（还没发过第一条消息）时什么都做不了。
  const requestHandoff = useCallback(async () => {
    const id = conversationId ?? pendingId;
    if (!id || stateRef.current.phase !== "idle" || stateRef.current.mode !== "bot") return;
    const token = ++flow.current;
    try {
      await drive(requestHandoffFlow(chatApi, id, stateRef.current), token);
    } catch {
      if (flow.current === token) update({ ...withNotice(stateRef.current, "请求转人工失败，请检查网络后重试。"), phase: "idle" });
    }
  }, [conversationId, pendingId, drive, update]);

  return { state, loadingHistory, busy, sendMessage, retryLast, confirm, requestHandoff };
}

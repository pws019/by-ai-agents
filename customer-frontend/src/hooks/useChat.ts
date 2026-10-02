import { useCallback, useEffect, useRef, useState } from "react";

import { chatApi, createConversation, newClientMessageId } from "../lib/chat/api";
import { confirmDraft, openConversation, requestHandoff as requestHandoffFlow, sendTurn } from "../lib/chat/session";
import { appendServer, emptyChat, fromServer, withNotice, type ChatState } from "../lib/chat/state";

const HANDOFF_POLL_MS = 4000;

type UseChatOptions = {
  conversationId: string | undefined;
  // "待创建"态的第一轮跑完之后，路由层会把 URL 从 "/" 换成 "/sessions/:id"——但 "/" 和
  // "/sessions/:id" 是路由树里两个不同的 Route（IndexRoute/SessionRoute），切换会让 ChatPanel
  // 连同这个 hook 整个重新挂载，不是同一个实例收到新 prop。本地刚流完的状态（尤其是 citation/
  // replay.card：这两类事件不落库，见 lib/chat/state.ts）如果不想办法带过去，新挂载出来的实例
  // 只能从服务端重新拉，拉到的东西天然没有这两类字段。seedState 就是用来带过去的：调用方
  // （ChatPanel）通过 react-router 的 navigate(path, { state }) 把这一轮跑完的 state 原样带到
  // 新 URL，新挂载的 hook 用它做初始状态，不用再向服务端请求一次。
  seedState?: ChatState;
  // conversationId 为空（"待创建"态）时发第一条消息会先建会话；建好、这一轮也完整结束之后，用这个回调通知路由层跳转。
  onCreated: (conversationId: string, finalState: ChatState) => void;
};

// 聊天页面的 hook：只负责把"流程层（lib/chat/session）产生的状态"接进 React，自己没有业务逻辑。
// 所有流程都是异步生成器；这里用一个递增的 token 判断"这个流程还是不是当前的"——
// 切换会话/离开页面后，旧流程后续产生的状态会被直接丢弃，不会写进新会话的界面。
export function useChat({ conversationId, seedState, onCreated }: UseChatOptions) {
  const [state, setState] = useState<ChatState>(() => seedState ?? emptyChat());
  const [loadingHistory, setLoadingHistory] = useState(false);
  // 已经建好、但这一轮还没结束所以还没跳转的会话（重试/确认时要复用，不能再建一个）。
  const [pendingId, setPendingId] = useState<string | null>(null);

  const stateRef = useRef(state);
  const flow = useRef(0);
  // 轮询的增量游标：只在"本地消息列表确定和服务端一致"时才可信，见下面 update() 和轮询 effect 的说明。
  const lastPolledId = useRef<string | null>(null);
  // 记"seedState 对应哪个会话"，而不是"有没有 seedState 这件事本身"——后者如果用一个"读一次就清掉"
  // 的标记来做，会在 StrictMode（开发环境会把 effect 的 setup 多调用一次来测试副作用是否幂等）下出问题：
  // 第一次调用把标记清掉、跳过拉取，第二次（StrictMode 的重放）发现标记已经没了，就会照常去拉一次，
  // 照样把 citation 冲掉——现象跟完全没修一样。这里只在挂载时读一次 conversationId 存下来，effect 里
  // 只读不写，调用多少次结果都一样。
  const seededConversationId = useRef(seedState != null ? conversationId : null);

  const update = useCallback((s: ChatState, opts?: { fromPoll?: boolean }) => {
    stateRef.current = s;
    setState(s);
    // 除了轮询自己写回的结果，任何其它来源的更新（发消息、确认、转人工……）都可能往消息列表里加了一条
    // 还没换成服务端真实 id 的乐观消息（比如排队/接管期间学员自己发的话，只会被记录，不会有事件把它的
    // id 纠正过来）。这种情况下游标不再可信：清空它，让下一次轮询退化成全量快照而不是继续增量追加，
    // 否则那条乐观消息和服务端返回的同一条真实记录会重复出现。
    if (!opts?.fromPoll) lastPolledId.current = null;
  }, []);

  useEffect(() => {
    const token = ++flow.current;
    setPendingId(null);
    if (!conversationId) {
      update(emptyChat());
      setLoadingHistory(false);
      return;
    }
    if (conversationId === seededConversationId.current) {
      // 初始状态已经是 seedState（上一个路由实例跑完一轮之后交过来的），不用再问服务端一次——
      // 问了也只会把 citation/replay.card 冲掉，其它字段服务端那份也不会比本地这份更新。
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

  // 排队/接管期间（mode 不是 bot）：SSE 只在"这次发送/这次运行"期间存在，运行一结束连接就关了。
  // 老师异步回复、学员在别处发的话，都不会通过当前这条（早已关闭的）连接推给这边——轮询是这套
  // "围绕一次运行设计"的架构下最小的修补，不是真正的推送。mode 回到 bot 就停（下一次 render 发现
  // 条件不满足，不会再开定时器）。
  //
  // 第一次轮询（游标为空）总是拉全量快照，把本地状态和服务端彻底对齐一次；之后只要没有别的本地更新
  // 插进来（update() 里会清空游标），就用 after 只拉增量、接到已有列表后面——避免接管期间每隔几秒就把
  // 整个历史重新传一遍（见 progress.md 关于轮询开销的讨论）。
  useEffect(() => {
    if (!conversationId || state.mode === "bot") return;
    lastPolledId.current = null;
    const timer = setInterval(() => {
      if (stateRef.current.phase !== "idle") return; // 有别的操作正在进行（发送/确认/转人工），这一轮跳过
      const after = lastPolledId.current ?? undefined;
      void chatApi
        .getMessages(conversationId, after)
        .then((res) => {
          if (stateRef.current.phase !== "idle") return; // 拿到结果时状态可能已经变了，别覆盖正在发生的事
          const lastItem = res.items.at(-1);
          if (lastItem) lastPolledId.current = lastItem.id;
          const next = after
            ? appendServer(stateRef.current, res.items, res.pendingConfirmation, res.mode)
            : fromServer(res.items, res.pendingConfirmation, res.mode, { notice: stateRef.current.notice });
          update(next, { fromPoll: true });
        })
        .catch(() => {}); // 偶尔一次失败不打扰用户，下一次自然会再试（游标没推进，下次还是从同一个位置增量拉）
    }, HANDOFF_POLL_MS);
    return () => clearInterval(timer);
  }, [conversationId, state.mode, update]);

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
        // 把这一轮跑完的最终状态一起带给调用方：新 URL 挂载出来的那个实例要拿它当 seedState，
        // 不是只告诉调用方"建好了，id 是什么"。
        if (isNew && finished) onCreated(id, stateRef.current);
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

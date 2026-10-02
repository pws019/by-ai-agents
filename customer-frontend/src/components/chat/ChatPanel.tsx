import { useState } from "react";
import { useNavigate } from "react-router";

import { useSessionsContext } from "../../context/SessionsContext";
import { useChat } from "../../hooks/useChat";
import type { ChatState } from "../../lib/chat/state";
import { runningToolLabel } from "../../lib/chat/toolLabels";
import { ChatHeader } from "./ChatHeader";
import { ChatInput } from "./ChatInput";
import { ConfirmationCard } from "./ConfirmationCard";
import { MessageList } from "./MessageList";
import { WelcomeState } from "./WelcomeState";

type ChatPanelProps = {
  conversationId?: string;
  // "/" 和 "/sessions/:id" 是路由树里两个不同的 Route，这个组件在两者之间切换时会整个重新挂载——
  // 新会话第一轮跑完后跳转过来的这个实例，要从这里（路由 state 转交过来，见 SessionRoute）拿到
  // 上一个实例跑完的状态当初始值，而不是从空白状态开始向服务端重新拉一次（会把 citation/
  // replay.card 这类不落库的字段冲掉，见 useChat.ts 的 seedState 说明）。
  seedState?: ChatState;
};

export function ChatPanel({ conversationId, seedState }: ChatPanelProps) {
  const navigate = useNavigate();
  const { conversations, refresh: refreshSessions } = useSessionsContext();
  const [prefill, setPrefill] = useState<string | undefined>(undefined);
  // 用户点了"暂不提交"：只是本地把这张卡收起来。草稿仍在业务库里，刷新页面会再出现（不丢）。
  const [dismissedCard, setDismissedCard] = useState<string | null>(null);

  const { state, loadingHistory, busy, sendMessage, retryLast, confirm, requestHandoff } = useChat({
    conversationId,
    seedState,
    onCreated: (newId, finalState) => {
      // 新会话这一轮已经完整结束（消息也在本地状态里了），先让侧边栏刷新，再跳转——
      // 太早跳转会让面板重新挂载去拉历史，与还没跑完的这一轮竞态。
      // 把 finalState 通过路由 state 带过去：新挂载出来的那个实例靠它做种子状态，见上面 seedState 的注释。
      void refreshSessions();
      navigate(`/sessions/${newId}`, { state: { seedState: finalState } });
    },
  });

  const title = conversationId ? (conversations.find((c) => c.id === conversationId)?.title ?? "对话") : "新对话";
  const isEmptyDraft = !conversationId && state.messages.length === 0;

  // 最后一条助手消息还没有文字、正在生成：给出"正在……"的提示（有工具在跑则说明是哪个）；断线重连时显示重连提示。
  // mode 不是 bot（排队中/接管中）时不会有机器人回复：不显示这个提示，否则会闪一下又消失（那条占位气泡会被 handoff.status 清掉）。
  const last = state.messages.at(-1);
  const generating = state.phase === "streaming" && state.mode === "bot" && last?.role === "assistant" && last.state === "streaming";
  const statusLabel =
    state.phase === "reconnecting"
      ? "正在确认处理结果…"
      : generating && !last.content
        ? (runningToolLabel(last.tools) ?? "正在思考…")
        : null;

  const card = state.pendingConfirmation && state.pendingConfirmation.confirmationId !== dismissedCard ? state.pendingConfirmation : null;

  return (
    <div className="h-full flex flex-col bg-surface">
      <ChatHeader title={title} mode={isEmptyDraft ? undefined : state.mode} busy={busy} onRequestHandoff={() => void requestHandoff()} />

      {isEmptyDraft ? (
        <div className="flex-1 overflow-y-auto flex flex-col">
          <WelcomeState onPick={(text) => setPrefill(text)} />
        </div>
      ) : loadingHistory ? (
        <div className="flex-1 flex items-center justify-center text-body-sm text-outline">加载历史消息…</div>
      ) : (
        <MessageList
          messages={state.messages}
          statusLabel={statusLabel}
          onRetry={() => void retryLast()}
          footer={
            card && (
              <ConfirmationCard
                card={card}
                busy={busy}
                onConfirm={() => void confirm()}
                onDismiss={() => setDismissedCard(card.confirmationId)}
              />
            )
          }
        />
      )}

      {state.notice && (
        <p role="status" className="text-center text-body-sm text-secondary px-4 pb-2">
          {state.notice}
        </p>
      )}

      {/* key 随 prefill 变化：点击欢迎页的示例时强制重新挂载输入框，让它拿到新的初始文本（输入框内部是非受控的）。 */}
      <ChatInput key={prefill ?? "empty"} disabled={busy} onSend={(t) => void sendMessage(t)} value={prefill} />
    </div>
  );
}

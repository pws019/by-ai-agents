import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { useSessionsContext } from "../../context/SessionsContext";
import { useChat } from "../../hooks/useChat";
import { AGENT_ID } from "../../lib/constants";
import { mastraClient } from "../../lib/mastra-client";
import { ChatHeader } from "./ChatHeader";
import { ChatInput } from "./ChatInput";
import { MessageList } from "./MessageList";
import { WelcomeState } from "./WelcomeState";

type ChatPanelProps = {
  threadId?: string;
};

export function ChatPanel({ threadId }: ChatPanelProps) {
  const navigate = useNavigate();
  const { refresh: refreshSessions } = useSessionsContext();
  const [title, setTitle] = useState<string>("新对话");
  const [prefill, setPrefill] = useState<string | undefined>(undefined);

  const { messages, loadingHistory, sending, statusLabel, error, sendMessage } = useChat({
    threadId,
    onThreadCreated: (newThreadId) => {
      // 新会话已经完整写好（消息也落进本地状态了，见 useChat 里的时机说明），
      // 通知侧边栏刷新列表，再跳转——不然侧边栏要等下次整页刷新才会看到这条新会话。
      void refreshSessions();
      navigate(`/sessions/${newThreadId}`);
    },
  });

  // 已有会话时，标题以 thread 自己的 title 为准（跟侧边栏、重命名操作保持一致）；
  // "待创建"态没有 thread，标题固定显示"新对话"。
  useEffect(() => {
    if (!threadId) {
      setTitle("新对话");
      return;
    }
    let cancelled = false;
    mastraClient
      .getMemoryThread({ threadId, agentId: AGENT_ID })
      .get()
      .then((thread) => {
        if (!cancelled) setTitle((thread as { title?: string }).title || "未命名会话");
      })
      .catch(() => {
        if (!cancelled) setTitle("对话");
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const isEmptyDraft = !threadId && messages.length === 0;

  return (
    <div className="h-full flex flex-col bg-surface">
      <ChatHeader title={title} />

      {isEmptyDraft ? (
        <div className="flex-1 overflow-y-auto flex flex-col">
          <WelcomeState onPick={(text) => setPrefill(text)} />
        </div>
      ) : (
        <>
          {loadingHistory ? (
            <div className="flex-1 flex items-center justify-center text-body-sm text-outline">
              加载历史消息…
            </div>
          ) : (
            <MessageList messages={messages} statusLabel={statusLabel} />
          )}
        </>
      )}

      {error && <p className="text-center text-body-sm text-error px-4 pb-2">{error}</p>}

      {/* key 随 prefill 变化：点击欢迎页的示例问题时强制重新挂载输入框，
          让它拿到新的初始文本（ChatInput 内部是非受控的，value 只作为初始值）。 */}
      <ChatInput key={prefill ?? "empty"} disabled={sending} onSend={sendMessage} value={prefill} />
    </div>
  );
}

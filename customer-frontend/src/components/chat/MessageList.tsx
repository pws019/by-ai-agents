import { useEffect, useRef, type ReactNode } from "react";

import type { ChatMessage } from "../../lib/chat/state";
import { MessageBubble } from "./MessageBubble";
import { TypingIndicator } from "./TypingIndicator";

type MessageListProps = {
  messages: ChatMessage[];
  /** 非空时在末尾显示"正在……"的提示气泡（工具调用中、等待第一段文字、断线重连中）。 */
  statusLabel: string | null;
  onRetry: () => void;
  /** 列表末尾的额外内容（确认卡等）。 */
  footer?: ReactNode;
};

export function MessageList({ messages, statusLabel, onRetry, footer }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, statusLabel, footer]);

  const last = messages.length - 1;
  return (
    <section className="flex-1 overflow-y-auto custom-scrollbar py-8 px-4 sm:px-8" aria-live="polite">
      <div className="max-w-container-max-width mx-auto flex flex-col gap-stack-gap">
        {messages.map((message, i) => (
          <MessageBubble
            key={message.id}
            message={message}
            onRetry={i === last && message.state === "error" ? onRetry : undefined}
          />
        ))}
        {statusLabel && <TypingIndicator label={statusLabel} />}
        {footer}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

import { useEffect, useRef } from "react";

import type { ChatMessage } from "../../types";
import { MessageBubble } from "./MessageBubble";
import { TypingIndicator } from "./TypingIndicator";

type MessageListProps = {
  messages: ChatMessage[];
  // 非空时在消息列表末尾展示中间状态气泡（"正在查询知识库…" 之类）；
  // 一旦模型开始吐正文，调用方会把这个置空，改由消息列表里真实的那条气泡接管。
  statusLabel: string | null;
};

export function MessageList({ messages, statusLabel }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, statusLabel]);

  return (
    <section className="flex-1 overflow-y-auto custom-scrollbar py-8 px-4 sm:px-8">
      <div className="max-w-container-max-width mx-auto flex flex-col gap-stack-gap">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {statusLabel && <TypingIndicator label={statusLabel} />}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

import type { ChatMessage } from "../../types";
import { Icon } from "../ui/Icon";
import { ToolCallCard } from "./ToolCallCard";

export function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end w-full">
        <div className="max-w-[80%] bg-primary text-on-primary p-4 rounded-t-xl rounded-bl-xl shadow-sm whitespace-pre-wrap break-words">
          <p className="text-body-md">{message.content}</p>
        </div>
      </div>
    );
  }

  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;

  return (
    <div className="flex justify-start w-full">
      <div className="flex gap-4 max-w-[85%]">
        <div className="w-8 h-8 rounded-full bg-surface-container-highest flex items-center justify-center shrink-0">
          <Icon name="smart_toy" filled className="text-[18px] text-primary" />
        </div>
        <div className="flex flex-col gap-2 min-w-0">
          {/* 工具调用卡片放在正文上方，持久展示——不是发送过程中才有的临时提示，
              历史消息重新打开也能看到当时调用了什么、传了什么参数、拿到了什么结果。 */}
          {hasToolCalls &&
            message.toolCalls!.map((toolCall) => (
              <ToolCallCard key={toolCall.toolCallId} toolCall={toolCall} />
            ))}
          {message.content && (
            <div className="bg-surface-container-low text-on-surface p-4 rounded-t-xl rounded-br-xl border border-surface-container whitespace-pre-wrap break-words">
              <p className="text-body-md leading-relaxed">{message.content}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

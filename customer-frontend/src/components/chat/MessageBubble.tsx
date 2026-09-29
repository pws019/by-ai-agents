import type { ChatMessage } from "../../lib/chat/state";
import { Icon } from "../ui/Icon";
import { ToolStatusChip } from "./ToolStatusChip";

type MessageBubbleProps = {
  message: ChatMessage;
  /** 仅最后一条失败的助手消息才有：点击重发上一句。 */
  onRetry?: () => void;
};

export function MessageBubble({ message, onRetry }: MessageBubbleProps) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end w-full">
        <div className="max-w-[80%] bg-primary text-on-primary p-4 rounded-t-xl rounded-bl-xl shadow-sm whitespace-pre-wrap break-words">
          <p className="text-body-md">{message.content}</p>
        </div>
      </div>
    );
  }

  const failed = message.state === "error";
  // 接管期间老师发的消息和机器人的回复长得不一样：学员必须分得清此刻是谁在说话（AC-012 的意义所在）。
  const isTeacher = message.role === "teacher";
  return (
    <div className="flex justify-start w-full">
      <div className="flex gap-4 max-w-[85%]">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${isTeacher ? "bg-secondary-container" : "bg-surface-container-highest"}`}>
          <Icon name={isTeacher ? "support_agent" : "smart_toy"} filled className={`text-[18px] ${isTeacher ? "text-on-secondary-container" : "text-primary"}`} />
        </div>
        <div className="flex flex-col gap-2 min-w-0">
          {isTeacher && <span className="text-label-sm text-on-secondary-container">老师</span>}
          {message.tools.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {message.tools.map((tool, i) => (
                <ToolStatusChip key={i} tool={tool} />
              ))}
            </div>
          )}
          {message.content && (
            <div
              className={`p-4 rounded-t-xl rounded-br-xl border whitespace-pre-wrap break-words ${
                isTeacher ? "bg-secondary-container/20 border-secondary-container text-on-surface" : "bg-surface-container-low border-surface-container text-on-surface"
              }`}
            >
              <p className="text-body-md leading-relaxed">{message.content}</p>
            </div>
          )}
          {failed && (
            <div className="flex items-center gap-3 text-body-sm text-error">
              <span>{message.error ?? "这次没有处理成功。"}</span>
              {onRetry && (
                <button type="button" onClick={onRetry} className="underline text-primary">
                  重试
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

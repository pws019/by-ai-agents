import type { ConversationMode } from "../../lib/chat/events";
import { Icon } from "../ui/Icon";

type ChatHeaderProps = {
  title: string;
  /** undefined：还没有会话（第一条消息还没发出），转人工无从谈起，不显示按钮。 */
  mode?: ConversationMode;
  busy?: boolean;
  onRequestHandoff?: () => void;
};

const MODE_BADGE: Partial<Record<ConversationMode, { label: string; className: string }>> = {
  queued: { label: "排队中，等待老师接管", className: "bg-secondary-container text-on-secondary-container" },
  human: { label: "老师处理中", className: "bg-primary-container text-on-primary-container" },
};

export function ChatHeader({ title, mode, busy, onRequestHandoff }: ChatHeaderProps) {
  const badge = mode ? MODE_BADGE[mode] : undefined;

  return (
    <header className="flex justify-between items-center h-16 px-gutter border-b border-outline-variant bg-surface shrink-0 gap-3">
      <h2 className="text-headline-sm font-semibold text-on-surface truncate">{title}</h2>
      <div className="flex items-center gap-2 shrink-0">
        {badge && <span className={`text-label-sm rounded-full px-3 py-1 ${badge.className}`}>{badge.label}</span>}
        {mode === "bot" && onRequestHandoff && (
          <button
            type="button"
            disabled={busy}
            onClick={onRequestHandoff}
            className="flex items-center gap-1.5 text-label-sm text-secondary border border-outline-variant rounded-full px-3 py-1.5 hover:bg-surface-container disabled:opacity-50 disabled:cursor-not-allowed"
            title="请老师接手这个会话"
          >
            <Icon name="support_agent" className="text-[18px]" />
            转人工
          </button>
        )}
      </div>
    </header>
  );
}

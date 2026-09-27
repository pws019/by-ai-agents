import { Link } from "react-router";

import type { ConversationSummary } from "../../lib/chat/api";
import { formatRelativeTime } from "../../lib/format";

type SessionListItemProps = {
  conversation: ConversationSummary;
  active: boolean;
};

// 首版没有重命名/删除（契约里没有这两个操作），所以列表项只是一个链接。
export function SessionListItem({ conversation, active }: SessionListItemProps) {
  return (
    <Link
      to={`/sessions/${conversation.id}`}
      className={`flex items-center rounded-r-lg p-3 mt-1 transition-colors ${
        active ? "bg-surface-container-high text-primary border-l-2 border-primary" : "text-secondary hover:bg-surface-container-low"
      }`}
    >
      <div className="flex-1 overflow-hidden">
        <p className="text-label-md truncate">{conversation.title ?? "新会话"}</p>
        <p className="text-label-sm text-outline">{formatRelativeTime(conversation.createdAt)}</p>
      </div>
    </Link>
  );
}

import { useState } from "react";
import { Link } from "react-router";

import type { ConversationSummary } from "../../lib/chat/api";
import { formatRelativeTime } from "../../lib/format";
import { Icon } from "../ui/Icon";

type SessionListItemProps = {
  conversation: ConversationSummary;
  active: boolean;
  onDelete: (id: string) => Promise<void>;
  onNavigate?: () => void;
};

// 删除是不可逆操作：点垃圾桶先切换成"确定删除？"的二次确认态，不是点一下就真删了——
// 这里没有引入弹窗/对话框这套基础设施，就地在列表项内切换态，跟项目里别处（比如 ReplayCard 的
// 展开/收起）同一个"轻量级、不额外加依赖"的风格。
export function SessionListItem({ conversation, active, onDelete, onNavigate }: SessionListItemProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onDelete(conversation.id);
    } catch (err) {
      setDeleting(false);
      setConfirming(false);
      setError(err instanceof Error ? err.message : "删除失败，请重试");
    }
  };

  if (confirming) {
    return (
      <div className="flex items-center gap-2 rounded-r-lg p-3 mt-1 bg-surface-container-low">
        <p className="flex-1 text-label-sm text-on-surface-variant">删除这个会话？不能恢复</p>
        <button
          type="button"
          disabled={deleting}
          onClick={() => void confirm()}
          className="text-label-sm text-error underline disabled:opacity-50"
        >
          删除
        </button>
        <button type="button" disabled={deleting} onClick={() => setConfirming(false)} className="text-label-sm text-secondary underline disabled:opacity-50">
          取消
        </button>
      </div>
    );
  }

  return (
    <div className="group relative">
      <Link
        to={`/sessions/${conversation.id}`}
        onClick={onNavigate}
        className={`flex items-center rounded-r-lg p-3 mt-1 transition-colors ${
          active ? "bg-surface-container-high text-primary border-l-2 border-primary" : "text-secondary hover:bg-surface-container-low"
        }`}
      >
        <div className="flex-1 overflow-hidden pr-6">
          <p className="text-label-md truncate">{conversation.title ?? "新会话"}</p>
          <p className="text-label-sm text-outline">{formatRelativeTime(conversation.createdAt)}</p>
          {error && <p className="text-label-sm text-error mt-1">{error}</p>}
        </div>
      </Link>
      <button
        type="button"
        aria-label="删除这个会话"
        onClick={(e) => {
          e.preventDefault(); // 这个按钮叠在 <Link> 上面，不能让点击顺带触发导航
          setConfirming(true);
        }}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-outline hover:text-error hover:bg-surface-container-high transition-opacity"
      >
        <Icon name="delete" className="text-[18px]" />
      </button>
    </div>
  );
}

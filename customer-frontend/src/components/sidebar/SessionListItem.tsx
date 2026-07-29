import { useState } from "react";
import { Link } from "react-router";

import { formatRelativeTime } from "../../lib/format";
import type { SessionSummary } from "../../types";
import { Icon } from "../ui/Icon";

type SessionListItemProps = {
  session: SessionSummary;
  active: boolean;
  onRename: (threadId: string, title: string) => void;
  onDelete: (threadId: string) => void;
};

export function SessionListItem({ session, active, onRename, onDelete }: SessionListItemProps) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);

  function commitRename() {
    const trimmed = draftTitle.trim();
    if (trimmed && trimmed !== session.title) {
      onRename(session.id, trimmed);
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="rounded-r-lg p-3 bg-surface-container-high">
        <input
          autoFocus
          className="w-full bg-transparent border-b border-primary text-label-md text-on-surface outline-none"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <Link
      to={`/sessions/${session.id}`}
      className={`group flex items-center rounded-r-lg p-3 mt-1 transition-colors ${
        active
          ? "bg-surface-container-high text-primary border-l-2 border-primary"
          : "text-secondary hover:bg-surface-container-low"
      }`}
    >
      <div className="flex-1 overflow-hidden">
        <p className="text-label-md truncate">{session.title}</p>
        <p className="text-label-sm text-outline">{formatRelativeTime(session.updatedAt)}</p>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          title="重命名"
          className="p-1 text-secondary hover:text-primary"
          onClick={(e) => {
            e.preventDefault();
            setDraftTitle(session.title);
            setEditing(true);
          }}
        >
          <Icon name="edit" className="text-[16px]" />
        </button>
        <button
          type="button"
          title="删除会话"
          className="p-1 text-secondary hover:text-error"
          onClick={(e) => {
            e.preventDefault();
            onDelete(session.id);
          }}
        >
          <Icon name="delete" className="text-[16px]" />
        </button>
      </div>
    </Link>
  );
}

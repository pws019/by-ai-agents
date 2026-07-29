import { Link, useNavigate, useParams } from "react-router";

import { useSessionsContext } from "../../context/SessionsContext";
import { Icon } from "../ui/Icon";
import { SessionListItem } from "./SessionListItem";

// 左侧栏宽度由外层 AppLayout 的固定列宽控制（见 PRD「左侧栏宽度是布局常量」），
// 这个组件本身只负责往这个固定宽度的容器里填内容，不关心自己有多宽。
//
// 会话列表状态从 SessionsContext 读（不是自己调 useSessions()），跟右侧 ChatPanel
// 共用同一份状态，右侧新建会话后调 refresh() 这边能立刻同步。
export function SessionSidebar() {
  const { threadId: activeThreadId } = useParams();
  const navigate = useNavigate();
  const { sessions, loading, error, renameSession, deleteSession } = useSessionsContext();

  async function handleDelete(threadId: string) {
    await deleteSession(threadId);
    if (threadId === activeThreadId) {
      navigate("/");
    }
  }

  return (
    <aside className="w-full h-full flex flex-col py-inset-padding bg-background">
      <div className="px-gutter mb-8 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary-container flex items-center justify-center text-on-primary-container">
          <Icon name="smart_toy" filled />
        </div>
        <div>
          <h1 className="text-headline-sm font-bold text-primary leading-tight">
            Customer Service
          </h1>
          <p className="text-label-sm text-secondary">AI Playground</p>
        </div>
      </div>

      <div className="px-4 mb-6">
        <Link
          to="/"
          className="w-full bg-primary text-on-primary py-3 px-4 rounded-xl text-label-md flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all"
        >
          <Icon name="add" />
          新建会话
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 custom-scrollbar">
        <div className="px-2 pb-2">
          <p className="text-[11px] font-bold text-outline uppercase tracking-wider mb-2 px-2">
            最近会话
          </p>

          {loading && <p className="px-2 text-body-sm text-outline">加载中…</p>}

          {error && (
            <p className="px-2 text-body-sm text-error">
              服务连接失败：{error}
              <br />
              请确认 customer-agents 的 mastra dev 已启动
            </p>
          )}

          {!loading && !error && sessions.length === 0 && (
            <p className="px-2 text-body-sm text-outline italic">还没有会话</p>
          )}

          {sessions.map((session) => (
            <SessionListItem
              key={session.id}
              session={session}
              active={session.id === activeThreadId}
              onRename={renameSession}
              onDelete={handleDelete}
            />
          ))}
        </div>
      </nav>
    </aside>
  );
}

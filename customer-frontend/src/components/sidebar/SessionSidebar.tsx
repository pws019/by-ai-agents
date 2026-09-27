import { Link, useNavigate, useParams } from "react-router";

import { useSessionsContext } from "../../context/SessionsContext";
import { useAuth } from "../../education/AuthContext";
import { Icon } from "../ui/Icon";
import { SessionListItem } from "./SessionListItem";

// 左侧栏宽度由外层 AppLayout 的固定列宽控制；这个组件只负责往固定宽度的容器里填内容。
// 会话列表状态从 SessionsContext 读，和右侧聊天面板共用同一份，面板新建会话后调 refresh() 这边立刻同步。
export function SessionSidebar() {
  const { conversationId: activeId } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { conversations, loading, error } = useSessionsContext();

  return (
    <aside className="w-full h-full flex flex-col py-inset-padding bg-background">
      <div className="px-gutter mb-8 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary-container flex items-center justify-center text-on-primary-container">
          <Icon name="smart_toy" filled />
        </div>
        <div>
          <h1 className="text-headline-sm font-bold text-primary leading-tight">学员服务助手</h1>
          <p className="text-label-sm text-secondary">课程 · 转班 · 退费</p>
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

      <nav className="flex-1 overflow-y-auto px-2 custom-scrollbar" aria-label="会话列表">
        <div className="px-2 pb-2">
          <p className="text-[11px] font-bold text-outline uppercase tracking-wider mb-2 px-2">最近会话</p>

          {loading && <p className="px-2 text-body-sm text-outline">加载中…</p>}
          {error && (
            <p className="px-2 text-body-sm text-error">
              服务连接失败：{error}
              <br />
              请确认 education-api 已启动
            </p>
          )}
          {!loading && !error && conversations.length === 0 && <p className="px-2 text-body-sm text-outline italic">还没有会话</p>}

          {conversations.map((c) => (
            <SessionListItem key={c.id} conversation={c} active={c.id === activeId} />
          ))}
        </div>
      </nav>

      <div className="px-4 pt-4 border-t border-outline-variant flex flex-col gap-2 text-label-md">
        <Link to="/my-learning" className="text-secondary hover:text-primary">
          我的学习
        </Link>
        <Link to="/my-applications" className="text-secondary hover:text-primary">
          我的申请
        </Link>
        <div className="flex items-center justify-between text-label-sm text-outline pt-1">
          <span className="truncate">{user?.loginName}</span>
          <button
            type="button"
            className="text-primary underline"
            onClick={() => void logout().then(() => navigate("/login", { replace: true }))}
          >
            退出
          </button>
        </div>
      </div>
    </aside>
  );
}

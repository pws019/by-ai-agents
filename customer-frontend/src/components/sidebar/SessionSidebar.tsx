import { Link, useLocation, useNavigate, useParams } from "react-router";

import { useSessionsContext } from "../../context/SessionsContext";
import { useAuth } from "../../education/AuthContext";
import { Icon } from "../ui/Icon";
import { SessionListItem } from "./SessionListItem";

// 三个板块地位相等（都是学员能去的地方），不是"聊天为主、其它两个是脚注链接"——
// 这也是为什么它们现在用同一种 nav item 样式，而不是"新建会话"那种强调按钮。
const NAV_ITEMS = [
  { to: "/", icon: "forum", label: "对话", isChat: true },
  { to: "/my-learning", icon: "school", label: "我的学习", isChat: false },
  { to: "/my-applications", icon: "assignment", label: "我的申请", isChat: false },
] as const;

// 左侧栏宽度由外层 AppLayout 的固定列宽控制；这个组件只负责往固定宽度的容器里填内容。
// 会话列表状态从 SessionsContext 读，和右侧聊天面板共用同一份，面板新建会话后调 refresh() 这边立刻同步。
//
// "新建会话"和"最近会话"只在学员实际待在对话板块时才出现——在我的学习/我的申请里显示一堆聊天记录
// 是上下文错位（这个侧栏此刻不该看起来像"聊天记录面板"，它现在的身份是"学员这几个页面共用的导航"）。
export function SessionSidebar() {
  const { conversationId: activeId } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { conversations, loading, error } = useSessionsContext();

  const inChat = pathname === "/" || pathname.startsWith("/sessions/");

  return (
    <aside className="w-full h-full flex flex-col py-inset-padding bg-background">
      <div className="px-gutter mb-6 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary-container flex items-center justify-center text-on-primary-container">
          <Icon name="smart_toy" filled />
        </div>
        <div>
          <h1 className="text-headline-sm font-bold text-primary leading-tight">学员服务助手</h1>
          <p className="text-label-sm text-secondary">课程 · 转班 · 退费</p>
        </div>
      </div>

      <nav className="px-2 flex flex-col gap-1" aria-label="学员功能">
        {NAV_ITEMS.map((item) => {
          const active = item.isChat ? inChat : pathname === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={`flex items-center gap-2 rounded-r-lg px-3 py-2 text-label-md transition-colors ${
                active ? "bg-surface-container-high text-primary border-l-2 border-primary" : "text-secondary hover:bg-surface-container-low"
              }`}
            >
              <Icon name={item.icon} className="text-[18px]" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {inChat && (
        <>
          <div className="mt-4 mx-4 border-t border-outline-variant" />

          <div className="px-4 mt-4 mb-4">
            <Link
              to="/"
              className="w-full bg-primary text-on-primary py-3 px-4 rounded-xl text-label-md flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all"
            >
              <Icon name="add" />
              新建会话
            </Link>
          </div>

          <div className="flex-1 overflow-y-auto px-2 custom-scrollbar" aria-label="会话列表">
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
          </div>
        </>
      )}

      {!inChat && <div className="flex-1" />}

      <div className="px-4 pt-4 border-t border-outline-variant flex items-center justify-between text-label-sm text-outline">
        <span className="truncate">{user?.loginName}</span>
        <button
          type="button"
          className="text-primary underline"
          onClick={() => void logout().then(() => navigate("/login", { replace: true }))}
        >
          退出
        </button>
      </div>
    </aside>
  );
}

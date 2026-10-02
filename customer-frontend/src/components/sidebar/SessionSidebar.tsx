import { Link, useLocation, useNavigate } from "react-router";

import { useAuth } from "../../education/AuthContext";
import { Icon } from "../ui/Icon";

// 三个板块地位相等（都是学员能去的地方），不是"聊天为主、其它两个是脚注链接"——
// 这也是为什么它们现在用同一种 nav item 样式，而不是"新建会话"那种强调按钮。
const NAV_ITEMS = [
  { to: "/", icon: "forum", label: "对话", isChat: true },
  { to: "/my-learning", icon: "school", label: "我的学习", isChat: false },
  { to: "/my-applications", icon: "assignment", label: "我的申请", isChat: false },
] as const;

// 左侧栏宽度由外层 AppLayout 的固定列宽控制；这个组件只负责往固定宽度的容器里填内容。
// "新建会话"和"最近会话"不在这里——它们挪到了右侧可展开收起的 SessionDrawer，这个侧栏现在
// 只是三个板块共用的导航 + 用户信息，不随board切换内容。
export function SessionSidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

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

      <div className="flex-1" />

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

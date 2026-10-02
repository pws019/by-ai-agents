// 老师端的固定外壳（跟学员聊天的 AppLayout + SessionSidebar 是同一个模式）：
// 左侧栏（品牌区 + 两个页面的导航 + 身份/退出）常驻，右侧 <Outlet /> 按路由切换。
// 之前 TeacherApplicationsPage 和 TeacherHandoffsPage 各自画一遍头部（标题、互相跳转的链接、
// 用户名、退出登录），切页面时这层"壳"整个重新拼一遍——本该常驻的东西每次都在闪烁重建，
// 这正是切换显得不连贯的根源。两个页面现在只负责自己的内容，不再关心身份、导航这些外壳职责。
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { Icon } from "../components/ui/Icon";
import { useAuth } from "./AuthContext";

const NAV_ITEMS = [
  { to: "/teacher", icon: "assignment", label: "申请审批" },
  { to: "/teacher/handoffs", icon: "support_agent", label: "会话工作台" },
  { to: "/teacher/knowledge", icon: "menu_book", label: "资料维护" },
] as const;

export function TeacherLayout() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-surface text-on-background">
      <aside className="w-sidebar-width h-full shrink-0 border-r border-outline-variant flex flex-col py-inset-padding bg-background">
        <div className="px-gutter mb-8 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary-container flex items-center justify-center text-on-primary-container">
            <Icon name="support_agent" filled />
          </div>
          <div>
            <h1 className="text-headline-sm font-bold text-primary leading-tight">老师工作台</h1>
            <p className="text-label-sm text-secondary">申请 · 会话 · 资料</p>
          </div>
        </div>

        <nav className="flex-1 px-2" aria-label="老师功能">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-2 rounded-r-lg px-3 py-2.5 text-label-md transition-colors ${
                  active ? "bg-surface-container-high text-primary border-l-2 border-primary" : "text-secondary hover:bg-surface-container-low"
                }`}
              >
                <Icon name={item.icon} className="text-[18px]" />
                {item.label}
              </Link>
            );
          })}
        </nav>

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

      <div className="flex-1 h-full min-w-0">
        <Outlet />
      </div>
    </div>
  );
}

// 角色路由：没登录 → 去登录页（记住来源页，登录后回跳）；登录了但角色不对 → 提示，不静默放行。
// 这里只挡"要不要渲染这个组件"，真正的数据授权在 education-api 那一层已经做过了——
// 前端这道判断只是不让 UI 卡在一个它拿不到数据的页面上，不是安全边界本身。
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "./AuthContext";
import type { Role } from "./types";

export function RequireAuth({ role, children }: { role: Role; children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="p-8 text-on-surface-variant">加载中…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.role !== role) {
    return (
      <div className="p-8 text-on-surface-variant">
        当前账号是「{user.role === "teacher" ? "老师" : "学员"}」角色，没有这个页面的权限。
      </div>
    );
  }
  return <>{children}</>;
}

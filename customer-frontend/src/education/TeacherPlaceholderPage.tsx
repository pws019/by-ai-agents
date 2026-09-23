// 老师端页面不在 T-11 范围内（T-11 只要求"学生登录、角色路由、我的学习基础页"）。
// 这里只是给"角色路由"一个真实的落地点，不是敷衍——没有这个页面，
// 老师账号登录后会撞进 /my-learning 被 RequireAuth 拦下显示无权限，看起来像 bug 而不是"还没做"。
import { useAuth } from "./AuthContext";

export function TeacherPlaceholderPage() {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-surface text-on-surface">
      <p>老师端页面还没开发（见项目 tasks.md T-16）。</p>
      <p className="text-sm text-on-surface-variant">当前登录：{user?.loginName}</p>
      <button onClick={() => void logout()} className="text-sm text-primary underline">
        退出登录
      </button>
    </div>
  );
}

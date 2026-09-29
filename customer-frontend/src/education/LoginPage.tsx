import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { ApiError } from "./api";
import { useAuth } from "./AuthContext";

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 已经登录了还访问 /login：按角色送到对应的落地页，不重复展示表单。
  // 学员落到聊天首页（"/"）——那是主入口，我的学习/我的申请是侧栏里随时可达的次级页面，不必绕一圈。
  if (!loading && user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? (user.role === "teacher" ? "/teacher" : "/")} replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const u = await login(loginName, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? (u.role === "teacher" ? "/teacher" : "/"), { replace: true });
    } catch (err) {
      // 401 统一显示"登录名或密码错误"，不区分是用户名不存在还是密码错——
      // 和后端 education-api 的用户名枚举防护保持一致，前端不能把后端刚堵上的口子又打开。
      setError(err instanceof ApiError && err.status === 401 ? "登录名或密码错误" : "登录失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <form onSubmit={handleSubmit} className="w-80 flex flex-col gap-4 p-8 rounded-lg bg-surface-container-lowest">
        <h1 className="text-headline-sm text-on-surface">登录</h1>
        <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
          登录名
          <input
            className="rounded-md border border-outline-variant px-3 py-2 text-on-surface"
            value={loginName}
            onChange={(e) => setLoginName(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
          密码
          <input
            className="rounded-md border border-outline-variant px-3 py-2 text-on-surface"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="text-sm text-error">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-primary text-on-primary py-2 disabled:opacity-50"
        >
          {submitting ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}

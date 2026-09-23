// 当前登录身份，来自 session cookie（浏览器自动带，前端拿不到 token 本身）。
// 挂载时问一次 GET /me：cookie 有效就是登录状态，401 就是未登录——不在前端自己判断
// "cookie 存不存在"，因为 HttpOnly cookie 前端 JS 根本读不到，也不该读到。
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, getMe, login as apiLogin, logout as apiLogout } from "./api";
import type { CurrentUser } from "./types";

type AuthState = {
  user: CurrentUser | null;
  loading: boolean;
  // 返回登录后的用户，让调用方（LoginPage）能按 role 决定跳去哪，
  // 不用登录成功后再另外发一次 GET /me 才知道角色。
  login: (loginName: string, password: string) => Promise<CurrentUser>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 401)) {
          // 401 是正常的"没登录"，其它错误（网络断了、education-api 没起）值得留痕
          console.error("获取当前身份失败", err);
        }
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (loginName: string, password: string) => {
    const u = await apiLogin(loginName, password);
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 必须在 <AuthProvider> 内使用");
  return ctx;
}

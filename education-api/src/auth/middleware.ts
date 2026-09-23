// 认证中间件：只回答"你是谁"。放在所有路由之前，把身份挂到 context 上，
// 没带 cookie 或 cookie 失效就是 actor=null，这里不 401——401 是 requireAuth 的事，
// 因为有些路由（登录、公开招生信息）本来就允许匿名访问。
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type pg from "pg";
import { errorJson } from "../http/errors.js";
import { resolveSession, type SessionUser } from "./session.js";

export const SESSION_COOKIE = "edu_session";

declare module "hono" {
  interface ContextVariableMap {
    actor: SessionUser | null;
  }
}

const isProd = process.env.NODE_ENV === "production";

export function setSessionCookie(c: Context, token: string, expiresAt: Date) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isProd, // dev 是 http，Secure cookie 在 http 下浏览器直接丢弃
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** 挂在 app 最外层：解析 cookie → 查会话 → 挂到 c.get('actor')。之后的路由直接读，不用再碰 cookie。 */
export function withActor(pool: pg.Pool) {
  return async (c: Context, next: Next) => {
    const token = getCookie(c, SESSION_COOKIE);
    c.set("actor", token ? await resolveSession(pool, token) : null);
    await next();
  };
}

/** 挂在需要登录的路由前：没有身份直接 401，不进 handler。 */
export async function requireAuth(c: Context, next: Next) {
  if (!c.get("actor")) return errorJson(c, 401, "UNAUTHORIZED", "需要登录");
  await next();
}

/** 挂在 requireAuth 之后：身份存在但角色不对，403。顺序反了会先撞到 requireAuth 的 401，掩盖真实原因，所以两者不合并。 */
export function requireRole(role: SessionUser["role"]) {
  return async (c: Context, next: Next) => {
    const actor = c.get("actor");
    if (!actor || actor.role !== role) return errorJson(c, 403, "FORBIDDEN", "当前角色无权限");
    await next();
  };
}

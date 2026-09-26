// 认证中间件：只回答"你是谁"。放在所有路由之前，把身份挂到 context 上，
// 没带 cookie 或 cookie 失效就是 actor=null，这里不 401——401 是 requireAuth 的事，
// 因为有些路由（登录、公开招生信息）本来就允许匿名访问。
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Db } from "../db/pool.js";
import { errorJson } from "../http/errors.js";
import { verifyInternalContext } from "./internalContext.js";
import { resolveSession, resolveUserById, type SessionUser } from "./session.js";

export const SESSION_COOKIE = "edu_session";

export const INTERNAL_CONTEXT_HEADER = "X-Actor-Context";

declare module "hono" {
  interface ContextVariableMap {
    actor: SessionUser | null;
    /** 身份怎么来的：浏览器 session cookie，还是 Agent 服务带来的签名内部上下文。 */
    via: "session" | "agent" | null;
    /** 仅内部通道：签名工作证里的 requestId（BFF 把它设为 runId）。不是用户或模型可以提供的值。 */
    agentRunId: string | null;
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

/**
 * 挂在 app 最外层：解析身份 → 挂到 c.get('actor') / c.get('via')。之后的路由直接读。
 * 两种来源互斥：请求带了 X-Actor-Context 就只认它（校验失败就是匿名，不回退去看 cookie）——
 * 否则"内部头无效时悄悄改用 cookie"会让两条认证通道的边界变模糊。
 */
export function withActor(db: Db, internalSecret?: string) {
  return async (c: Context, next: Next) => {
    const internal = c.req.header(INTERNAL_CONTEXT_HEADER);
    if (internal !== undefined) {
      const ctx = internalSecret ? verifyInternalContext(internal, internalSecret) : null;
      const user = ctx ? await resolveUserById(db, ctx.actorId) : null;
      // 签名里的 role 只是 BFF 签发时的快照，以库里的为准；对不上说明用户被改过角色，按无效处理。
      const ok = ctx && user && user.role === ctx.role;
      c.set("actor", ok ? user : null);
      c.set("via", ok ? "agent" : null);
      c.set("agentRunId", ok ? ctx.requestId : null);
    } else {
      const token = getCookie(c, SESSION_COOKIE);
      const user = token ? await resolveSession(db, token) : null;
      c.set("actor", user);
      c.set("via", user ? "session" : null);
      c.set("agentRunId", null);
    }
    await next();
  };
}

/**
 * 只允许"用户本人在界面上"完成的操作（确认申请、回应方案、所有老师端点）：经 Agent 通道来的请求一律 403。
 * 工具白名单里本来就没有这些工具，这里是第二道防线——即使以后有人加了一个通用 HTTP 工具，
 * 或者模型提示词被注入，业务 API 这一层也不会认一个"由 Agent 代为确认"的请求（AC-004/AC-017）。
 */
export async function denyAgentChannel(c: Context, next: Next) {
  if (c.get("via") === "agent") return errorJson(c, 403, "FORBIDDEN", "该操作只能由用户本人在界面上完成");
  await next();
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

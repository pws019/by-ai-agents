// POST /auth/login、POST /auth/logout、GET /me —— 契约见 contracts/education/openapi.yaml。
import { Hono } from "hono";
import type pg from "pg";
import { verifyPassword } from "../auth/password.js";
import { clearSessionCookie, requireAuth, setSessionCookie, SESSION_COOKIE } from "../auth/middleware.js";
import { createSession, revokeSession } from "../auth/session.js";
import { errorJson } from "../http/errors.js";
import { getCookie } from "hono/cookie";

interface UserRow {
  id: string;
  login_name: string;
  password_hash: string;
  role: "student" | "teacher";
}

export function createAuthRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

  app.post("/auth/login", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.loginName !== "string" || typeof body.password !== "string" || !body.password) {
      return errorJson(c, 422, "VALIDATION_ERROR", "loginName/password 必填");
    }

    const { rows } = await pool.query<UserRow>(
      "SELECT id, login_name, password_hash, role FROM users WHERE lower(login_name) = lower($1)",
      [body.loginName],
    );
    const user = rows[0];
    // 用户不存在和密码错误返回同一个 401——分开返回等于告诉攻击者"这个用户名存在"，
    // 变相支持批量探测哪些登录名已注册（用户名枚举）。
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      return errorJson(c, 401, "UNAUTHORIZED", "登录名或密码错误");
    }

    const { token, expiresAt } = await createSession(pool, user.id);
    setSessionCookie(c, token, expiresAt);
    return c.json({ id: user.id, loginName: user.login_name, role: user.role });
  });

  app.post("/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await revokeSession(pool, token);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.get("/me", requireAuth, (c) => {
    const actor = c.get("actor")!;
    return c.json({ id: actor.id, loginName: actor.loginName, role: actor.role });
  });

  return app;
}

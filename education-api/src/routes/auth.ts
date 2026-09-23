// POST /auth/login、POST /auth/logout、GET /me —— 契约见 contracts/education/openapi.yaml。
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { sql } from "drizzle-orm";
import { clearSessionCookie, requireAuth, setSessionCookie, SESSION_COOKIE } from "../auth/middleware.js";
import { verifyPassword } from "../auth/password.js";
import { createSession, revokeSession } from "../auth/session.js";
import type { Db } from "../db/pool.js";
import { users } from "../db/schema.js";
import { errorJson } from "../http/errors.js";

export function createAuthRoutes(db: Db): Hono {
  const app = new Hono();

  app.post("/auth/login", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.loginName !== "string" || typeof body.password !== "string" || !body.password) {
      return errorJson(c, 422, "VALIDATION_ERROR", "loginName/password 必填");
    }

    // 登录名不区分大小写唯一（迁移里的 lower(login_name) 索引），查询按同样的规则比较。
    const [user] = await db
      .select({ id: users.id, loginName: users.loginName, passwordHash: users.passwordHash, role: users.role })
      .from(users)
      .where(sql`lower(${users.loginName}) = lower(${body.loginName})`);
    // 用户不存在和密码错误返回同一个 401——分开返回等于告诉攻击者"这个用户名存在"，
    // 变相支持批量探测哪些登录名已注册（用户名枚举）。
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      return errorJson(c, 401, "UNAUTHORIZED", "登录名或密码错误");
    }

    const { token, expiresAt } = await createSession(db, user.id);
    setSessionCookie(c, token, expiresAt);
    return c.json({ id: user.id, loginName: user.loginName, role: user.role });
  });

  app.post("/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await revokeSession(db, token);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.get("/me", requireAuth, (c) => {
    const actor = c.get("actor")!;
    return c.json({ id: actor.id, loginName: actor.loginName, role: actor.role });
  });

  return app;
}

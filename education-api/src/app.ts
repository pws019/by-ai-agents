// 组装 Hono app：中间件顺序是设计的一部分，不能随便换。
// requestId（日志/错误体都要用）→ withActor（解析身份，不拒绝）→ CSRF（挡跨站写）
// → 挂路由，路由内部按需 requireAuth/requireRole。
import { Hono } from "hono";
import type pg from "pg";
import { withActor } from "./auth/middleware.js";
import { withRequestId } from "./http/request-id.js";
import { requireSameOrigin } from "./http/same-origin.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createMeRoutes } from "./routes/me.js";

const API_PREFIX = "/api/v1";

export function createApp(pool: pg.Pool, opts?: { allowedOrigin?: string }): Hono {
  const app = new Hono();
  const allowedOrigin = opts?.allowedOrigin ?? process.env.ALLOWED_ORIGIN ?? "http://localhost:5173";

  app.get("/health", (c) => c.json({ ok: true }));

  const api = new Hono();
  api.use(withRequestId);
  api.use(withActor(pool));
  api.use(requireSameOrigin(allowedOrigin));
  api.route("/", createAuthRoutes(pool));
  api.route("/", createMeRoutes(pool));

  app.route(API_PREFIX, api);
  return app;
}

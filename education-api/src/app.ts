// 组装 Hono app：中间件顺序是设计的一部分，不能随便换。
// requestId（日志/错误体都要用）→ withActor（解析身份，不拒绝）→ CSRF（挡跨站写）
// → 挂路由，路由内部按需 requireAuth/requireRole。
import { Hono } from "hono";
import type pg from "pg";
import { denyAgentChannel, withActor } from "./auth/middleware.js";
import { createHttpAgentClient, type AgentClient } from "./chat/agentClient.js";
import { createConversationRoutes } from "./chat/routes.js";
import { createDb } from "./db/pool.js";
import { createHandoffRoutes } from "./handoffs/routes.js";
import { withRequestId } from "./http/request-id.js";
import { requireSameOrigin } from "./http/same-origin.js";
import { createApplicationRoutes } from "./routes/applications.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createCatalogRoutes } from "./routes/catalog.js";
import { createCohortRoutes } from "./routes/cohorts.js";
import { createMeRoutes } from "./routes/me.js";
import { createTeacherRoutes } from "./routes/teacher.js";
import { createTeacherKnowledgeRoutes } from "./routes/teacherKnowledge.js";
import { createReplayRoutes } from "./replays/routes.js";
import { createHttpAgentKnowledgeAdminClient, type AgentKnowledgeAdminClient } from "./knowledge/agentAdminClient.js";

const API_PREFIX = "/api/v1";

export function createApp(
  pool: pg.Pool,
  opts?: {
    allowedOrigin?: string;
    internalAuthSecret?: string;
    agent?: AgentClient;
    agentAdmin?: AgentKnowledgeAdminClient;
    heartbeatIntervalMs?: number;
  },
): Hono {
  const app = new Hono();
  const allowedOrigin = opts?.allowedOrigin ?? process.env.ALLOWED_ORIGIN ?? "http://localhost:5173";
  const internalAuthSecret = opts?.internalAuthSecret ?? process.env.INTERNAL_AUTH_SECRET;
  const db = createDb(pool);
  const agentBaseUrl = process.env.AGENT_BASE_URL;
  const agent = opts?.agent ?? (agentBaseUrl ? createHttpAgentClient(agentBaseUrl) : undefined);
  const agentAdmin = opts?.agentAdmin ?? (agentBaseUrl ? createHttpAgentKnowledgeAdminClient(agentBaseUrl) : undefined);

  app.get("/health", (c) => c.json({ ok: true }));

  const api = new Hono();
  api.use(withRequestId);
  api.use(withActor(db, internalAuthSecret));
  api.use(requireSameOrigin(allowedOrigin));
  // 只能由用户本人在界面上完成的操作，Agent 通道一律拒绝（必须在挂路由之前注册）。
  api.use("/teacher/*", denyAgentChannel);
  // 会话是用户与 BFF 之间的东西；Agent 自己有 checkpoint，不需要也不该读写业务库里的会话。
  api.use("/conversations", denyAgentChannel);
  api.use("/conversations/*", denyAgentChannel);
  api.post("/applications/:applicationId/confirm", denyAgentChannel);
  api.post("/applications/:applicationId/proposal-response", denyAgentChannel);
  api.route("/", createAuthRoutes(db));
  api.route("/", createApplicationRoutes(db));
  api.route("/", createCatalogRoutes(db));
  api.route("/", createCohortRoutes(db));
  api.route("/", createConversationRoutes(db, { agent, internalSecret: internalAuthSecret, heartbeatIntervalMs: opts?.heartbeatIntervalMs }));
  api.route("/", createHandoffRoutes(db));
  api.route("/", createMeRoutes(db));
  api.route("/", createReplayRoutes(db));
  api.route("/", createTeacherRoutes(db));
  api.route("/", createTeacherKnowledgeRoutes(db, { internalSecret: internalAuthSecret, agentAdmin }));

  app.route(API_PREFIX, api);
  return app;
}

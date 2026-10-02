// 老师资料维护（T-29）：导入新版本、查看发布状态、发布/撤回。
// 导入（T-25）、发布/撤回的并发与状态机正确性（T-26）已经分别在 src/knowledge/import.ts 和
// education-agent 的 ingestion.db 测过，这里只是把它们接成 HTTP：校验入参、翻译错误码、
// 组一个教师能看懂的"版本列表 + 每一版的状态"视图。
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { signInternalContext } from "../auth/internalContext.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import type { Db } from "../db/pool.js";
import { cohorts, knowledgeDocuments, knowledgeIndexJobs, knowledgeSegments, lessons } from "../db/schema.js";
import { errorJson, type ErrorCode } from "../http/errors.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { importKnowledgeDocument, type KnowledgeKind } from "../knowledge/import.js";
import type { AgentKnowledgeAdminClient } from "../knowledge/agentAdminClient.js";

const KINDS = new Set<KnowledgeKind>(["srt", "vtt", "markdown"]);
const VISIBILITIES = new Set(["public", "private"]);
// 跟 chat/supervisor.ts 的 RUN_CONTEXT_TTL_SECONDS 同一个理由：工作证要盖过一次发布/撤回操作，
// 这类操作只是一次简单的数据库事务，不像一次 Agent 对话那样可能拖很久，给短一些的有效期即可。
const ADMIN_CONTEXT_TTL_SECONDS = 30;

export function createTeacherKnowledgeRoutes(db: Db, deps: { internalSecret?: string; agentAdmin?: AgentKnowledgeAdminClient }): Hono {
  const app = new Hono();
  app.use("/teacher/*", requireAuth, requireRole("teacher"));

  function adminToken(c: { get(key: "requestId"): string }): string | null {
    if (!deps.internalSecret) return null;
    return signInternalContext(
      { actorId: "teacher-knowledge-admin", role: "teacher", requestId: c.get("requestId") },
      deps.internalSecret,
      { ttlSeconds: ADMIN_CONTEXT_TTL_SECONDS },
    );
  }

  // GET /teacher/lessons/:lessonId —— 维护页面拿着一个 lessonId（从课表/其它地方复制来的）
  // 先核实它存在、看一眼标题和所属班期，再决定要不要在这节课下面导入资料。
  app.get("/teacher/lessons/:lessonId", async (c) => {
    const lessonId = c.req.param("lessonId")!;
    const [row] = await db
      .select({ lessonId: lessons.id, title: lessons.title, cohortId: lessons.cohortId, cohortName: cohorts.name })
      .from(lessons)
      .innerJoin(cohorts, eq(cohorts.id, lessons.cohortId))
      .where(eq(lessons.id, lessonId));
    if (!row) return errorJson(c, 404, "NOT_FOUND", "未找到课次");
    return c.json(row);
  });

  // GET /teacher/knowledge/documents?lessonId= —— 这节课所有已导入的版本及各自状态。
  // indexStatus 为 null 表示从没为这一版登记过索引任务（刚导入、索引 worker 还没处理到它）。
  app.get("/teacher/knowledge/documents", async (c) => {
    const lessonId = c.req.query("lessonId");
    if (!lessonId) return errorJson(c, 422, "VALIDATION_ERROR", "lessonId 必填");

    const docs = await db
      .select({
        documentId: knowledgeDocuments.id, version: knowledgeDocuments.version, kind: knowledgeDocuments.kind,
        sourceName: knowledgeDocuments.sourceName, visibility: knowledgeDocuments.visibility,
        activatedAt: knowledgeDocuments.activatedAt, revokedAt: knowledgeDocuments.revokedAt, createdAt: knowledgeDocuments.createdAt,
        indexStatus: knowledgeIndexJobs.status,
      })
      .from(knowledgeDocuments)
      .leftJoin(knowledgeIndexJobs, and(eq(knowledgeIndexJobs.documentId, knowledgeDocuments.id), eq(knowledgeIndexJobs.kind, "index")))
      .where(eq(knowledgeDocuments.lessonId, lessonId))
      .orderBy(desc(knowledgeDocuments.version));

    const segmentCountByDocument = await segmentCounts(db, docs.map((d) => d.documentId));
    return c.json({ items: docs.map((d) => ({ ...d, segmentCount: segmentCountByDocument.get(d.documentId) ?? 0 })) });
  });

  // POST /teacher/knowledge/documents —— 导入一份新资料（整份文本，不接受文件上传/URL 抓取，
  // 跟 design.md"禁止任意 URL 抓取"的原则一致）。导入成功后顺手登记一条索引任务：
  // 这一步只是幂等 INSERT（ON CONFLICT DO NOTHING），没有并发不变量要保护，不用跨服务调用，
  // 真正跑索引（embedding→Qdrant）仍然是 education-agent 的 ingestion worker 的事。
  app.post("/teacher/knowledge/documents", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body || typeof body.lessonId !== "string" || typeof body.sourceName !== "string" || typeof body.rawContent !== "string" ||
      typeof body.kind !== "string" || !KINDS.has(body.kind as KnowledgeKind) ||
      (body.visibility !== undefined && !VISIBILITIES.has(body.visibility))
    ) {
      return errorJson(c, 422, "VALIDATION_ERROR", "lessonId/kind/sourceName/rawContent 必填，kind 只能是 srt/vtt/markdown");
    }

    const [lesson] = await db.select({ id: lessons.id }).from(lessons).where(eq(lessons.id, body.lessonId));
    if (!lesson) return errorJson(c, 404, "NOT_FOUND", "未找到课次");

    const result = await importKnowledgeDocument(db, {
      lessonId: body.lessonId, kind: body.kind, sourceName: body.sourceName, rawContent: body.rawContent,
      visibility: body.visibility,
    });
    if (result.kind === "imported") {
      await db.insert(knowledgeIndexJobs).values({ documentId: result.documentId, kind: "index" }).onConflictDoNothing();
    }
    return c.json(result, result.kind === "imported" ? 201 : 200);
  });

  // POST /teacher/knowledge/documents/:documentId/publish —— 激活这一版（同时原子撤回同 lesson
  // 旧的激活版本）。真正的逻辑在 education-agent（见 server.py 的说明），这里只负责签发工作证、
  // 调用、把它的错误码翻译成这边的 ErrorResponse 形状。
  app.post("/teacher/knowledge/documents/:documentId/publish", async (c) => {
    if (!deps.agentAdmin) return errorJson(c, 503, "DEPENDENCY_UNAVAILABLE", "发布服务当前不可用");
    const token = adminToken(c);
    if (!token) return errorJson(c, 503, "DEPENDENCY_UNAVAILABLE", "发布服务当前不可用");

    const result = await deps.agentAdmin.activate(c.req.param("documentId")!, token);
    if (result.kind === "error") return agentErrorJson(c, result, "发布失败");
    return new Response(null, { status: 204 });
  });

  // POST /teacher/knowledge/documents/:documentId/withdraw —— 立即撤回（AC-016：旧片段不可检索，
  // 不等物理清理）。对没有激活过的版本调用是幂等的 no-op，返回 withdrawn:false，不报错。
  app.post("/teacher/knowledge/documents/:documentId/withdraw", async (c) => {
    if (!deps.agentAdmin) return errorJson(c, 503, "DEPENDENCY_UNAVAILABLE", "撤回服务当前不可用");
    const token = adminToken(c);
    if (!token) return errorJson(c, 503, "DEPENDENCY_UNAVAILABLE", "撤回服务当前不可用");

    const result = await deps.agentAdmin.withdraw(c.req.param("documentId")!, token);
    if (result.kind === "error") return agentErrorJson(c, result, "撤回失败");
    return c.json(result.data);
  });

  return app;
}

// Agent 服务返回的错误码（LESSON_BUSY/NOT_READY 等）是它自己的词汇，不直接照搬成这边 ErrorResponse
// 的 code——两边的错误码表是两份独立契约，这里显式翻译，而不是假装它们共用一套。
function agentErrorJson(c: Parameters<typeof errorJson>[0], result: { status: number; code: string | null }, message: string) {
  const code: ErrorCode =
    result.code === "LESSON_BUSY" ? "LESSON_BUSY" :
    result.code === "NOT_READY" ? "INVALID_STATE" :
    result.code === "DEPENDENCY_UNAVAILABLE" ? "DEPENDENCY_UNAVAILABLE" :
    "INTERNAL";
  const status: ContentfulStatusCode = code === "LESSON_BUSY" ? 409 : code === "INVALID_STATE" ? 422 : code === "DEPENDENCY_UNAVAILABLE" ? 503 : 500;
  return errorJson(c, status, code, message);
}

async function segmentCounts(db: Db, documentIds: string[]): Promise<Map<string, number>> {
  if (documentIds.length === 0) return new Map();
  const rows = await db
    .select({ documentId: knowledgeSegments.documentId, count: count() })
    .from(knowledgeSegments)
    .where(inArray(knowledgeSegments.documentId, documentIds))
    .groupBy(knowledgeSegments.documentId);
  return new Map(rows.map((r) => [r.documentId, r.count]));
}

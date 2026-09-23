// 申请草稿/摘要/版本/确认 API。契约见 contracts/education/openapi.yaml 的 /applications/* 与 /me/applications。
// 状态机：draft →(confirm)→ submitted →(老师 request-info/propose/approve/reject)→ ...；
// draft 阶段可以反复 PATCH，每次编辑都让旧确认卡失效——这是 AC-005 的来源。
import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, notInArray, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { isUniqueViolation } from "../db/pgError.js";
import type { Db } from "../db/pool.js";
import { applicationEvents, applications, cohorts, confirmations, enrollments } from "../db/schema.js";
import { errorJson } from "../http/errors.js";
import { claimIdempotencyKey, fulfillIdempotencyKey } from "../idempotency.js";

type ApplicationRow = typeof applications.$inferSelect;
type ActiveConfirmation = { id: string; expiresAt: Date };

// 确认卡有效期：设计决定，见 progress.md T-12——没有产品侧给出具体数字，
// 15 分钟是"够学员看清摘要再点确认，又不会长到失效的旧摘要还能被拿去用"的工程判断，
// 不是业务事实，不写进对外文案。
const CONFIRMATION_TTL_MS = 15 * 60 * 1000;

function summaryOf(row: ApplicationRow) {
  return {
    type: row.type,
    enrollmentId: row.enrollmentId,
    reason: row.reason,
    // 老师提出方案后，proposal 里的值才是"学员正在被要求确认的东西"；原始草稿的
    // target_cohort_id 只在还没有方案时才作数，不能两个字段各显示各的，让摘要和确认卡对不上。
    targetCohortId: row.proposal?.targetCohortId ?? row.targetCohortId,
    refundCents: row.proposal?.refundCents ?? null,
  };
}

// payload_hash 绑定的是"确认卡签发时学员看到的摘要"，不是整行数据库记录——
// 摘要之外的字段（比如 executionStatus）变了不该让确认卡失效。
function payloadHashOf(row: ApplicationRow): string {
  return createHash("sha256").update(JSON.stringify(summaryOf(row))).digest("hex");
}

function toApplication(row: ApplicationRow, active?: ActiveConfirmation) {
  return {
    id: row.id,
    type: row.type,
    enrollmentId: row.enrollmentId,
    status: row.status,
    executionStatus: row.executionStatus,
    revision: row.revision,
    summary: summaryOf(row),
    proposal: row.proposal ?? null,
    ...(active
      ? {
          pendingConfirmation: {
            confirmationId: active.id,
            applicationId: row.id,
            revision: row.revision,
            expiresAt: active.expiresAt,
            summary: summaryOf(row),
          },
        }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toApplicationDraft(row: ApplicationRow, active: ActiveConfirmation) {
  const app = toApplication(row, active);
  return { id: app.id, revision: app.revision, status: app.status, summary: app.summary, confirmation: app.pendingConfirmation };
}

// db 和 tx 共享同一个类型（drizzle 的事务对象本身实现了 Db 的查询接口），
// 这样这个 helper 既能在普通请求里用，也能在 confirm 的事务内部复用，不用写两份。
async function issueConfirmation(db: Db, actorId: string, row: ApplicationRow): Promise<ActiveConfirmation> {
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
  const [inserted] = await db
    .insert(confirmations)
    .values({ userId: actorId, applicationId: row.id, payloadHash: payloadHashOf(row), revision: row.revision, expiresAt })
    .returning({ id: confirmations.id, expiresAt: confirmations.expiresAt });
  return inserted!;
}

// 撤销这张申请当前还活着的确认卡（如果有）。撤销不是删除，审计要留痕；也不强制要求
// 一定存在活着的卡——PATCH draft/withdraw/reject 都可能在"根本没有活着的卡"时调用它。
async function revokeActiveConfirmation(db: Db, applicationId: string): Promise<void> {
  await db
    .update(confirmations)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(confirmations.applicationId, applicationId), isNull(confirmations.usedAt), isNull(confirmations.revokedAt)));
}

class StaleConfirmation extends Error {}

// confirm 和 proposal-response 共用的核心动作：原子地"claim 一张确认卡"，紧接着在同一个事务里
// 把申请从 fromStatus 转到 set.status。两步中任何一步没匹配到行都抛 StaleConfirmation，
// 事务自动整体回滚——不会出现"卡被消费了但申请没转态"的半成品。
// 调用方负责决定 set 里要不要带 revision（是否算作一次内容变更，见 progress.md T-13 设计决定）。
async function claimConfirmationAndTransition(
  db: Db,
  args: {
    confirmationId: string;
    applicationId: string;
    expectedRevision: number;
    fromStatus: ApplicationRow["status"];
    set: PgUpdateSetSource<typeof applications>;
    actorId: string;
    eventType: string;
    eventDetails?: Record<string, unknown>;
  },
): Promise<ApplicationRow> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(confirmations)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(confirmations.id, args.confirmationId),
          eq(confirmations.applicationId, args.applicationId),
          eq(confirmations.revision, args.expectedRevision),
          isNull(confirmations.usedAt),
          isNull(confirmations.revokedAt),
          gt(confirmations.expiresAt, sql`now()`),
        ),
      )
      .returning({ revision: confirmations.revision });
    if (!claimed) throw new StaleConfirmation();

    const [row] = await tx
      .update(applications)
      .set(args.set)
      .where(and(eq(applications.id, args.applicationId), eq(applications.revision, args.expectedRevision), eq(applications.status, args.fromStatus)))
      .returning();
    if (!row) throw new StaleConfirmation();

    await tx.insert(applicationEvents).values({
      applicationId: args.applicationId,
      actorId: args.actorId,
      eventType: args.eventType,
      revision: row.revision,
      details: args.eventDetails ?? {},
    });
    return row;
  });
}

// 简单的不透明游标：base64("created_at|id")，按 (created_at, id) 降序翻页。
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64url");
}
function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

export function createApplicationRoutes(db: Db): Hono {
  const app = new Hono();
  app.use("/applications/*", requireAuth);
  app.use("/me/applications", requireAuth);
  app.use("/teacher/applications/*", requireAuth, requireRole("teacher"));

  // POST /applications/drafts —— 新建一张申请草稿。同一 enrollment+type 已经有一张"未结束"
  // 的申请时（唯一索引 applications_one_open_per_enrollment_type 兜底），不是直接报错：
  // 如果那张还在 draft 阶段，当成"重复提交同一个草稿"处理，把它连同确认卡一起原样返回（AC-006）；
  // 如果已经过了 draft（submitted 及以后），说明确实有一张申请在流转中，返回 409 而不是悄悄创建第二张。
  app.post("/applications/drafts", async (c) => {
    const actor = c.get("actor")!;
    const body = await c.req.json().catch(() => null);
    if (!body || (body.type !== "transfer" && body.type !== "refund") || typeof body.enrollmentId !== "string" || !body.reason) {
      return errorJson(c, 422, "VALIDATION_ERROR", "type/enrollmentId/reason 必填");
    }
    if (body.targetCohortId !== undefined && body.targetCohortId !== null && typeof body.targetCohortId !== "string") {
      return errorJson(c, 422, "VALIDATION_ERROR", "targetCohortId 格式不对");
    }

    const [enrollment] = await db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(and(eq(enrollments.id, body.enrollmentId), eq(enrollments.studentId, actor.id), eq(enrollments.status, "active")));
    if (!enrollment) return errorJson(c, 404, "NOT_FOUND", "报名不存在，或不属于当前学员，或已结束");

    if (body.targetCohortId) {
      const [cohort] = await db.select({ id: cohorts.id }).from(cohorts).where(eq(cohorts.id, body.targetCohortId));
      if (!cohort) return errorJson(c, 404, "NOT_FOUND", "目标班期不存在");
    }

    try {
      const [row] = await db
        .insert(applications)
        .values({
          studentId: actor.id,
          enrollmentId: body.enrollmentId,
          type: body.type,
          reason: body.reason,
          targetCohortId: body.targetCohortId ?? null,
          status: "draft",
        })
        .returning();
      const confirmation = await issueConfirmation(db, actor.id, row!);
      return c.json(toApplicationDraft(row!, confirmation), 201);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [existing] = await db
        .select()
        .from(applications)
        .where(
          and(
            eq(applications.enrollmentId, body.enrollmentId),
            eq(applications.type, body.type),
            notInArray(applications.status, ["approved", "rejected", "withdrawn"]),
          ),
        );
      if (!existing) throw err; // 唯一索引刚才确实拦了一次插入，这里应该总能查到；查不到说明假设被打破
      if (existing.status !== "draft") {
        return errorJson(c, 409, "INVALID_STATE", "该报名已有一张进行中的同类型申请，请先处理");
      }
      const [active] = await db
        .select({ id: confirmations.id, expiresAt: confirmations.expiresAt })
        .from(confirmations)
        .where(
          and(
            eq(confirmations.applicationId, existing.id),
            isNull(confirmations.usedAt),
            isNull(confirmations.revokedAt),
            gt(confirmations.expiresAt, sql`now()`),
          ),
        );
      const confirmation = active ?? (await issueConfirmation(db, actor.id, existing));
      return c.json(toApplicationDraft(existing, confirmation), 200);
    }
  });

  // PATCH /applications/:id/draft —— 只能改还没确认提交的草稿。修改内容会让 revision +1，
  // 旧的确认卡随之作废（撤销，不是删除，审计要留痕）并签发一张新的。
  app.patch("/applications/:applicationId/draft", async (c) => {
    const actor = c.get("actor")!;
    const applicationId = c.req.param("applicationId");
    const body = await c.req.json().catch(() => null);
    if (!body || !Number.isInteger(body.expectedRevision)) {
      return errorJson(c, 422, "VALIDATION_ERROR", "expectedRevision 必填");
    }

    const [existing] = await db
      .select()
      .from(applications)
      .where(and(eq(applications.id, applicationId), eq(applications.studentId, actor.id)));
    if (!existing) return errorJson(c, 404, "NOT_FOUND", "申请不存在");
    if (existing.status !== "draft") return errorJson(c, 409, "INVALID_STATE", "已提交的申请不能再编辑草稿");

    if (body.targetCohortId) {
      const [cohort] = await db.select({ id: cohorts.id }).from(cohorts).where(eq(cohorts.id, body.targetCohortId));
      if (!cohort) return errorJson(c, 404, "NOT_FOUND", "目标班期不存在");
    }

    const fields: Partial<typeof applications.$inferInsert> = { reason: body.reason, targetCohortId: body.targetCohortId };
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      if (fields[key] === undefined) delete fields[key];
    }

    // WHERE 里带 revision = expectedRevision：判断和更新在同一条 SQL 里原子完成，不是先查 revision
    // 再单独 UPDATE——否则两个并发 PATCH 会都读到旧 revision、都以为自己能改，其中一个的修改会被悄悄覆盖。
    const [updated] = await db
      .update(applications)
      .set({ ...fields, revision: sql`${applications.revision} + 1` })
      .where(and(eq(applications.id, applicationId), eq(applications.revision, body.expectedRevision)))
      .returning();
    if (!updated) {
      return errorJson(c, 409, "REVISION_CONFLICT", "申请已被修改，请获取最新版本后重试");
    }

    await revokeActiveConfirmation(db, applicationId);
    const confirmation = await issueConfirmation(db, actor.id, updated);
    return c.json(toApplicationDraft(updated, confirmation));
  });

  // POST /applications/:id/confirm —— 契约：confirmationId,expectedRevision → submitted。
  // 核心是把"确认卡还没被用过"和"revision 没变"两件事，跟"标记为已用/推进状态"绑在同一条
  // 原子 UPDATE 里做完，而不是先 SELECT 确认再 UPDATE（T-06 Q1 的 TOCTOU 结论，这次在 UPDATE 上）。
  // 两条 UPDATE 包进同一个 db.transaction：任何一步失败，drizzle 在回调里抛出错误就会自动整体回滚，
  // 不会出现"确认卡被 claim 了但申请没转态"的半成品状态。
  app.post("/applications/:applicationId/confirm", async (c) => {
    const actor = c.get("actor")!;
    const applicationId = c.req.param("applicationId");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.confirmationId !== "string" || !Number.isInteger(body.expectedRevision)) {
      return errorJson(c, 422, "VALIDATION_ERROR", "confirmationId/expectedRevision 必填");
    }
    const idempotencyKey = c.req.header("Idempotency-Key");

    const [application] = await db
      .select()
      .from(applications)
      .where(and(eq(applications.id, applicationId), eq(applications.studentId, actor.id)));
    if (!application) return errorJson(c, 404, "NOT_FOUND", "申请不存在");

    // Idempotency-Key 重放：只有确认过"上一次真的成功过"（result_id 有值）才直接回读结果，
    // 否则（第一次见到这个 key，或者上一次失败了没留下 result_id）都要走一遍下面的正常逻辑——
    // 不能因为 key 重复出现就假装上次成功了，那样会把一次真实的失败悄悄变成假的成功。
    if (idempotencyKey) {
      const requestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const claim = await claimIdempotencyKey(db, actor.id, "confirmApplication", idempotencyKey, requestHash);
      if (claim.kind === "conflict") {
        return errorJson(c, 409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key 已用于内容不同的请求");
      }
      if (claim.kind === "replay" && claim.resultId) {
        const [row] = await db.select().from(applications).where(eq(applications.id, claim.resultId));
        return c.json(toApplication(row!));
      }
    }

    // 同一张确认卡已经把这张申请确认过了（网络重试/手抖点两次）：当成幂等重放，
    // 返回当前状态而不是报错——这一步不依赖 Idempotency-Key 头，只看确认卡本身是否已用于这张申请。
    if (application.status === "submitted") {
      const [used] = await db
        .select({ id: confirmations.id })
        .from(confirmations)
        .where(and(eq(confirmations.id, body.confirmationId), eq(confirmations.applicationId, applicationId), sql`${confirmations.usedAt} is not null`));
      if (used) {
        if (idempotencyKey) await fulfillIdempotencyKey(db, actor.id, "confirmApplication", idempotencyKey, applicationId);
        return c.json(toApplication(application));
      }
    }
    if (application.status !== "draft") {
      return errorJson(c, 409, "INVALID_STATE", "只有草稿状态的申请可以确认");
    }

    try {
      // confirm 是"消费确认卡"类动作：不改 revision，只把 confirmed_revision 对齐到这次
      // 确认时的 revision——revision 留给后续（比如老师 request-info/propose）继续往前走，
      // 之后如果 revision 又变了但 confirmed_revision 没跟上，approve 那一步就知道"内容在
      // 学员确认之后又变过，这个确认已经不代表最新状态了"（design.md 里"校验 revision 与
      // confirmedRevision"这句话对应的就是这个机制，T-14 会真正用到）。
      const updated = await claimConfirmationAndTransition(db, {
        confirmationId: body.confirmationId,
        applicationId,
        expectedRevision: body.expectedRevision,
        fromStatus: "draft",
        set: { status: "submitted", confirmedRevision: body.expectedRevision },
        actorId: actor.id,
        eventType: "submitted",
      });

      if (idempotencyKey) await fulfillIdempotencyKey(db, actor.id, "confirmApplication", idempotencyKey, applicationId);
      return c.json(toApplication(updated));
    } catch (err) {
      if (err instanceof StaleConfirmation) {
        return errorJson(c, 409, "STALE_CONFIRMATION", "确认卡已失效，请查看最新摘要后重新确认");
      }
      throw err;
    }
  });

  // POST /applications/:id/supplement —— 老师要求补充信息（needs_info）之后，学员补一段文字，
  // 回到 submitted。补的内容不覆盖原始 reason，单独记一条审计事件，原因见 T-13 设计决定：
  // reason 是"这次申请为什么提出"，补充说明是"回答老师的追问"，两者语义不同不能混在一个字段里。
  app.post("/applications/:applicationId/supplement", async (c) => {
    const actor = c.get("actor")!;
    const applicationId = c.req.param("applicationId")!;
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || !body.text || !Number.isInteger(body.expectedRevision)) {
      return errorJson(c, 422, "VALIDATION_ERROR", "text/expectedRevision 必填");
    }

    const [existing] = await db
      .select({ status: applications.status })
      .from(applications)
      .where(and(eq(applications.id, applicationId), eq(applications.studentId, actor.id)));
    if (!existing) return errorJson(c, 404, "NOT_FOUND", "申请不存在");
    if (existing.status !== "needs_info") return errorJson(c, 409, "INVALID_STATE", "只有老师要求补充信息时才能补充");

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(applications)
        .set({ status: "submitted", revision: sql`${applications.revision} + 1` })
        .where(and(eq(applications.id, applicationId), eq(applications.revision, body.expectedRevision), eq(applications.status, "needs_info")))
        .returning();
      if (!row) return null;
      await tx.insert(applicationEvents).values({
        applicationId,
        actorId: actor.id,
        eventType: "supplement",
        revision: row.revision,
        details: { text: body.text },
      });
      return row;
    });
    if (!updated) return errorJson(c, 409, "REVISION_CONFLICT", "申请已被修改，请获取最新版本后重试");
    return c.json(toApplication(updated));
  });

  // POST /applications/:id/withdraw —— submitted/needs_info/awaiting_student_confirmation 都能撤，
  // 批准后不能（AC-022：撤回之后老师再处理，靠 status/revision 不匹配拦住，不是额外加一个"已撤回"检查）。
  app.post("/applications/:applicationId/withdraw", async (c) => {
    const actor = c.get("actor")!;
    const applicationId = c.req.param("applicationId")!;
    const body = await c.req.json().catch(() => null);
    if (!body || !Number.isInteger(body.expectedRevision)) {
      return errorJson(c, 422, "VALIDATION_ERROR", "expectedRevision 必填");
    }

    const [existing] = await db
      .select({ status: applications.status })
      .from(applications)
      .where(and(eq(applications.id, applicationId), eq(applications.studentId, actor.id)));
    if (!existing) return errorJson(c, 404, "NOT_FOUND", "申请不存在");
    if (!["submitted", "needs_info", "awaiting_student_confirmation"].includes(existing.status)) {
      return errorJson(c, 409, "INVALID_STATE", "当前状态不能撤回");
    }

    const [updated] = await db
      .update(applications)
      .set({ status: "withdrawn", revision: sql`${applications.revision} + 1` })
      .where(and(eq(applications.id, applicationId), eq(applications.revision, body.expectedRevision)))
      .returning();
    if (!updated) return errorJson(c, 409, "REVISION_CONFLICT", "申请已被修改，请获取最新版本后重试");

    await revokeActiveConfirmation(db, applicationId);
    await db.insert(applicationEvents).values({ applicationId, actorId: actor.id, eventType: "withdrawn", revision: updated.revision, details: {} });
    return c.json(toApplication(updated));
  });

  // POST /applications/:id/proposal-response —— 学员对老师方案的回应。接受和拒绝都要消费同一张
  // 确认卡（都是"针对这个方案做了一次明确决定"），区别只在转态之后的 set：接受不改 revision、
  // 把 confirmed_revision 对齐（后续给 T-14 approve 用）；拒绝清空 proposal 并把 revision 往前推一格
  // ——拒绝之后这个方案作废，谁都不该再基于旧 proposal 做任何事，这点必须体现在版本号上。
  app.post("/applications/:applicationId/proposal-response", async (c) => {
    const actor = c.get("actor")!;
    const applicationId = c.req.param("applicationId")!;
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.accept !== "boolean" || typeof body.confirmationId !== "string" || !Number.isInteger(body.expectedRevision)) {
      return errorJson(c, 422, "VALIDATION_ERROR", "accept/confirmationId/expectedRevision 必填");
    }

    const [application] = await db
      .select()
      .from(applications)
      .where(and(eq(applications.id, applicationId), eq(applications.studentId, actor.id)));
    if (!application) return errorJson(c, 404, "NOT_FOUND", "申请不存在");
    if (application.status !== "awaiting_student_confirmation") {
      return errorJson(c, 409, "INVALID_STATE", "当前没有等待学员确认的方案");
    }

    try {
      const updated = await claimConfirmationAndTransition(db, {
        confirmationId: body.confirmationId,
        applicationId,
        expectedRevision: body.expectedRevision,
        fromStatus: "awaiting_student_confirmation",
        set: body.accept
          ? { status: "submitted", confirmedRevision: body.expectedRevision }
          : { status: "submitted", proposal: null, revision: sql`${applications.revision} + 1` },
        actorId: actor.id,
        eventType: body.accept ? "proposal_accepted" : "proposal_rejected",
      });
      return c.json(toApplication(updated));
    } catch (err) {
      if (err instanceof StaleConfirmation) {
        return errorJson(c, 409, "STALE_CONFIRMATION", "确认卡已失效，请查看最新摘要后重新确认");
      }
      throw err;
    }
  });

  app.get("/me/applications", async (c) => {
    const actor = c.get("actor")!;
    const limitParam = Number(c.req.query("limit") ?? 20);
    const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 100 ? limitParam : 20;
    const cursorParam = c.req.query("cursor");
    const cursor = cursorParam ? decodeCursor(cursorParam) : null;
    if (cursorParam && !cursor) return errorJson(c, 422, "VALIDATION_ERROR", "cursor 格式不对");

    const rows = await db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.studentId, actor.id),
          cursor ? sql`(${applications.createdAt}, ${applications.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id})` : undefined,
        ),
      )
      .orderBy(desc(applications.createdAt), desc(applications.id))
      .limit(limit);
    const nextCursor = rows.length === limit ? encodeCursor(rows[rows.length - 1]!) : null;
    return c.json({ items: rows.map((r) => toApplication(r)), nextCursor });
  });

  // GET /applications/:id —— owner 或任意老师可见；不满足条件的（包括不存在）一律 404，
  // 不区分"不存在"和"存在但不是你的"，避免把"这个 id 是否存在"泄露给无关的人。
  app.get("/applications/:applicationId", requireAuth, async (c) => {
    const actor = c.get("actor")!;
    const applicationId = c.req.param("applicationId")!;

    const [row] = await db.select().from(applications).where(eq(applications.id, applicationId));
    if (!row || (actor.role !== "teacher" && row.studentId !== actor.id)) {
      return errorJson(c, 404, "NOT_FOUND", "申请不存在");
    }

    const [active] = await db
      .select({ id: confirmations.id, expiresAt: confirmations.expiresAt })
      .from(confirmations)
      .where(
        and(
          eq(confirmations.applicationId, applicationId),
          isNull(confirmations.usedAt),
          isNull(confirmations.revokedAt),
          gt(confirmations.expiresAt, sql`now()`),
        ),
      );
    const events = await db
      .select({
        eventType: applicationEvents.eventType,
        actorId: applicationEvents.actorId,
        revision: applicationEvents.revision,
        details: applicationEvents.details,
        createdAt: applicationEvents.createdAt,
      })
      .from(applicationEvents)
      .where(eq(applicationEvents.applicationId, applicationId))
      .orderBy(applicationEvents.createdAt);
    return c.json({ ...toApplication(row, active), events });
  });

  // GET /teacher/applications —— 老师的处理队列。任何老师都能看到全部申请（不是只看自己带的班），
  // 和 T-10 已经定下的"老师角色不按班期分权限"一致；status/type 是可选过滤，不传就是全部。
  app.get("/teacher/applications", async (c) => {
    const limitParam = Number(c.req.query("limit") ?? 20);
    const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 100 ? limitParam : 20;
    const cursorParam = c.req.query("cursor");
    const cursor = cursorParam ? decodeCursor(cursorParam) : null;
    if (cursorParam && !cursor) return errorJson(c, 422, "VALIDATION_ERROR", "cursor 格式不对");
    const status = c.req.query("status");
    const type = c.req.query("type");

    const rows = await db
      .select()
      .from(applications)
      .where(
        and(
          status ? eq(applications.status, status as ApplicationRow["status"]) : undefined,
          type ? eq(applications.type, type as ApplicationRow["type"]) : undefined,
          cursor ? sql`(${applications.createdAt}, ${applications.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id})` : undefined,
        ),
      )
      .orderBy(desc(applications.createdAt), desc(applications.id))
      .limit(limit);
    const nextCursor = rows.length === limit ? encodeCursor(rows[rows.length - 1]!) : null;
    return c.json({ items: rows.map((r) => toApplication(r)), nextCursor });
  });

  // POST /teacher/applications/:id/request-info —— 只能从 submitted 发起（design.md 状态机图上
  // 只有这一条边），把问题记进审计事件，不是塞进 reason（reason 是学员自己写的原始理由）。
  app.post("/teacher/applications/:applicationId/request-info", async (c) => {
    const actor = c.get("actor")!;
    const applicationId = c.req.param("applicationId")!;
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.question !== "string" || !body.question || !Number.isInteger(body.expectedRevision)) {
      return errorJson(c, 422, "VALIDATION_ERROR", "question/expectedRevision 必填");
    }

    const [existing] = await db.select({ status: applications.status }).from(applications).where(eq(applications.id, applicationId));
    if (!existing) return errorJson(c, 404, "NOT_FOUND", "申请不存在");
    if (existing.status !== "submitted") return errorJson(c, 409, "INVALID_STATE", "只有待处理的申请可以要求补充信息");

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(applications)
        .set({ status: "needs_info", revision: sql`${applications.revision} + 1` })
        .where(and(eq(applications.id, applicationId), eq(applications.revision, body.expectedRevision), eq(applications.status, "submitted")))
        .returning();
      if (!row) return null;
      await tx.insert(applicationEvents).values({
        applicationId,
        actorId: actor.id,
        eventType: "request_info",
        revision: row.revision,
        details: { question: body.question },
      });
      return row;
    });
    if (!updated) return errorJson(c, 409, "REVISION_CONFLICT", "申请已被修改，请获取最新版本后重试");
    return c.json(toApplication(updated));
  });

  // POST /teacher/applications/:id/propose —— 转班给目标班期或退费给 refundCents，二选一由
  // application.type 决定；只能从 submitted 发起。方案写进 proposal，签给学员一张新确认卡
  // （user_id 是学员本人，不是发起这次请求的老师——这张卡是学员要用来"确认/拒绝"的）。
  app.post("/teacher/applications/:applicationId/propose", async (c) => {
    const actor = c.get("actor")!;
    const applicationId = c.req.param("applicationId")!;
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.reason !== "string" || !body.reason || !Number.isInteger(body.expectedRevision)) {
      return errorJson(c, 422, "VALIDATION_ERROR", "reason/expectedRevision 必填");
    }

    const [existing] = await db.select().from(applications).where(eq(applications.id, applicationId));
    if (!existing) return errorJson(c, 404, "NOT_FOUND", "申请不存在");
    if (existing.status !== "submitted") return errorJson(c, 409, "INVALID_STATE", "只有待处理的申请可以提出方案");

    let proposal: { targetCohortId?: string; refundCents?: number };
    if (existing.type === "transfer") {
      if (typeof body.targetCohortId !== "string") return errorJson(c, 422, "VALIDATION_ERROR", "转班方案必须给 targetCohortId");
      const [cohort] = await db.select({ id: cohorts.id }).from(cohorts).where(eq(cohorts.id, body.targetCohortId));
      if (!cohort) return errorJson(c, 404, "NOT_FOUND", "目标班期不存在");
      proposal = { targetCohortId: body.targetCohortId };
    } else {
      if (!Number.isInteger(body.refundCents) || body.refundCents < 0) return errorJson(c, 422, "VALIDATION_ERROR", "退费方案必须给非负整数 refundCents");
      proposal = { refundCents: body.refundCents };
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(applications)
        .set({ status: "awaiting_student_confirmation", proposal, revision: sql`${applications.revision} + 1` })
        .where(and(eq(applications.id, applicationId), eq(applications.revision, body.expectedRevision), eq(applications.status, "submitted")))
        .returning();
      if (!row) return null;
      await tx.insert(applicationEvents).values({
        applicationId,
        actorId: actor.id,
        eventType: "proposed",
        revision: row.revision,
        details: { reason: body.reason, proposal },
      });
      return row;
    });
    if (!updated) return errorJson(c, 409, "REVISION_CONFLICT", "申请已被修改，请获取最新版本后重试");

    const confirmation = await issueConfirmation(db, existing.studentId, updated);
    return c.json({ ...toApplication(updated, confirmation) });
  });

  // POST /teacher/applications/:id/reject —— 终态拒绝整张申请（不是拒绝某个方案，那是
  // proposal-response）。允许范围和 withdraw 对称：批准之前的任何非终态都能被老师拒绝。
  app.post("/teacher/applications/:applicationId/reject", async (c) => {
    const actor = c.get("actor")!;
    const applicationId = c.req.param("applicationId")!;
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.reason !== "string" || !body.reason || !Number.isInteger(body.expectedRevision)) {
      return errorJson(c, 422, "VALIDATION_ERROR", "reason/expectedRevision 必填");
    }

    const [existing] = await db.select({ status: applications.status }).from(applications).where(eq(applications.id, applicationId));
    if (!existing) return errorJson(c, 404, "NOT_FOUND", "申请不存在");
    if (!["submitted", "needs_info", "awaiting_student_confirmation"].includes(existing.status)) {
      return errorJson(c, 409, "INVALID_STATE", "当前状态不能拒绝");
    }

    const [updated] = await db
      .update(applications)
      .set({ status: "rejected", revision: sql`${applications.revision} + 1` })
      .where(and(eq(applications.id, applicationId), eq(applications.revision, body.expectedRevision)))
      .returning();
    if (!updated) return errorJson(c, 409, "REVISION_CONFLICT", "申请已被修改，请获取最新版本后重试");

    await revokeActiveConfirmation(db, applicationId);
    await db.insert(applicationEvents).values({ applicationId, actorId: actor.id, eventType: "rejected", revision: updated.revision, details: { reason: body.reason } });
    return c.json(toApplication(updated));
  });

  return app;
}

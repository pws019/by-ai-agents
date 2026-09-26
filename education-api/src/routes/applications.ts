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
import { applicationEvents, applications, cohorts, confirmations, enrollmentChanges, enrollments, orders, replayEntitlements, runs } from "../db/schema.js";
import { errorJson } from "../http/errors.js";
import { findRunOwnedBy } from "../chat/runs.js";
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

// confirm/approve/refund-result 三个端点对 Idempotency-Key 的处理逻辑完全一样，只是
// operation 名字不同：没带 key 就直接放行；带了 key，交给 claimIdempotencyKey 判断是
// "冲突"（同 key 不同内容）、"重放"（已经成功过，把当年的结果原样返回）还是"放行"
// （第一次见这个 key，继续走正常流程）。调用方只需要处理这三种结果，不用关心
// hash 怎么算、claim 表怎么查。
type IdempotencyOutcome = { kind: "proceed" } | { kind: "conflict" } | { kind: "replay"; row: ApplicationRow };

async function checkIdempotency(
  db: Db,
  actorId: string,
  operation: string,
  idempotencyKey: string | undefined,
  body: unknown,
): Promise<IdempotencyOutcome> {
  if (!idempotencyKey) return { kind: "proceed" };
  const requestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const claim = await claimIdempotencyKey(db, actorId, operation, idempotencyKey, requestHash);
  if (claim.kind === "conflict") return { kind: "conflict" };
  if (claim.kind === "replay" && claim.resultId) {
    const [row] = await db.select().from(applications).where(eq(applications.id, claim.resultId));
    return { kind: "replay", row: row! };
  }
  return { kind: "proceed" };
}

class RefundExceedsBalance extends Error {}

// refund-result 的 outcome='completed' 分支：给订单加钱、把报名的访问权限收回，两件事
// 在同一个事务内完成（调用方负责传入已经开启的 tx）。抛 RefundExceedsBalance 由调用方
// 转成 409，不在这里直接碰 HTTP 层。
async function finalizeCompletedRefund(tx: Db, existing: ApplicationRow): Promise<void> {
  const refundCents = existing.proposal?.refundCents;
  if (!Number.isInteger(refundCents)) throw new Error("退费申请缺少 proposal.refundCents，数据不一致");
  const [enrollment] = await tx.select({ orderId: enrollments.orderId }).from(enrollments).where(eq(enrollments.id, existing.enrollmentId));
  if (!enrollment) throw new Error("申请指向的报名不存在，数据不一致");

  // 退款金额是否超过订单可退余额，边界判断直接写进 UPDATE 的 WHERE——数据库的
  // CHECK (refunded_cents <= paid_cents) 是最后一道防线，这里提前判断是为了能
  // 返回一个业务语义清楚的错误，而不是让调用方看到一条原始的 CHECK 违例。
  const [orderRow] = await tx
    .update(orders)
    .set({ refundedCents: sql`${orders.refundedCents} + ${refundCents}` })
    .where(and(eq(orders.id, enrollment.orderId), sql`${orders.refundedCents} + ${refundCents} <= ${orders.paidCents}`))
    .returning({ id: orders.id });
  if (!orderRow) throw new RefundExceedsBalance();

  // 钱退了，这份报名的访问权限也要一起收回——enrollments.status 不只是展示用的
  // 标记，teacher.ts 里标记学习进度的权限判断就是靠它（status='active'）。
  // 不在这里改的话，退费到账后学员还能被当成"在读"记录进度。
  await tx
    .update(enrollments)
    .set({ status: "ended", revision: sql`${enrollments.revision} + 1` })
    .where(eq(enrollments.id, existing.enrollmentId));
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

    // 草稿来源：只有 Agent 通道、且工作证里的 runId 确实是本人会话里的运行才记录；来源由已验签的工作证决定，不是请求体。
    const sourceRunId = c.get("via") === "agent" ? await findRunOwnedBy(db, c.get("agentRunId"), actor.id) : null;

    try {
      // insert 和签发确认卡包进同一个事务：如果确认卡那条 INSERT 恰好失败（比如连接中断），
      // 不能留下一张"已经存在但没有任何确认卡"的申请——那样学员连 PATCH 都摸不到入口去补救
      // （PATCH 要求 body 至少带一个要改的字段，光靠它触发不了"没卡就补一张"的逻辑）。
      const { row, confirmation } = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(applications)
          .values({
            studentId: actor.id,
            enrollmentId: body.enrollmentId,
            type: body.type,
            reason: body.reason,
            targetCohortId: body.targetCohortId ?? null,
            status: "draft",
            sourceRunId,
          })
          .returning();
        const confirmation = await issueConfirmation(tx, actor.id, row!);
        return { row: row!, confirmation };
      });
      return c.json(toApplicationDraft(row, confirmation), 201);
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
      // 同一张草稿被再次起草：把来源更新为最近这次运行，这样"待确认"会出现在学员最近说这件事的那个会话里。
      if (sourceRunId && existing.sourceRunId !== sourceRunId) {
        await db.update(applications).set({ sourceRunId }).where(eq(applications.id, existing.id));
      }
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

    // 更新内容、撤销旧卡、签发新卡包进同一个事务：这三步只要中间一步失败就整体回滚，不会出现
    // "旧卡撤销了、新卡却没发出来"（比撤销前更糟——学员连旧卡都不能用了）这种半成品。
    const result = await db.transaction(async (tx) => {
      // WHERE 里带 revision = expectedRevision：判断和更新在同一条 SQL 里原子完成，不是先查
      // revision 再单独 UPDATE——否则两个并发 PATCH 会都读到旧 revision、都以为自己能改。
      const [updated] = await tx
        .update(applications)
        .set({ ...fields, revision: sql`${applications.revision} + 1` })
        .where(and(eq(applications.id, applicationId), eq(applications.revision, body.expectedRevision)))
        .returning();
      if (!updated) return null;

      await revokeActiveConfirmation(tx, applicationId);
      const confirmation = await issueConfirmation(tx, actor.id, updated);
      return { updated, confirmation };
    });
    if (!result) {
      return errorJson(c, 409, "REVISION_CONFLICT", "申请已被修改，请获取最新版本后重试");
    }
    return c.json(toApplicationDraft(result.updated, result.confirmation));
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
    const idempotency = await checkIdempotency(db, actor.id, "confirmApplication", idempotencyKey, body);
    if (idempotency.kind === "conflict") {
      return errorJson(c, 409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key 已用于内容不同的请求");
    }
    if (idempotency.kind === "replay") return c.json(toApplication(idempotency.row));

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

    // 转态、写审计事件、签发确认卡都包进同一个事务：确认卡是这次提议成立的必要条件
    // ——如果发卡失败，申请却已经停在 awaiting_student_confirmation 且没有任何卡能消费，
    // 学员会卡在原地没法回应（不像草稿阶段还能靠 PATCH 补救）。
    const result = await db.transaction(async (tx) => {
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
      const confirmation = await issueConfirmation(tx, existing.studentId, row);
      return { row, confirmation };
    });
    if (!result) return errorJson(c, 409, "REVISION_CONFLICT", "申请已被修改，请获取最新版本后重试");

    return c.json({ ...toApplication(result.row, result.confirmation) });
  });

  // POST /teacher/applications/:id/approve —— 转班在事务内直接变更报名和回放权益，
  // 执行完成（executionStatus=completed）；退费只表示"同意"，不代表已经打钱，
  // executionStatus 停在 pending，真正登记执行结果是 T-15 的 refund-result。
  //
  // AC-008（两位老师并发批准只执行一次）靠一条 UPDATE 的 WHERE 同时锁死三件事：
  // revision 等于 expectedRevision、confirmed_revision 等于 revision（内容没有在学员
  // 确认之后又变过，见 progress.md T-13 的 revision/confirmed_revision 时序图）、
  // status 还是 submitted。三个条件全在一条语句里原子判断，不是分开先查后判断。
  app.post("/teacher/applications/:applicationId/approve", async (c) => {
    const actor = c.get("actor")!;
    const applicationId = c.req.param("applicationId")!;
    const body = await c.req.json().catch(() => null);
    if (!body || !Number.isInteger(body.expectedRevision)) {
      return errorJson(c, 422, "VALIDATION_ERROR", "expectedRevision 必填");
    }
    const idempotencyKey = c.req.header("Idempotency-Key");

    const [existing] = await db.select().from(applications).where(eq(applications.id, applicationId));
    if (!existing) return errorJson(c, 404, "NOT_FOUND", "申请不存在");

    if (existing.type === "transfer" && body.oldReplayAccess !== "keep" && body.oldReplayAccess !== "revoke") {
      return errorJson(c, 422, "VALIDATION_ERROR", "转班批准必须给 oldReplayAccess: keep/revoke");
    }

    // Idempotency-Key 重放：跟 confirm 同一套规则，只信任真的成功过（留了 result_id）的记录，
    // 半途失败的不算数，重试要重新走一遍。
    const idempotency = await checkIdempotency(db, actor.id, "approveApplication", idempotencyKey, body);
    if (idempotency.kind === "conflict") {
      return errorJson(c, 409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key 已用于内容不同的请求");
    }
    if (idempotency.kind === "replay") return c.json(toApplication(idempotency.row));

    let targetCohortId: string | null = null;
    if (existing.type === "transfer") {
      // 目标以老师方案为准，没有方案就用草稿当初就知道的目标（见 T-13 设计决定的兜底链）。
      targetCohortId = existing.proposal?.targetCohortId ?? existing.targetCohortId;
      if (!targetCohortId) return errorJson(c, 409, "INVALID_STATE", "转班目标还没确定，不能批准");
    }

    class ApproveConflict extends Error {}

    try {
      const updated = await db.transaction(async (tx) => {
        // 三个条件都进 WHERE：revision 对得上、confirmed_revision 对得上 revision（没有
        // 在学员确认之后又被改过）、状态还是 submitted。一次只有一个并发请求能匹配到行。
        const [row] = await tx
          .update(applications)
          .set({
            status: "approved",
            executionStatus: existing.type === "transfer" ? "completed" : "pending",
            revision: sql`${applications.revision} + 1`,
          })
          .where(
            and(
              eq(applications.id, applicationId),
              eq(applications.revision, body.expectedRevision),
              eq(applications.confirmedRevision, body.expectedRevision),
              eq(applications.status, "submitted"),
            ),
          )
          .returning();
        if (!row) throw new ApproveConflict();

        if (existing.type === "transfer") {
          const [enrollment] = await tx.select().from(enrollments).where(eq(enrollments.id, existing.enrollmentId));
          if (!enrollment) throw new Error("申请指向的报名不存在，数据不一致");
          const fromCohortId = enrollment.cohortId;

          await tx
            .update(enrollments)
            .set({ cohortId: targetCohortId!, revision: sql`${enrollments.revision} + 1` })
            .where(eq(enrollments.id, enrollment.id));

          // 一张申请最多一条转班记录，唯一约束兜底：并发批准就算撞开了前面的 revision 判断
          // （理论上不会），这里也会因为 application_id 唯一而拦第二次插入。
          await tx.insert(enrollmentChanges).values({
            enrollmentId: enrollment.id,
            fromCohortId,
            toCohortId: targetCohortId!,
            applicationId,
            teacherId: actor.id,
          });

          if (body.oldReplayAccess === "keep") {
            await tx.insert(replayEntitlements).values({
              studentId: existing.studentId,
              cohortId: fromCohortId,
              sourceApplicationId: applicationId,
            });
          }
        }

        await tx.insert(applicationEvents).values({
          applicationId,
          actorId: actor.id,
          eventType: "approved",
          revision: row.revision,
          details: existing.type === "transfer" ? { targetCohortId, oldReplayAccess: body.oldReplayAccess } : {},
        });

        return row;
      });

      if (idempotencyKey) await fulfillIdempotencyKey(db, actor.id, "approveApplication", idempotencyKey, applicationId);
      return c.json(toApplication(updated));
    } catch (err) {
      if (err instanceof ApproveConflict) {
        return errorJson(c, 409, "REVISION_CONFLICT", "申请已被其他老师处理，或内容在学员确认之后又变过");
      }
      throw err;
    }
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

  // POST /teacher/applications/:id/refund-result —— 人工登记退款结果。这个系统没有接支付
  // 渠道，钱是老师在系统外面手动转的，这里只是把"转成了"或"转失败了"这个事实记下来。
  // "重复登记不重复增加 refundedCents"靠两层保护：Idempotency-Key（同一次请求的网络重试）
  // + applications 那条原子 UPDATE 的 WHERE 带 executionStatus='pending'（不是这次请求发起的
  // 重复调用，比如老师手抖点了两下，第二下会因为 executionStatus 已经不是 pending 而落空）。
  app.post("/teacher/applications/:applicationId/refund-result", async (c) => {
    const actor = c.get("actor")!;
    const applicationId = c.req.param("applicationId")!;
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      (body.outcome !== "completed" && body.outcome !== "failed") ||
      typeof body.note !== "string" ||
      !body.note ||
      !Number.isInteger(body.expectedRevision)
    ) {
      return errorJson(c, 422, "VALIDATION_ERROR", "outcome/note/expectedRevision 必填");
    }
    const idempotencyKey = c.req.header("Idempotency-Key");

    const [existing] = await db.select().from(applications).where(eq(applications.id, applicationId));
    if (!existing) return errorJson(c, 404, "NOT_FOUND", "申请不存在");
    if (existing.type !== "refund") return errorJson(c, 409, "INVALID_STATE", "只有退费类型的申请可以登记退款结果");

    // Idempotency-Key 的重放检查必须排在"当前状态还是不是 pending"这个判断之前：
    // 第一次调用成功后 executionStatus 已经不是 pending 了，如果先做状态判断，
    // 同一个 key 的合法重试会被误判成"已经登记过、不能再登记"，而不是被正确识别为重放。
    const idempotency = await checkIdempotency(db, actor.id, "refundResult", idempotencyKey, body);
    if (idempotency.kind === "conflict") {
      return errorJson(c, 409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key 已用于内容不同的请求");
    }
    if (idempotency.kind === "replay") return c.json(toApplication(idempotency.row));

    if (existing.status !== "approved" || existing.executionStatus !== "pending") {
      return errorJson(c, 409, "INVALID_STATE", "只有已批准、还没登记过结果的退费申请可以登记");
    }

    class RefundConflict extends Error {}

    try {
      const updated = await db.transaction(async (tx) => {
        // 先抢 applications 这把锁：谁先把 executionStatus 从 pending 改走，谁才有资格继续
        // 往下动订单金额。抢不到（并发登记/重复调用）的，这条 UPDATE 直接 0 行。
        const [row] = await tx
          .update(applications)
          .set({ executionStatus: body.outcome, revision: sql`${applications.revision} + 1` })
          .where(
            and(
              eq(applications.id, applicationId),
              eq(applications.revision, body.expectedRevision),
              eq(applications.status, "approved"),
              eq(applications.executionStatus, "pending"),
            ),
          )
          .returning();
        if (!row) throw new RefundConflict();

        if (body.outcome === "completed") await finalizeCompletedRefund(tx, existing);

        await tx.insert(applicationEvents).values({
          applicationId,
          actorId: actor.id,
          eventType: "refund_result",
          revision: row.revision,
          details: { outcome: body.outcome, reference: body.reference ?? null, note: body.note },
        });

        return row;
      });

      if (idempotencyKey) await fulfillIdempotencyKey(db, actor.id, "refundResult", idempotencyKey, applicationId);
      return c.json(toApplication(updated));
    } catch (err) {
      if (err instanceof RefundConflict) {
        return errorJson(c, 409, "REVISION_CONFLICT", "申请已被处理过，或版本已变化");
      }
      if (err instanceof RefundExceedsBalance) {
        return errorJson(c, 409, "INVALID_STATE", "退款金额超过订单可退余额");
      }
      throw err;
    }
  });

  return app;
}


/**
 * 某个会话里"待确认"的草稿及其确认卡（形状与契约 application.confirmation 事件的载荷一致）。
 * 条件：草稿仍是 draft、来源是这个会话里的某次运行、确认卡未使用/未撤销/未过期。多张时取最新一张。
 * 用于断线重连后找回确认卡——确认卡在实时事件流里发出过，但不进 messages 表。
 */
export async function findPendingConfirmationForConversation(db: Db, conversationId: string) {
  const [row] = await db
    .select({ application: applications, confirmationId: confirmations.id, expiresAt: confirmations.expiresAt })
    .from(applications)
    .innerJoin(runs, eq(runs.id, applications.sourceRunId))
    .innerJoin(confirmations, eq(confirmations.applicationId, applications.id))
    .where(
      and(
        eq(runs.conversationId, conversationId),
        eq(applications.status, "draft"),
        isNull(confirmations.usedAt),
        isNull(confirmations.revokedAt),
        gt(confirmations.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(applications.createdAt), desc(applications.id))
    .limit(1);
  if (!row) return null;
  return {
    applicationId: row.application.id,
    confirmationId: row.confirmationId,
    revision: row.application.revision,
    expiresAt: row.expiresAt,
    summary: summaryOf(row.application),
  };
}

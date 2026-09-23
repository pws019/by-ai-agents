// 申请草稿/摘要/版本/确认 API。契约见 contracts/education/openapi.yaml 的 /applications/* 与 /me/applications。
// 状态机：draft →(confirm)→ submitted →(老师 request-info/propose/approve/reject)→ ...；
// draft 阶段可以反复 PATCH，每次编辑都让旧确认卡失效——这是 AC-005 的来源。
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type pg from "pg";
import { requireAuth } from "../auth/middleware.js";
import { errorJson } from "../http/errors.js";

const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (err: unknown): boolean => (err as { code?: string })?.code === UNIQUE_VIOLATION;

// 确认卡有效期：设计决定，见 progress.md T-12——没有产品侧给出具体数字，
// 15 分钟是"够学员看清摘要再点确认，又不会长到失效的旧摘要还能被拿去用"的工程判断，
// 不是业务事实，不写进对外文案。
const CONFIRMATION_TTL_MS = 15 * 60 * 1000;

interface ApplicationRow {
  id: string;
  student_id: string;
  enrollment_id: string;
  type: string;
  reason: string;
  target_cohort_id: string | null;
  status: string;
  execution_status: string;
  proposal: { refundCents?: number } | null;
  revision: number;
  confirmed_revision: number | null;
  created_at: Date;
  updated_at: Date;
}

interface ActiveConfirmation {
  id: string;
  expires_at: Date;
}

const APPLICATION_COLUMNS =
  "id, student_id, enrollment_id, type, reason, target_cohort_id, status, execution_status, proposal, revision, confirmed_revision, created_at, updated_at";

function summaryOf(row: ApplicationRow) {
  return {
    type: row.type,
    enrollmentId: row.enrollment_id,
    reason: row.reason,
    targetCohortId: row.target_cohort_id,
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
    enrollmentId: row.enrollment_id,
    status: row.status,
    executionStatus: row.execution_status,
    revision: row.revision,
    summary: summaryOf(row),
    proposal: row.proposal ?? null,
    ...(active
      ? {
          pendingConfirmation: {
            confirmationId: active.id,
            applicationId: row.id,
            revision: row.revision,
            expiresAt: active.expires_at,
            summary: summaryOf(row),
          },
        }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toApplicationDraft(row: ApplicationRow, active: ActiveConfirmation) {
  const app = toApplication(row, active);
  return { id: app.id, revision: app.revision, status: app.status, summary: app.summary, confirmation: app.pendingConfirmation };
}

async function issueConfirmation(pool: pg.Pool, actorId: string, row: ApplicationRow): Promise<ActiveConfirmation> {
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
  const { rows } = await pool.query<{ id: string; expires_at: Date }>(
    `INSERT INTO confirmations (user_id, application_id, payload_hash, revision, expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, expires_at`,
    [actorId, row.id, payloadHashOf(row), row.revision, expiresAt],
  );
  return rows[0]!;
}

// 简单的不透明游标：base64("created_at|id")，按 (created_at, id) 降序翻页。
function encodeCursor(row: { created_at: Date; id: string }): string {
  return Buffer.from(`${row.created_at.toISOString()}|${row.id}`).toString("base64url");
}
function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

export function createApplicationRoutes(pool: pg.Pool): Hono {
  const app = new Hono();
  app.use("/applications/*", requireAuth);
  app.use("/me/applications", requireAuth);

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

    const { rows: enrollmentRows } = await pool.query(
      "SELECT 1 FROM enrollments WHERE id = $1 AND student_id = $2 AND status = 'active'",
      [body.enrollmentId, actor.id],
    );
    if (enrollmentRows.length === 0) return errorJson(c, 404, "NOT_FOUND", "报名不存在，或不属于当前学员，或已结束");

    if (body.targetCohortId) {
      const { rows: cohortRows } = await pool.query("SELECT 1 FROM cohorts WHERE id = $1", [body.targetCohortId]);
      if (cohortRows.length === 0) return errorJson(c, 404, "NOT_FOUND", "目标班期不存在");
    }

    try {
      const { rows } = await pool.query<ApplicationRow>(
        `INSERT INTO applications (student_id, enrollment_id, type, reason, target_cohort_id, status)
         VALUES ($1,$2,$3,$4,$5,'draft') RETURNING ${APPLICATION_COLUMNS}`,
        [actor.id, body.enrollmentId, body.type, body.reason, body.targetCohortId ?? null],
      );
      const row = rows[0]!;
      const confirmation = await issueConfirmation(pool, actor.id, row);
      return c.json(toApplicationDraft(row, confirmation), 201);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const { rows } = await pool.query<ApplicationRow>(
        `SELECT ${APPLICATION_COLUMNS} FROM applications WHERE enrollment_id = $1 AND type = $2
         AND status NOT IN ('approved','rejected','withdrawn')`,
        [body.enrollmentId, body.type],
      );
      const existing = rows[0];
      if (!existing) throw err; // 唯一索引刚才确实拦了一次插入，这里应该总能查到；查不到说明假设被打破
      if (existing.status !== "draft") {
        return errorJson(c, 409, "INVALID_STATE", "该报名已有一张进行中的同类型申请，请先处理");
      }
      const { rows: activeRows } = await pool.query<ActiveConfirmation>(
        `SELECT id, expires_at FROM confirmations
         WHERE application_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
        [existing.id],
      );
      const confirmation = activeRows[0] ?? (await issueConfirmation(pool, actor.id, existing));
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

    const { rows: existingRows } = await pool.query<ApplicationRow>(
      `SELECT ${APPLICATION_COLUMNS} FROM applications WHERE id = $1 AND student_id = $2`,
      [applicationId, actor.id],
    );
    const existing = existingRows[0];
    if (!existing) return errorJson(c, 404, "NOT_FOUND", "申请不存在");
    if (existing.status !== "draft") return errorJson(c, 409, "INVALID_STATE", "已提交的申请不能再编辑草稿");

    if (body.targetCohortId) {
      const { rows: cohortRows } = await pool.query("SELECT 1 FROM cohorts WHERE id = $1", [body.targetCohortId]);
      if (cohortRows.length === 0) return errorJson(c, 404, "NOT_FOUND", "目标班期不存在");
    }

    const fields: Record<string, unknown> = { reason: body.reason, target_cohort_id: body.targetCohortId };
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    const setClause = entries.map(([col], i) => `${col} = $${i + 3}`).join(", ");
    const values = entries.map(([, v]) => v);

    // WHERE 里带 revision = $2：判断和更新在同一条 SQL 里原子完成，不是先查 revision 再单独 UPDATE——
    // 否则两个并发 PATCH 会都读到旧 revision、都以为自己能改，其中一个的修改会被悄悄覆盖。
    const { rows } = await pool.query<ApplicationRow>(
      `UPDATE applications SET revision = revision + 1${entries.length ? ", " + setClause : ""}
       WHERE id = $1 AND revision = $2 RETURNING ${APPLICATION_COLUMNS}`,
      [applicationId, body.expectedRevision, ...values],
    );
    if (rows.length === 0) {
      return errorJson(c, 409, "REVISION_CONFLICT", "申请已被修改，请获取最新版本后重试");
    }
    const updated = rows[0]!;

    await pool.query(
      `UPDATE confirmations SET revoked_at = now() WHERE application_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [applicationId],
    );
    const confirmation = await issueConfirmation(pool, actor.id, updated);
    return c.json(toApplicationDraft(updated, confirmation));
  });

  // POST /applications/:id/confirm —— 学员手写练习，见 progress.md T-12 与本次教学记录。
  // 契约：confirmationId,expectedRevision → submitted。核心是把"确认卡还没被用过"和
  // "revision 没变"两件事，跟"标记为已用/推进状态"绑在同一条原子 SQL 里做完，
  // 而不是先 SELECT 确认再 UPDATE——参考 T-06 Q1 的 TOCTOU 结论，这里是同一个坑在 UPDATE 语句上的版本。
  //
  // 需要覆盖的行为（对应下面 applications.test.ts 里已经写好、目前会失败的用例）：
  //   1. 正常路径：confirmationId 未用/未撤销/未过期，且其 revision 等于 body.expectedRevision
  //      且等于 applications.revision（三者本该一致，但不能只检查其中一个）——
  //      原子地把该确认卡标记为已用（UPDATE ... SET used_at = now() WHERE id=$1 AND used_at IS NULL
  //      AND revoked_at IS NULL AND expires_at > now() RETURNING *，rowCount=0 就说明抢不到），
  //      再把 applications.status 改成 submitted、confirmed_revision 记为这次的 revision，
  //      并在 application_events 里追加一条 eventType='submitted' 的审计记录。
  //   2. 重复调用同一个 confirmationId（网络重试/学员手抖点两次）：第二次请求原子标记会失败
  //      （used_at 已经不是 NULL），但如果检查后发现"是同一张确认卡、且申请确实已经是
  //      submitted+这个 revision"，应该当成幂等重放处理，返回 200 和当前状态，而不是报错——
  //      调用方分不清"我点了两下"和"别人抢先了"，但系统能区分：前者最终状态和自己期望的一致。
  //   3. 草稿被改过之后才点旧的确认卡（AC-005）：confirmationId 存在但 revision 对不上当前
  //      applications.revision（比如学员在另一个标签页 PATCH 过），返回 409 STALE_CONFIRMATION，
  //      details 里带 currentRevision 和 expectedRevision（参考契约里 confirm 的 409 示例）。
  //   4. confirmationId 不存在 / 不属于这个 applicationId / 已撤销 / 已过期：同样是 409
  //      STALE_CONFIRMATION（对调用方来说都是"这张确认卡不能用了"，不需要在响应里区分具体原因）。
  //   5. 只有 owner（student_id = actor.id）能确认自己的申请——不存在或不是本人的，404。
  //   6. 支持 Idempotency-Key（本文件顶部已 import requireAuth；claimIdempotencyKey /
  //      fulfillIdempotencyKey 在 ../idempotency.ts，用法参考其文件头注释）：同一个
  //      (actor, "confirmApplication", key) 重试且请求体一致，不要重复执行业务逻辑，
  //      直接返回当前 applicationId 对应的最新状态。
  app.post("/applications/:applicationId/confirm", async (c) => {
    // TODO(student): 在这里实现。删除下面这一行占位返回。
    return errorJson(c, 501, "INTERNAL", "POST /applications/:applicationId/confirm 待实现");
  });

  app.get("/me/applications", async (c) => {
    const actor = c.get("actor")!;
    const limitParam = Number(c.req.query("limit") ?? 20);
    const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 100 ? limitParam : 20;
    const cursorParam = c.req.query("cursor");
    const cursor = cursorParam ? decodeCursor(cursorParam) : null;
    if (cursorParam && !cursor) return errorJson(c, 422, "VALIDATION_ERROR", "cursor 格式不对");

    const { rows } = await pool.query<ApplicationRow>(
      `SELECT ${APPLICATION_COLUMNS} FROM applications
       WHERE student_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3))
       ORDER BY created_at DESC, id DESC LIMIT $4`,
      [actor.id, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
    );
    const nextCursor = rows.length === limit ? encodeCursor(rows[rows.length - 1]!) : null;
    return c.json({ items: rows.map((r) => toApplication(r)), nextCursor });
  });

  // GET /applications/:id —— owner 或任意老师可见；不满足条件的（包括不存在）一律 404，
  // 不区分"不存在"和"存在但不是你的"，避免把"这个 id 是否存在"泄露给无关的人。
  app.get("/applications/:applicationId", requireAuth, async (c) => {
    const actor = c.get("actor")!;
    const applicationId = c.req.param("applicationId");

    const { rows } = await pool.query<ApplicationRow>(
      `SELECT ${APPLICATION_COLUMNS} FROM applications WHERE id = $1`,
      [applicationId],
    );
    const row = rows[0];
    if (!row || (actor.role !== "teacher" && row.student_id !== actor.id)) {
      return errorJson(c, 404, "NOT_FOUND", "申请不存在");
    }

    const { rows: activeRows } = await pool.query<ActiveConfirmation>(
      `SELECT id, expires_at FROM confirmations
       WHERE application_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
      [applicationId],
    );
    const { rows: eventRows } = await pool.query(
      `SELECT event_type, actor_id, revision, details, created_at FROM application_events
       WHERE application_id = $1 ORDER BY created_at ASC`,
      [applicationId],
    );
    return c.json({
      ...toApplication(row, activeRows[0]),
      events: eventRows.map((e) => ({
        eventType: e.event_type,
        actorId: e.actor_id,
        revision: e.revision,
        details: e.details,
        createdAt: e.created_at,
      })),
    });
  });

  return app;
}

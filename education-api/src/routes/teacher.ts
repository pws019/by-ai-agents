// 老师基础维护/导入 API：班期、课次、手工报名、进度导入。契约见 contracts/education/openapi.yaml
// 的 /teacher/cohorts、/teacher/lessons、/teacher/enrollments、/teacher/progress/import。
import { Hono } from "hono";
import type pg from "pg";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { errorJson } from "../http/errors.js";
import { toEnrollment, type EnrollmentRow } from "./me.js";

interface CohortRow {
  id: string;
  course_id: string;
  course_version_id: string;
  name: string;
  start_at: Date | null;
  price_cents: string | null; // bigint 以字符串形式返回，见 T-09 的坑
  currency: string;
  status: string;
  is_current_sale: boolean;
}

function toCohort(row: CohortRow) {
  return {
    cohortId: row.id,
    courseId: row.course_id,
    courseVersionId: row.course_version_id,
    name: row.name,
    startAt: row.start_at,
    priceCents: row.price_cents === null ? null : Number(row.price_cents),
    currency: row.currency,
    status: row.status,
    isCurrentSale: row.is_current_sale,
  };
}

interface LessonRow {
  id: string;
  title: string;
  position: number;
  replay_asset_key: string | null;
}

function toLesson(row: LessonRow) {
  return { lessonId: row.id, title: row.title, order: row.position, hasReplay: row.replay_asset_key !== null };
}

// Postgres 唯一约束冲突的错误码；用来把"业务上已经存在"翻译成 422 而不是让原始 SQL 错误冒出去。
const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (err: unknown): boolean => (err as { code?: string })?.code === UNIQUE_VIOLATION;

export function createTeacherRoutes(pool: pg.Pool): Hono {
  const app = new Hono();
  app.use("/teacher/*", requireAuth, requireRole("teacher"));

  app.post("/teacher/cohorts", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.courseId !== "string" || typeof body.courseVersionId !== "string" || !body.name || !body.status) {
      return errorJson(c, 422, "VALIDATION_ERROR", "courseId/courseVersionId/name/status 必填");
    }

    const { rows: courseVersionRows } = await pool.query(
      "SELECT 1 FROM course_versions WHERE id = $1 AND course_id = $2",
      [body.courseVersionId, body.courseId],
    );
    if (courseVersionRows.length === 0) return errorJson(c, 404, "NOT_FOUND", "课程或课程版本不存在，或版本不属于该课程");

    try {
      const { rows } = await pool.query<CohortRow>(
        `INSERT INTO cohorts (course_id, course_version_id, name, start_at, price_cents, currency, status, is_current_sale)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, course_id, course_version_id, name, start_at, price_cents, currency, status, is_current_sale`,
        [
          body.courseId,
          body.courseVersionId,
          body.name,
          body.startAt ?? null,
          body.priceCents ?? null,
          body.currency ?? "CNY",
          body.status,
          body.isCurrentSale ?? false,
        ],
      );
      return c.json(toCohort(rows[0]!), 201);
    } catch (err) {
      if (isUniqueViolation(err)) return errorJson(c, 422, "VALIDATION_ERROR", "该课程已有当期在售班期");
      throw err;
    }
  });

  app.patch("/teacher/cohorts/:cohortId", async (c) => {
    const cohortId = c.req.param("cohortId");
    const body = await c.req.json().catch(() => null);
    const fields: Record<string, unknown> = {
      name: body?.name,
      start_at: body?.startAt,
      price_cents: body?.priceCents,
      status: body?.status,
      is_current_sale: body?.isCurrentSale,
    };
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return errorJson(c, 422, "VALIDATION_ERROR", "至少提供一个要修改的字段");

    const setClause = entries.map(([col], i) => `${col} = $${i + 2}`).join(", ");
    const values = entries.map(([, v]) => v);

    try {
      const { rows } = await pool.query<CohortRow>(
        `UPDATE cohorts SET ${setClause} WHERE id = $1
         RETURNING id, course_id, course_version_id, name, start_at, price_cents, currency, status, is_current_sale`,
        [cohortId, ...values],
      );
      if (rows.length === 0) return errorJson(c, 404, "NOT_FOUND", "班期不存在");
      return c.json(toCohort(rows[0]!));
    } catch (err) {
      if (isUniqueViolation(err)) return errorJson(c, 422, "VALIDATION_ERROR", "该课程已有当期在售班期");
      throw err;
    }
  });

  app.post("/teacher/lessons", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.cohortId !== "string" || !body.title || !Number.isInteger(body.position)) {
      return errorJson(c, 422, "VALIDATION_ERROR", "cohortId/title/position 必填");
    }

    const { rows: cohortRows } = await pool.query("SELECT 1 FROM cohorts WHERE id = $1", [body.cohortId]);
    if (cohortRows.length === 0) return errorJson(c, 404, "NOT_FOUND", "班期不存在");

    try {
      const { rows } = await pool.query<LessonRow>(
        `INSERT INTO lessons (cohort_id, title, position, replay_asset_key) VALUES ($1,$2,$3,$4)
         RETURNING id, title, position, replay_asset_key`,
        [body.cohortId, body.title, body.position, body.replayAssetKey ?? null],
      );
      return c.json(toLesson(rows[0]!), 201);
    } catch (err) {
      if (isUniqueViolation(err)) return errorJson(c, 422, "VALIDATION_ERROR", "该班期下已有相同顺序的课次");
      throw err;
    }
  });

  app.patch("/teacher/lessons/:lessonId", async (c) => {
    const lessonId = c.req.param("lessonId");
    const body = await c.req.json().catch(() => null);
    const fields: Record<string, unknown> = {
      title: body?.title,
      position: body?.position,
      replay_asset_key: body?.replayAssetKey,
    };
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return errorJson(c, 422, "VALIDATION_ERROR", "至少提供一个要修改的字段");

    const setClause = entries.map(([col], i) => `${col} = $${i + 2}`).join(", ");
    const values = entries.map(([, v]) => v);

    try {
      const { rows } = await pool.query<LessonRow>(
        `UPDATE lessons SET ${setClause} WHERE id = $1 RETURNING id, title, position, replay_asset_key`,
        [lessonId, ...values],
      );
      if (rows.length === 0) return errorJson(c, 404, "NOT_FOUND", "课次不存在");
      return c.json(toLesson(rows[0]!));
    } catch (err) {
      if (isUniqueViolation(err)) return errorJson(c, 422, "VALIDATION_ERROR", "该班期下已有相同顺序的课次");
      throw err;
    }
  });

  app.post("/teacher/enrollments", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.studentId !== "string" || typeof body.cohortId !== "string" || typeof body.policyId !== "string" || !Number.isInteger(body.paidCents)) {
      return errorJson(c, 422, "VALIDATION_ERROR", "studentId/cohortId/policyId/paidCents 必填");
    }

    const { rows: studentRows } = await pool.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [body.studentId]);
    if (studentRows.length === 0) return errorJson(c, 404, "NOT_FOUND", "学员不存在");
    if (studentRows[0]!.role !== "student") return errorJson(c, 422, "VALIDATION_ERROR", "studentId 对应的账号不是学员角色");

    const { rows: cohortRows } = await pool.query("SELECT 1 FROM cohorts WHERE id = $1", [body.cohortId]);
    if (cohortRows.length === 0) return errorJson(c, 404, "NOT_FOUND", "班期不存在");
    const { rows: policyRows } = await pool.query("SELECT 1 FROM policies WHERE id = $1", [body.policyId]);
    if (policyRows.length === 0) return errorJson(c, 404, "NOT_FOUND", "政策不存在");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: orderRows } = await client.query<{ id: string }>(
        `INSERT INTO orders (student_id, cohort_id, policy_id, paid_cents, source)
         VALUES ($1,$2,$3,$4,'manual') RETURNING id`,
        [body.studentId, body.cohortId, body.policyId, body.paidCents],
      );
      const { rows: enrollmentRows } = await client.query<EnrollmentRow>(
        `WITH inserted AS (
           INSERT INTO enrollments (student_id, order_id, cohort_id, status)
           VALUES ($1,$2,$3,'active') RETURNING id, status, revision, cohort_id
         )
         SELECT i.id, i.status, i.revision, c.id AS cohort_id, c.name, c.start_at, p.version AS policy_version
         FROM inserted i JOIN cohorts c ON c.id = i.cohort_id JOIN policies p ON p.id = $4`,
        [body.studentId, orderRows[0]!.id, body.cohortId, body.policyId],
      );
      await client.query("COMMIT");
      return c.json(toEnrollment(enrollmentRows[0]!), 201);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  app.post("/teacher/progress/import", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.items) || body.items.length === 0) {
      return errorJson(c, 422, "VALIDATION_ERROR", "items 必须是非空数组");
    }

    let applied = 0;
    const rejected: { studentId: string; lessonId: string; reason: string }[] = [];

    for (const item of body.items) {
      const { studentId, lessonId, status } = item ?? {};
      if (typeof studentId !== "string" || typeof lessonId !== "string" || typeof status !== "string") {
        rejected.push({ studentId, lessonId, reason: "字段缺失或类型不对" });
        continue;
      }

      const { rows: lessonRows } = await pool.query<{ cohort_id: string }>(
        "SELECT cohort_id FROM lessons WHERE id = $1",
        [lessonId],
      );
      if (lessonRows.length === 0) {
        rejected.push({ studentId, lessonId, reason: "课次不存在" });
        continue;
      }

      // 只允许给真的在这个班期报名的学员录入进度，不能凭一个 studentId 就无中生有地建记录。
      const { rows: enrollmentRows } = await pool.query(
        "SELECT 1 FROM enrollments WHERE student_id = $1 AND cohort_id = $2 AND status = 'active'",
        [studentId, lessonRows[0]!.cohort_id],
      );
      if (enrollmentRows.length === 0) {
        rejected.push({ studentId, lessonId, reason: "该学员未在此课次所属班期报名" });
        continue;
      }

      await pool.query(
        `INSERT INTO learning_progress (student_id, lesson_id, status, source)
         VALUES ($1,$2,$3,'import')
         ON CONFLICT (student_id, lesson_id) DO UPDATE SET status = EXCLUDED.status, source = 'import'`,
        [studentId, lessonId, status],
      );
      applied++;
    }

    return c.json({ applied, rejected });
  });

  return app;
}

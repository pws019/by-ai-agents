// GET /me/enrollments/:enrollmentId/progress —— 规格见 me.test.ts。
// 授权判断的核心：enrollments 查询把 student_id 放进 WHERE，不存在和不是本人的都归一为 404。
import { Hono } from "hono";
import type pg from "pg";
import { requireAuth } from "../auth/middleware.js";
import { errorJson } from "../http/errors.js";

interface EnrollmentRow {
  id: string;
  status: string;
  revision: number;
  cohort_id: string;
  name: string;
  start_at: Date | null;
  policy_version: number;
}

function toEnrollment(row: EnrollmentRow) {
  return {
    enrollmentId: row.id,
    cohort: { cohortId: row.cohort_id, name: row.name, startAt: row.start_at },
    status: row.status,
    // rights 契约字段描述和 policyVersion 重复、语义不明确（不是这个系统当前有数据来源的东西），
    // 不编造内容，固定返回空数组；见 progress.md T-09 设计决定。
    rights: [] as string[],
    policyVersion: row.policy_version,
    revision: row.revision,
  };
}

export function createMeRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

  app.get("/me/enrollments", requireAuth, async (c) => {
    const actor = c.get("actor")!;
    const { rows } = await pool.query<EnrollmentRow>(
      `SELECT e.id, e.status, e.revision, c.id AS cohort_id, c.name, c.start_at, p.version AS policy_version
       FROM enrollments e
       JOIN cohorts c ON c.id = e.cohort_id
       JOIN orders o ON o.id = e.order_id
       JOIN policies p ON p.id = o.policy_id
       WHERE e.student_id = $1
       ORDER BY e.created_at DESC`,
      [actor.id],
    );
    return c.json({ items: rows.map(toEnrollment) });
  });

  app.get("/me/enrollments/:enrollmentId/progress", requireAuth, async (c) => {
    const actor = c.get("actor")!;
    const enrollmentId = c.req.param("enrollmentId");

    // 找到报名信息
    const { rows } = await pool.query<{id: string, student_id: string, cohort_id: string}>(
      "SELECT id, student_id, cohort_id FROM enrollments WHERE id = $1 and student_id = $2",
      [enrollmentId, actor.id],
    );

    const enrollment = rows[0];
    if(!enrollment) {
      return errorJson(c, 404, "NOT_FOUND", "未找到报名");
    }
    const cohortId = enrollment.cohort_id;


    // 查找对应的课程id
    const { rows: lessonRows } = await pool.query<{id: string}>(
      "SELECT id FROM lessons WHERE cohort_id = $1",
      [cohortId],
    );

    const lessonIds = lessonRows.map(v => v.id);

    // 找到对应的学习记录信息
    const { rows: learningProcess } = await pool.query<{lesson_id: string, status: "not_started" | "in_progress" | "completed", source: string}>(
      "SELECT student_id, id, lesson_id, status, source FROM learning_progress WHERE lesson_id = ANY($1) and student_id = $2",
      [lessonIds, actor.id],
    )

    const items = learningProcess.map(v => ({lessonId: v.lesson_id, status: v.status, source: v.source}));

    return c.json({items});
  });

  app.get("/me/enrollments/:enrollmentId/schedule", requireAuth, async (c) => {
    const actor = c.get("actor")!;
    const enrollmentId = c.req.param("enrollmentId");

    const { rows } = await pool.query<{ cohort_id: string }>(
      "SELECT cohort_id FROM enrollments WHERE id = $1 AND student_id = $2",
      [enrollmentId, actor.id],
    );
    const enrollment = rows[0];
    if (!enrollment) return errorJson(c, 404, "NOT_FOUND", "未找到报名");

    const { rows: lessons } = await pool.query<{ id: string; title: string; position: number; replay_asset_key: string | null }>(
      "SELECT id, title, position, replay_asset_key FROM lessons WHERE cohort_id = $1 ORDER BY position",
      [enrollment.cohort_id],
    );
    return c.json({
      items: lessons.map((l) => ({ lessonId: l.id, title: l.title, order: l.position, hasReplay: l.replay_asset_key !== null })),
    });
  });

  return app;
}

// GET /cohorts/transfer-targets?enrollmentId= —— "已建立的可展示目标；不承诺批准"
// enrollmentId 走 query 而不是 path，但授权判断和 /me/enrollments/:id/* 是同一件事：
// 必须属于当前登录学员，不属于就 404，不额外返回 403。
import { Hono } from "hono";
import type pg from "pg";
import { requireAuth } from "../auth/middleware.js";
import { errorJson } from "../http/errors.js";

export function createCohortRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

  app.get("/cohorts/transfer-targets", requireAuth, async (c) => {
    const actor = c.get("actor")!;
    const enrollmentId = c.req.query("enrollmentId");
    if (!enrollmentId) return errorJson(c, 422, "VALIDATION_ERROR", "enrollmentId 必填");

    const { rows } = await pool.query<{ course_id: string; cohort_id: string }>(
      `SELECT c.course_id, e.cohort_id
       FROM enrollments e JOIN cohorts c ON c.id = e.cohort_id
       WHERE e.id = $1 AND e.student_id = $2`,
      [enrollmentId, actor.id],
    );
    const enrollment = rows[0];
    if (!enrollment) return errorJson(c, 404, "NOT_FOUND", "未找到报名");

    // 候选目标：同一门课程下、还没结束、不是当前正在读的那个班期。这是一条业务假设
    // （具体能不能转到某个班期，真正的判断在 M2 老师审批时做），不是最终规则。
    const { rows: targets } = await pool.query<{ id: string; name: string; start_at: Date | null }>(
      `SELECT id, name, start_at FROM cohorts
       WHERE course_id = $1 AND id <> $2 AND status IN ('upcoming', 'running')
       ORDER BY start_at ASC NULLS LAST`,
      [enrollment.course_id, enrollment.cohort_id],
    );
    return c.json({
      items: targets.map((t) => ({ cohortId: t.id, name: t.name, startAt: t.start_at })),
    });
  });

  return app;
}

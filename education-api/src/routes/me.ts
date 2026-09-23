// GET /me/enrollments/:enrollmentId/progress —— 规格见 me.test.ts。
// 授权判断的核心：enrollments 查询把 student_id 放进 WHERE，不存在和不是本人的都归一为 404。
import { Hono } from "hono";
import type pg from "pg";
import { requireAuth } from "../auth/middleware.js";
import { errorJson } from "../http/errors.js";

export function createMeRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

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

  return app;
}

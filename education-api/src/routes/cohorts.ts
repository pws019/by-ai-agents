// GET /cohorts/transfer-targets?enrollmentId= —— "已建立的可展示目标；不承诺批准"
// enrollmentId 走 query 而不是 path，但授权判断和 /me/enrollments/:id/* 是同一件事：
// 必须属于当前登录学员，不属于就 404，不额外返回 403。
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import type { Db } from "../db/pool.js";
import { cohorts, enrollments } from "../db/schema.js";
import { errorJson } from "../http/errors.js";

export function createCohortRoutes(db: Db): Hono {
  const app = new Hono();

  app.get("/cohorts/transfer-targets", requireAuth, async (c) => {
    const actor = c.get("actor")!;
    const enrollmentId = c.req.query("enrollmentId");
    if (!enrollmentId) return errorJson(c, 422, "VALIDATION_ERROR", "enrollmentId 必填");

    const [enrollment] = await db
      .select({ courseId: cohorts.courseId, cohortId: enrollments.cohortId })
      .from(enrollments)
      .innerJoin(cohorts, eq(cohorts.id, enrollments.cohortId))
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.studentId, actor.id)));
    if (!enrollment) return errorJson(c, 404, "NOT_FOUND", "未找到报名");

    // 候选目标：同一门课程下、还没结束、不是当前正在读的那个班期。这是一条业务假设
    // （具体能不能转到某个班期，真正的判断在 M2 老师审批时做），不是最终规则。
    const targets = await db
      .select({ id: cohorts.id, name: cohorts.name, startAt: cohorts.startAt })
      .from(cohorts)
      .where(
        and(
          eq(cohorts.courseId, enrollment.courseId),
          ne(cohorts.id, enrollment.cohortId),
          inArray(cohorts.status, ["upcoming", "running"]),
        ),
      )
      .orderBy(sql`${cohorts.startAt} asc nulls last`);

    return c.json({
      items: targets.map((t) => ({ cohortId: t.id, name: t.name, startAt: t.startAt })),
    });
  });

  return app;
}

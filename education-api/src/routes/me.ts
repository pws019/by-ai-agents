// GET /me/enrollments/:enrollmentId/progress —— 规格见 me.test.ts。
// 授权判断的核心：enrollments 查询把 student_id 放进 WHERE，不存在和不是本人的都归一为 404。
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import type { Db } from "../db/pool.js";
import { cohorts, enrollments, learningProgress, lessons, orders, policies } from "../db/schema.js";
import { errorJson } from "../http/errors.js";

// 导出给 teacher.ts 复用：手工登记报名之后返回的形状要和这里的 Enrollment 一致。
export interface EnrollmentRow {
  id: string;
  status: string;
  revision: number;
  cohortId: string;
  name: string;
  startAt: Date | null;
  policyVersion: number;
}

export function toEnrollment(row: EnrollmentRow) {
  return {
    enrollmentId: row.id,
    cohort: { cohortId: row.cohortId, name: row.name, startAt: row.startAt },
    status: row.status,
    // rights 契约字段描述和 policyVersion 重复、语义不明确（不是这个系统当前有数据来源的东西），
    // 不编造内容，固定返回空数组；见 progress.md T-09 设计决定。
    rights: [] as string[],
    policyVersion: row.policyVersion,
    revision: row.revision,
  };
}

export function createMeRoutes(db: Db): Hono {
  const app = new Hono();

  app.get("/me/enrollments", requireAuth, async (c) => {
    const actor = c.get("actor")!;
    const rows = await db
      .select({
        id: enrollments.id,
        status: enrollments.status,
        revision: enrollments.revision,
        cohortId: cohorts.id,
        name: cohorts.name,
        startAt: cohorts.startAt,
        policyVersion: policies.version,
      })
      .from(enrollments)
      .innerJoin(cohorts, eq(cohorts.id, enrollments.cohortId))
      .innerJoin(orders, eq(orders.id, enrollments.orderId))
      .innerJoin(policies, eq(policies.id, orders.policyId))
      .where(eq(enrollments.studentId, actor.id))
      .orderBy(desc(enrollments.createdAt));
    return c.json({ items: rows.map(toEnrollment) });
  });

  app.get("/me/enrollments/:enrollmentId/progress", requireAuth, async (c) => {
    const actor = c.get("actor")!;
    const enrollmentId = c.req.param("enrollmentId")!;

    // 找到报名信息
    const [enrollment] = await db
      .select({ id: enrollments.id, studentId: enrollments.studentId, cohortId: enrollments.cohortId })
      .from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.studentId, actor.id)));

    if (!enrollment) {
      return errorJson(c, 404, "NOT_FOUND", "未找到报名");
    }
    const cohortId = enrollment.cohortId;

    // 查找对应的课程id
    const lessonRows = await db.select({ id: lessons.id }).from(lessons).where(eq(lessons.cohortId, cohortId));

    const lessonIds = lessonRows.map((v) => v.id);

    // 找到对应的学习记录信息
    const learningProcess = lessonIds.length
      ? await db
          .select({ lessonId: learningProgress.lessonId, status: learningProgress.status, source: learningProgress.source })
          .from(learningProgress)
          .where(and(inArray(learningProgress.lessonId, lessonIds), eq(learningProgress.studentId, actor.id)))
      : [];

    const items = learningProcess.map((v) => ({ lessonId: v.lessonId, status: v.status, source: v.source }));

    return c.json({ items });
  });

  app.get("/me/enrollments/:enrollmentId/schedule", requireAuth, async (c) => {
    const actor = c.get("actor")!;
    const enrollmentId = c.req.param("enrollmentId")!;

    const [enrollment] = await db
      .select({ cohortId: enrollments.cohortId })
      .from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.studentId, actor.id)));
    if (!enrollment) return errorJson(c, 404, "NOT_FOUND", "未找到报名");

    const items = await db
      .select({ id: lessons.id, title: lessons.title, position: lessons.position, replayAssetKey: lessons.replayAssetKey })
      .from(lessons)
      .where(eq(lessons.cohortId, enrollment.cohortId))
      .orderBy(lessons.position);
    return c.json({
      items: items.map((l) => ({ lessonId: l.id, title: l.title, order: l.position, hasReplay: l.replayAssetKey !== null })),
    });
  });

  return app;
}

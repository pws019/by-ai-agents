// 老师基础维护/导入 API：班期、课次、手工报名、进度导入。契约见 contracts/education/openapi.yaml
// 的 /teacher/cohorts、/teacher/lessons、/teacher/enrollments、/teacher/progress/import。
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { isUniqueViolation } from "../db/pgError.js";
import type { Db } from "../db/pool.js";
import { cohorts, courseVersions, enrollments, learningProgress, lessons, orders, policies, users } from "../db/schema.js";
import { errorJson } from "../http/errors.js";
import { toEnrollment, type EnrollmentRow } from "./me.js";

function toCohort(row: typeof cohorts.$inferSelect) {
  return {
    cohortId: row.id,
    courseId: row.courseId,
    courseVersionId: row.courseVersionId,
    name: row.name,
    startAt: row.startAt,
    priceCents: row.priceCents, // bigint 列，schema 里已声明 mode:'number'，这里不用再手动 Number() 转换
    currency: row.currency,
    status: row.status,
    isCurrentSale: row.isCurrentSale,
  };
}

function toLesson(row: typeof lessons.$inferSelect) {
  return { lessonId: row.id, title: row.title, order: row.position, hasReplay: row.replayAssetKey !== null };
}

export function createTeacherRoutes(db: Db): Hono {
  const app = new Hono();
  // 这一行是整份文件唯一的权限入口：所有 /teacher/* 路由先登录、再校验角色，
  // 具体每个 handler 不用重复写这两行判断。
  app.use("/teacher/*", requireAuth, requireRole("teacher"));

  // POST /teacher/cohorts —— 创建班期。courseVersionId 必须真的属于 courseId（不只是存在），
  // 否则会挂出一个版本归属和课程对不上的班期。
  app.post("/teacher/cohorts", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.courseId !== "string" || typeof body.courseVersionId !== "string" || !body.name || !body.status) {
      return errorJson(c, 422, "VALIDATION_ERROR", "courseId/courseVersionId/name/status 必填");
    }

    const [courseVersion] = await db
      .select({ id: courseVersions.id })
      .from(courseVersions)
      .where(and(eq(courseVersions.id, body.courseVersionId), eq(courseVersions.courseId, body.courseId)));
    if (!courseVersion) return errorJson(c, 404, "NOT_FOUND", "课程或课程版本不存在，或版本不属于该课程");

    try {
      const [row] = await db
        .insert(cohorts)
        .values({
          courseId: body.courseId,
          courseVersionId: body.courseVersionId,
          name: body.name,
          startAt: body.startAt ?? null,
          priceCents: body.priceCents ?? null,
          currency: body.currency ?? "CNY",
          status: body.status,
          isCurrentSale: body.isCurrentSale ?? false,
        })
        .returning();
      return c.json(toCohort(row!), 201);
    } catch (err) {
      if (isUniqueViolation(err)) return errorJson(c, 422, "VALIDATION_ERROR", "该课程已有当期在售班期");
      throw err;
    }
  });

  // PATCH /teacher/cohorts/:cohortId —— 部分更新（名称/开课时间/价格/状态/是否当期在售）。
  // 只把请求里真的带了的字段拼进 SET，没提到的字段保持原值不动。
  app.patch("/teacher/cohorts/:cohortId", async (c) => {
    const cohortId = c.req.param("cohortId");
    const body = await c.req.json().catch(() => null);
    const fields: Partial<typeof cohorts.$inferInsert> = {
      name: body?.name,
      startAt: body?.startAt,
      priceCents: body?.priceCents,
      status: body?.status,
      isCurrentSale: body?.isCurrentSale,
    };
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      if (fields[key] === undefined) delete fields[key];
    }
    if (Object.keys(fields).length === 0) return errorJson(c, 422, "VALIDATION_ERROR", "至少提供一个要修改的字段");

    try {
      const [row] = await db.update(cohorts).set(fields).where(eq(cohorts.id, cohortId)).returning();
      if (!row) return errorJson(c, 404, "NOT_FOUND", "班期不存在");
      return c.json(toCohort(row));
    } catch (err) {
      if (isUniqueViolation(err)) return errorJson(c, 422, "VALIDATION_ERROR", "该课程已有当期在售班期");
      throw err;
    }
  });

  // POST /teacher/lessons —— 在某个班期下新建一节课。同一班期内 position 不能重复
  // （数据库唯一约束兜底，冲突时翻译成 422）。
  app.post("/teacher/lessons", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.cohortId !== "string" || !body.title || !Number.isInteger(body.position)) {
      return errorJson(c, 422, "VALIDATION_ERROR", "cohortId/title/position 必填");
    }

    const [cohort] = await db.select({ id: cohorts.id }).from(cohorts).where(eq(cohorts.id, body.cohortId));
    if (!cohort) return errorJson(c, 404, "NOT_FOUND", "班期不存在");

    try {
      const [row] = await db
        .insert(lessons)
        .values({ cohortId: body.cohortId, title: body.title, position: body.position, replayAssetKey: body.replayAssetKey ?? null })
        .returning();
      return c.json(toLesson(row!), 201);
    } catch (err) {
      if (isUniqueViolation(err)) return errorJson(c, 422, "VALIDATION_ERROR", "该班期下已有相同顺序的课次");
      throw err;
    }
  });

  // PATCH /teacher/lessons/:lessonId —— 部分更新课次标题/顺序/回放地址，规则和上面的
  // cohorts PATCH 一样：只改请求里出现的字段。
  app.patch("/teacher/lessons/:lessonId", async (c) => {
    const lessonId = c.req.param("lessonId");
    const body = await c.req.json().catch(() => null);
    const fields: Partial<typeof lessons.$inferInsert> = {
      title: body?.title,
      position: body?.position,
      replayAssetKey: body?.replayAssetKey,
    };
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      if (fields[key] === undefined) delete fields[key];
    }
    if (Object.keys(fields).length === 0) return errorJson(c, 422, "VALIDATION_ERROR", "至少提供一个要修改的字段");

    try {
      const [row] = await db.update(lessons).set(fields).where(eq(lessons.id, lessonId)).returning();
      if (!row) return errorJson(c, 404, "NOT_FOUND", "课次不存在");
      return c.json(toLesson(row));
    } catch (err) {
      if (isUniqueViolation(err)) return errorJson(c, 422, "VALIDATION_ERROR", "该班期下已有相同顺序的课次");
      throw err;
    }
  });

  // POST /teacher/enrollments —— 老师手工登记报名（线下收款、非标准支付场景），一次事务里
  // 同时建一条 source=manual 的订单和一条报名，不是只建报名而缺订单。
  app.post("/teacher/enrollments", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.studentId !== "string" || typeof body.cohortId !== "string" || typeof body.policyId !== "string" || !Number.isInteger(body.paidCents)) {
      return errorJson(c, 422, "VALIDATION_ERROR", "studentId/cohortId/policyId/paidCents 必填");
    }

    const [student] = await db.select({ role: users.role }).from(users).where(eq(users.id, body.studentId));
    if (!student) return errorJson(c, 404, "NOT_FOUND", "学员不存在");
    if (student.role !== "student") return errorJson(c, 422, "VALIDATION_ERROR", "studentId 对应的账号不是学员角色");

    const [cohort] = await db.select({ id: cohorts.id }).from(cohorts).where(eq(cohorts.id, body.cohortId));
    if (!cohort) return errorJson(c, 404, "NOT_FOUND", "班期不存在");
    const [policy] = await db.select({ id: policies.id, version: policies.version }).from(policies).where(eq(policies.id, body.policyId));
    if (!policy) return errorJson(c, 404, "NOT_FOUND", "政策不存在");

    const enrollment = await db.transaction(async (tx) => {
      const [order] = await tx
        .insert(orders)
        .values({ studentId: body.studentId, cohortId: body.cohortId, policyId: body.policyId, paidCents: body.paidCents, source: "manual" })
        .returning({ id: orders.id });
      const [inserted] = await tx
        .insert(enrollments)
        .values({ studentId: body.studentId, orderId: order!.id, cohortId: body.cohortId, status: "active" })
        .returning();
      const [cohortDetail] = await tx.select({ name: cohorts.name, startAt: cohorts.startAt }).from(cohorts).where(eq(cohorts.id, body.cohortId));
      const row: EnrollmentRow = {
        id: inserted!.id,
        status: inserted!.status,
        revision: inserted!.revision,
        cohortId: body.cohortId,
        name: cohortDetail!.name,
        startAt: cohortDetail!.startAt,
        policyVersion: policy.version,
      };
      return row;
    });
    return c.json(toEnrollment(enrollment), 201);
  });

  // POST /teacher/progress/import —— 批量录入学习进度。逐条独立校验和写入，一条不合法
  // （课次不存在/学员没报名这个班期）不会拖累同批次里其它合法条目；结果按 applied/rejected
  // 分开报告，调用方能知道具体是哪几条、为什么被拒绝。
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

      const [lesson] = await db.select({ cohortId: lessons.cohortId }).from(lessons).where(eq(lessons.id, lessonId));
      if (!lesson) {
        rejected.push({ studentId, lessonId, reason: "课次不存在" });
        continue;
      }

      // 只允许给真的在这个班期报名的学员录入进度，不能凭一个 studentId 就无中生有地建记录。
      const [enrollment] = await db
        .select({ id: enrollments.id })
        .from(enrollments)
        .where(and(eq(enrollments.studentId, studentId), eq(enrollments.cohortId, lesson.cohortId), eq(enrollments.status, "active")));
      if (!enrollment) {
        rejected.push({ studentId, lessonId, reason: "该学员未在此课次所属班期报名" });
        continue;
      }

      await db
        .insert(learningProgress)
        .values({ studentId, lessonId, status: status as "not_started" | "in_progress" | "completed", source: "import" })
        .onConflictDoUpdate({
          target: [learningProgress.studentId, learningProgress.lessonId],
          set: { status: status as "not_started" | "in_progress" | "completed", source: "import" },
        });
      applied++;
    }

    return c.json({ applied, rejected });
  });

  return app;
}

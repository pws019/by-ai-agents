// GET /catalog/current —— 公开，不需要登录。契约要求"未发布的价格/日期为 null，不得猜测"，
// 这里的做法是：不存在当期在售班期时直接 404，不是拼一个假数据出来。
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/pool.js";
import { cohorts, courses, courseVersions } from "../db/schema.js";
import { errorJson } from "../http/errors.js";

export function createCatalogRoutes(db: Db): Hono {
  const app = new Hono();

  app.get("/catalog/current", async (c) => {
    const [row] = await db
      .select({
        cohortId: cohorts.id,
        title: courses.title,
        version: courseVersions.version,
        startAt: cohorts.startAt,
        priceCents: cohorts.priceCents, // bigint 列，schema 里已声明 mode:'number'，这里不用再手动 Number() 转换
        currency: cohorts.currency,
      })
      .from(cohorts)
      .innerJoin(courses, eq(courses.id, cohorts.courseId))
      .innerJoin(courseVersions, eq(courseVersions.id, cohorts.courseVersionId))
      .where(eq(cohorts.isCurrentSale, true))
      .orderBy(sql`${cohorts.startAt} asc nulls last`)
      .limit(1);
    if (!row) return errorJson(c, 404, "NOT_FOUND", "暂无当前招生期");

    return c.json({
      cohortId: row.cohortId,
      title: row.title,
      version: row.version,
      startAt: row.startAt,
      priceCents: row.priceCents,
      currency: row.currency,
      // publicFacts 没有对应的数据来源（数据库里没有营销文案字段），不编造内容，固定返回空数组。
      // 见 progress.md T-09 设计决定。
      publicFacts: [],
    });
  });

  return app;
}

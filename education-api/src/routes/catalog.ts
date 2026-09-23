// GET /catalog/current —— 公开，不需要登录。契约要求"未发布的价格/日期为 null，不得猜测"，
// 这里的做法是：不存在当期在售班期时直接 404，不是拼一个假数据出来。
import { Hono } from "hono";
import type pg from "pg";
import { errorJson } from "../http/errors.js";

interface CurrentOfferingRow {
  cohort_id: string;
  title: string;
  version: number;
  start_at: Date | null;
  price_cents: string | null; // pg 把 bigint 序列化成字符串，避免超出 JS number 精度时静默出错
  currency: string;
}

export function createCatalogRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

  app.get("/catalog/current", async (c) => {
    const { rows } = await pool.query<CurrentOfferingRow>(
      `SELECT c.id AS cohort_id, co.title, cv.version, c.start_at, c.price_cents, c.currency
       FROM cohorts c
       JOIN courses co ON co.id = c.course_id
       JOIN course_versions cv ON cv.id = c.course_version_id
       WHERE c.is_current_sale = true
       ORDER BY c.start_at ASC NULLS LAST
       LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return errorJson(c, 404, "NOT_FOUND", "暂无当前招生期");

    return c.json({
      cohortId: row.cohort_id,
      title: row.title,
      version: row.version,
      startAt: row.start_at,
      priceCents: row.price_cents === null ? null : Number(row.price_cents),
      currency: row.currency,
      // publicFacts 没有对应的数据来源（数据库里没有营销文案字段），不编造内容，固定返回空数组。
      // 见 progress.md T-09 设计决定。
      publicFacts: [],
    });
  });

  return app;
}

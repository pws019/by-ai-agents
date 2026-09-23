import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "../app.js";
import { DATABASE_URL } from "../db/config.js";
import { migrate } from "../db/migrate.js";
import { createPool } from "../db/pool.js";

const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));
const withDb = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
};

/** 每个用例各自一个全新库：/catalog/current 全局只挑一条记录，用例之间不能互相污染"当期在售"的候选集合。 */
async function withFreshApp<T>(fn: (ctx: { pool: pg.Pool; app: ReturnType<typeof createApp> }) => Promise<T>): Promise<T> {
  const dbName = `edu_test_${randomBytes(4).toString("hex")}`;
  const testUrl = withDb(dbName);
  const admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl, migrationsDir);
  const pool = createPool(testUrl);
  try {
    return await fn({ pool, app: createApp(pool, { allowedOrigin: "http://localhost:5173" }) });
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
}

const id = async (pool: pg.Pool, sql: string, params: unknown[] = []) =>
  (await pool.query<{ id: string }>(sql, params)).rows[0]!.id;

describe("GET /catalog/current", () => {
  test("没有任何当期在售班期：404，不编造数据", () =>
    withFreshApp(async ({ app }) => {
      const res = await app.request("/api/v1/catalog/current");
      assert.equal(res.status, 404);
    }));

  test("有当期在售班期：返回课程标题（不是班期名）、版本号、价格；不需要登录", () =>
    withFreshApp(async ({ pool, app }) => {
      const courseId = await id(pool, "INSERT INTO courses (title) VALUES ('合成课程标题') RETURNING id");
      const versionId = await id(pool, "INSERT INTO course_versions (course_id, version) VALUES ($1, 3) RETURNING id", [courseId]);
      const cohortId = await id(
        pool,
        `INSERT INTO cohorts (course_id, course_version_id, name, currency, status, is_current_sale, price_cents)
         VALUES ($1,$2,'班期名字（不该出现在响应里）','CNY','running', true, 88800) RETURNING id`,
        [courseId, versionId],
      );

      const res = await app.request("/api/v1/catalog/current");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.cohortId, cohortId);
      assert.equal(body.title, "合成课程标题");
      assert.equal(body.version, 3);
      assert.equal(body.priceCents, 88800);
      assert.equal(body.currency, "CNY");
      assert.deepEqual(body.publicFacts, []);
    }));

  test("未发布的价格/日期为 null，不猜测", () =>
    withFreshApp(async ({ pool, app }) => {
      const courseId = await id(pool, "INSERT INTO courses (title) VALUES ('未定价课程') RETURNING id");
      const versionId = await id(pool, "INSERT INTO course_versions (course_id, version) VALUES ($1, 1) RETURNING id", [courseId]);
      await pool.query(
        `INSERT INTO cohorts (course_id, course_version_id, name, currency, status, is_current_sale, price_cents, start_at)
         VALUES ($1,$2,'预告班','CNY','upcoming', true, NULL, NULL)`,
        [courseId, versionId],
      );

      const res = await app.request("/api/v1/catalog/current");
      const body = await res.json();
      assert.equal(body.priceCents, null);
      assert.equal(body.startAt, null);
    }));
});

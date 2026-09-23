import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "../app.js";
import { createSession } from "../auth/session.js";
import { DATABASE_URL } from "../db/config.js";
import { migrate } from "../db/migrate.js";
import { createPool } from "../db/pool.js";

const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));
const dbName = `edu_test_${randomBytes(4).toString("hex")}`;
const withDb = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
};
const testUrl = withDb(dbName);
const ORIGIN = "http://localhost:5173";

let admin: pg.Client;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;

const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
const id = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;

let studentAId: string;
let studentACookie: string;
let studentBCookie: string;
let enrollmentId: string;
let currentCohortId: string;
let upcomingTargetId: string;
let endedCohortId: string;
let otherCourseCohortId: string;

before(async () => {
  admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl, migrationsDir);
  pool = createPool(testUrl);
  app = createApp(pool, { allowedOrigin: ORIGIN });

  studentAId = await id(
    "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('a','x','A','student') RETURNING id",
  );
  const studentBId = await id(
    "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('b','x','B','student') RETURNING id",
  );
  studentACookie = `edu_session=${(await createSession(pool, studentAId)).token}`;
  studentBCookie = `edu_session=${(await createSession(pool, studentBId)).token}`;

  const courseId = await id("INSERT INTO courses (title) VALUES ('课程') RETURNING id");
  const versionId = await id("INSERT INTO course_versions (course_id, version) VALUES ($1,1) RETURNING id", [courseId]);
  currentCohortId = await id(
    "INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'当前班','CNY','running') RETURNING id",
    [courseId, versionId],
  );
  upcomingTargetId = await id(
    "INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'预告班','CNY','upcoming') RETURNING id",
    [courseId, versionId],
  );
  endedCohortId = await id(
    "INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'历史班','CNY','ended') RETURNING id",
    [courseId, versionId],
  );

  const otherCourseId = await id("INSERT INTO courses (title) VALUES ('另一门课') RETURNING id");
  const otherVersionId = await id("INSERT INTO course_versions (course_id, version) VALUES ($1,1) RETURNING id", [otherCourseId]);
  otherCourseCohortId = await id(
    "INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'别的课程的班','CNY','upcoming') RETURNING id",
    [otherCourseId, otherVersionId],
  );

  const policyId = await id("INSERT INTO policies (version, text) VALUES (1,'政策') RETURNING id");
  const orderId = await id(
    "INSERT INTO orders (student_id, cohort_id, policy_id, paid_cents, source) VALUES ($1,$2,$3,100000,'seed') RETURNING id",
    [studentAId, currentCohortId, policyId],
  );
  enrollmentId = await id(
    "INSERT INTO enrollments (student_id, order_id, cohort_id, status) VALUES ($1,$2,$3,'active') RETURNING id",
    [studentAId, orderId, currentCohortId],
  );
});

after(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const get = (path: string, cookie?: string) => app.request(`/api/v1${path}`, { headers: cookie ? { Cookie: cookie } : {} });

describe("GET /cohorts/transfer-targets", () => {
  test("没登录：401", async () => {
    assert.equal((await get(`/cohorts/transfer-targets?enrollmentId=${enrollmentId}`)).status, 401);
  });

  test("缺 enrollmentId：422", async () => {
    assert.equal((await get("/cohorts/transfer-targets", studentACookie)).status, 422);
  });

  test("别人的报名：404", async () => {
    assert.equal((await get(`/cohorts/transfer-targets?enrollmentId=${enrollmentId}`, studentBCookie)).status, 404);
  });

  test("只返回同课程、非当前、未结束的班期：排除自己、排除已结束、排除别的课程", async () => {
    const res = await get(`/cohorts/transfer-targets?enrollmentId=${enrollmentId}`, studentACookie);
    assert.equal(res.status, 200);
    const body = await res.json();
    // 期望恰好是 [upcomingTargetId]：这一条断言本身就排除了 endedCohortId（已结束）
    // 和 otherCourseCohortId（别的课程），不需要额外断言它们"不存在"。
    assert.deepEqual(
      body.items.map((i: { cohortId: string }) => i.cohortId),
      [upcomingTargetId],
    );
  });
});

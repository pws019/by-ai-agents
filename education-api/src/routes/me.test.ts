// T-08 授权练习的验收规格：GET /me/enrollments/:id/progress
// 先写测试再实现——这份文件描述"应该发生什么"，routes/me.ts 里的实现要让它变绿。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { createSession } from "../auth/session.js";
import { DATABASE_URL } from "../db/config.js";
import { migrate } from "../db/migrate.js";
import { createDb, createPool } from "../db/pool.js";
import { dropTestDatabase } from "../testing/db.js";

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
let db: ReturnType<typeof createDb>;
let app: ReturnType<typeof createApp>;

// 两个学员，各自一条报名、两节课（一节有回放、一节没有）。用来验证"我的"和"别人的"的边界。
type Student = { id: string; enrollmentId: string; lessonId: string; lessonId2: string; cookie: string };
let studentA: Student;
let studentB: Student;

let policyVersionCounter = 0;

async function setupStudent(loginName: string): Promise<Omit<Student, "cookie">> {
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    pool.query<T>(sql, params);
  const id = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;

  const studentId = await id(
    "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ($1,'x','测试学员','student') RETURNING id",
    [loginName],
  );
  const courseId = await id("INSERT INTO courses (title) VALUES ('合成课程') RETURNING id");
  const versionId = await id("INSERT INTO course_versions (course_id, version) VALUES ($1,1) RETURNING id", [courseId]);
  const cohortId = await id(
    "INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'合成班期','CNY','running') RETURNING id",
    [courseId, versionId],
  );
  const lessonId = await id("INSERT INTO lessons (cohort_id, title, position) VALUES ($1,'第 1 课',1) RETURNING id", [cohortId]);
  const lessonId2 = await id(
    "INSERT INTO lessons (cohort_id, title, position, replay_asset_key) VALUES ($1,'第 2 课',2,'replay/x.mp4') RETURNING id",
    [cohortId],
  );
  // policies.version 全局唯一，每个学员各自的课程/班期不共用同一个 policy，版本号要错开
  const policyId = await id("INSERT INTO policies (version, text) VALUES ($1,'合成政策') RETURNING id", [++policyVersionCounter]);
  const orderId = await id(
    "INSERT INTO orders (student_id, cohort_id, policy_id, paid_cents, source) VALUES ($1,$2,$3,100000,'seed') RETURNING id",
    [studentId, cohortId, policyId],
  );
  const enrollmentId = await id(
    "INSERT INTO enrollments (student_id, order_id, cohort_id, status) VALUES ($1,$2,$3,'active') RETURNING id",
    [studentId, orderId, cohortId],
  );
  await q("INSERT INTO learning_progress (student_id, lesson_id, status, source) VALUES ($1,$2,'in_progress','manual')", [
    studentId,
    lessonId,
  ]);
  return { id: studentId, enrollmentId, lessonId, lessonId2 };
}

async function loginCookie(userId: string): Promise<string> {
  const { token } = await createSession(db, userId);
  return `edu_session=${token}`;
}

before(async () => {
  admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl, migrationsDir);
  pool = createPool(testUrl);
  db = createDb(pool);
  app = createApp(pool, { allowedOrigin: ORIGIN });

  const a = await setupStudent("student.a");
  const b = await setupStudent("student.b");
  studentA = { ...a, cookie: await loginCookie(a.id) };
  studentB = { ...b, cookie: await loginCookie(b.id) };
});

after(async () => {
  await pool.end();
  await dropTestDatabase(admin, dbName);
  await admin.end();
});

const get = (path: string, cookie?: string) =>
  app.request(`/api/v1${path}`, { headers: cookie ? { Cookie: cookie } : {} });

describe("GET /me/enrollments/:id/progress —— 资源级授权", () => {
  test("没登录：401", async () => {
    const res = await get(`/me/enrollments/${studentA.enrollmentId}/progress`);
    assert.equal(res.status, 401);
  });

  test("访问自己的报名：200，能看到自己的进度记录", async () => {
    const res = await get(`/me/enrollments/${studentA.enrollmentId}/progress`, studentA.cookie);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, [{ lessonId: studentA.lessonId, status: "in_progress", source: "manual" }]);
  });

  test("用别人的报名 id：404（不是 403——不能让人靠状态码探测这个 id 是否存在）", async () => {
    const res = await get(`/me/enrollments/${studentA.enrollmentId}/progress`, studentB.cookie);
    assert.equal(res.status, 404);
  });

  test("随便编一个不存在的 id：也是 404，和别人报名的 404 状态码、错误码完全一样", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000fff";
    const forOther = await get(`/me/enrollments/${studentA.enrollmentId}/progress`, studentB.cookie);
    const forFake = await get(`/me/enrollments/${fakeId}/progress`, studentB.cookie);
    assert.equal(forFake.status, 404);
    const [a, b] = [await forOther.json(), await forFake.json()];
    assert.equal(a.error.code, b.error.code);
    assert.equal(a.error.message, b.error.message); // requestId 各请求不同，不比较它
  });
});

describe("GET /me/enrollments", () => {
  test("没登录：401", async () => {
    assert.equal((await get("/me/enrollments")).status, 401);
  });

  test("只看到自己的报名，字段齐全", async () => {
    const res = await get("/me/enrollments", studentA.cookie);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 1);
    const item = body.items[0];
    assert.equal(item.enrollmentId, studentA.enrollmentId);
    assert.equal(item.status, "active");
    assert.equal(item.revision, 1);
    assert.equal(typeof item.policyVersion, "number");
    assert.equal(item.cohort.name, "合成班期");
  });
});

describe("GET /me/enrollments/:id/schedule", () => {
  test("没登录：401", async () => {
    assert.equal((await get(`/me/enrollments/${studentA.enrollmentId}/schedule`)).status, 401);
  });

  test("自己的报名：按 position 排序，hasReplay 反映是否有回放", async () => {
    const res = await get(`/me/enrollments/${studentA.enrollmentId}/schedule`, studentA.cookie);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, [
      { lessonId: studentA.lessonId, title: "第 1 课", order: 1, hasReplay: false },
      { lessonId: studentA.lessonId2, title: "第 2 课", order: 2, hasReplay: true },
    ]);
  });

  test("别人的报名 id：404", async () => {
    const res = await get(`/me/enrollments/${studentA.enrollmentId}/schedule`, studentB.cookie);
    assert.equal(res.status, 404);
  });
});

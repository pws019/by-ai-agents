import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "../app.js";
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

const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
const id = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;

let teacherCookie: string;
let studentCookie: string;
let studentId: string;
let courseId: string;
let versionId: string;
let cohortId: string;
let policyId: string;

before(async () => {
  admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl, migrationsDir);
  pool = createPool(testUrl);
  db = createDb(pool);
  app = createApp(pool, { allowedOrigin: ORIGIN });

  const teacherId = await id(
    "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('t','x','老师','teacher') RETURNING id",
  );
  studentId = await id(
    "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s','x','学员','student') RETURNING id",
  );
  teacherCookie = `edu_session=${(await createSession(db, teacherId)).token}`;
  studentCookie = `edu_session=${(await createSession(db, studentId)).token}`;

  courseId = await id("INSERT INTO courses (title) VALUES ('课程') RETURNING id");
  versionId = await id("INSERT INTO course_versions (course_id, version) VALUES ($1,1) RETURNING id", [courseId]);
  cohortId = await id(
    "INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'班期','CNY','running') RETURNING id",
    [courseId, versionId],
  );
  policyId = await id("INSERT INTO policies (version, text) VALUES (1,'政策') RETURNING id");
});

after(async () => {
  await pool.end();
  await dropTestDatabase(admin, dbName);
  await admin.end();
});

const post = (path: string, body: unknown, cookie?: string) =>
  app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
const patch = (path: string, body: unknown, cookie?: string) =>
  app.request(`/api/v1${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
const get = (path: string, cookie?: string) =>
  app.request(`/api/v1${path}`, { headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) } });

describe("角色权限：学员访问老师端点", () => {
  test("学员 POST /teacher/cohorts：403", async () => {
    const res = await post("/teacher/cohorts", { courseId, courseVersionId: versionId, name: "x", currency: "CNY", status: "upcoming" }, studentCookie);
    assert.equal(res.status, 403);
  });

  test("没登录：401（先认证后授权，不是 403）", async () => {
    const res = await post("/teacher/cohorts", {}, undefined);
    assert.equal(res.status, 401);
  });
});

describe("POST /teacher/cohorts", () => {
  test("courseVersionId 不属于 courseId：404", async () => {
    const otherCourseId = await id("INSERT INTO courses (title) VALUES ('另一门课') RETURNING id");
    const res = await post(
      "/teacher/cohorts",
      { courseId: otherCourseId, courseVersionId: versionId, name: "错配", currency: "CNY", status: "upcoming" },
      teacherCookie,
    );
    assert.equal(res.status, 404);
  });

  test("正常创建；同课程第二次设 isCurrentSale=true 冲突返回 422", async () => {
    const first = await post(
      "/teacher/cohorts",
      { courseId, courseVersionId: versionId, name: "新班期1", currency: "CNY", status: "running", isCurrentSale: true, priceCents: 50000 },
      teacherCookie,
    );
    assert.equal(first.status, 201);
    const body = await first.json();
    assert.equal(body.name, "新班期1");
    assert.equal(body.priceCents, 50000);
    assert.equal(body.isCurrentSale, true);

    const second = await post(
      "/teacher/cohorts",
      { courseId, courseVersionId: versionId, name: "新班期2", currency: "CNY", status: "upcoming", isCurrentSale: true },
      teacherCookie,
    );
    assert.equal(second.status, 422);
  });
});

describe("PATCH /teacher/cohorts/:id", () => {
  test("不存在的班期：404", async () => {
    const res = await patch("/teacher/cohorts/00000000-0000-0000-0000-000000000fff", { status: "ended" }, teacherCookie);
    assert.equal(res.status, 404);
  });

  test("空 body：422", async () => {
    const res = await patch(`/teacher/cohorts/${cohortId}`, {}, teacherCookie);
    assert.equal(res.status, 422);
  });

  test("正常更新单个字段", async () => {
    const res = await patch(`/teacher/cohorts/${cohortId}`, { status: "ended" }, teacherCookie);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ended");
  });
});

describe("POST /teacher/lessons 与 PATCH", () => {
  test("班期不存在：404", async () => {
    const res = await post("/teacher/lessons", { cohortId: "00000000-0000-0000-0000-000000000fff", title: "x", position: 1 }, teacherCookie);
    assert.equal(res.status, 404);
  });

  test("正常创建；同班期同 position 冲突返回 422", async () => {
    const first = await post("/teacher/lessons", { cohortId, title: "第 1 课", position: 1 }, teacherCookie);
    assert.equal(first.status, 201);
    const lessonId = (await first.json()).lessonId;

    const dup = await post("/teacher/lessons", { cohortId, title: "重复", position: 1 }, teacherCookie);
    assert.equal(dup.status, 422);

    const updated = await patch(`/teacher/lessons/${lessonId}`, { replayAssetKey: "r.mp4" }, teacherCookie);
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).hasReplay, true);
  });
});

describe("POST /teacher/enrollments", () => {
  test("studentId 对应老师账号：422", async () => {
    const teacherAsStudentId = await id(
      "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('t2','x','老师2','teacher') RETURNING id",
    );
    const res = await post("/teacher/enrollments", { studentId: teacherAsStudentId, cohortId, policyId, paidCents: 1000 }, teacherCookie);
    assert.equal(res.status, 422);
  });

  test("正常创建：生成 source=manual 的订单和 active 报名", async () => {
    const res = await post("/teacher/enrollments", { studentId, cohortId, policyId, paidCents: 88800 }, teacherCookie);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, "active");

    const { rows } = await q<{ source: string }>("SELECT source FROM orders WHERE id = (SELECT order_id FROM enrollments WHERE id = $1)", [
      body.enrollmentId,
    ]);
    assert.equal(rows[0]!.source, "manual");
  });
});

describe("GET /teacher/cohorts/transfer-targets", () => {
  test("学员访问：403", async () => {
    const res = await get(`/teacher/cohorts/transfer-targets?enrollmentId=00000000-0000-4000-8000-000000000000`, studentCookie);
    assert.equal(res.status, 403);
  });

  test("查不属于自己（老师本来就没有'自己的报名'）的报名也能查到：跟学员版的权限判断不一样", async () => {
    const otherCohortId = await id(
      "INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'另一个班期','CNY','upcoming') RETURNING id",
      [courseId, versionId],
    );
    const enrollRes = await post("/teacher/enrollments", { studentId, cohortId, policyId, paidCents: 88800 }, teacherCookie);
    const enrollmentId = (await enrollRes.json()).enrollmentId;

    const res = await get(`/teacher/cohorts/transfer-targets?enrollmentId=${enrollmentId}`, teacherCookie);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.items.some((c: { cohortId: string }) => c.cohortId === otherCohortId), "同课程、未结束、非当前班期应该出现在候选里");
    assert.ok(!body.items.some((c: { cohortId: string }) => c.cohortId === cohortId), "当前正在读的班期不该出现在自己的候选目标里");
  });

  test("报名不存在：404", async () => {
    const res = await get(`/teacher/cohorts/transfer-targets?enrollmentId=00000000-0000-4000-8000-000000000000`, teacherCookie);
    assert.equal(res.status, 404);
  });
});

describe("POST /teacher/progress/import", () => {
  test("部分成功：未报名的学员被拒绝，已报名的正常写入", async () => {
    const otherStudentId = await id(
      "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s2','x','学员2','student') RETURNING id",
    );
    const lessonId = await id("INSERT INTO lessons (cohort_id, title, position) VALUES ($1,'第 2 课',2) RETURNING id", [cohortId]);

    const res = await post(
      "/teacher/progress/import",
      { items: [{ studentId, lessonId, status: "completed" }, { studentId: otherStudentId, lessonId, status: "completed" }] },
      teacherCookie,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.applied, 1);
    assert.equal(body.rejected.length, 1);
    assert.equal(body.rejected[0].studentId, otherStudentId);

    const { rows } = await q<{ status: string; source: string }>(
      "SELECT status, source FROM learning_progress WHERE student_id = $1 AND lesson_id = $2",
      [studentId, lessonId],
    );
    assert.deepEqual(rows[0], { status: "completed", source: "import" });
  });
});

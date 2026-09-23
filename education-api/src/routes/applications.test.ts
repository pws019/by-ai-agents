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

let teacherCookie: string;
let studentCookie: string;
let otherStudentCookie: string;
let studentId: string;
let cohortId: string;
let otherCohortId: string;
let policyId: string;
let enrollmentId: string;

/** 独立的一条报名：申请每个 enrollment+type 只允许一张未结束的，需要相互隔离状态的用例各开一条。 */
async function createFreshEnrollment(): Promise<string> {
  const orderId = await id(
    "INSERT INTO orders (student_id, cohort_id, policy_id, paid_cents, source) VALUES ($1,$2,$3,88800,'seed') RETURNING id",
    [studentId, cohortId, policyId],
  );
  return id("INSERT INTO enrollments (student_id, order_id, cohort_id, status) VALUES ($1,$2,$3,'active') RETURNING id", [
    studentId,
    orderId,
    cohortId,
  ]);
}

before(async () => {
  admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl, migrationsDir);
  pool = createPool(testUrl);
  app = createApp(pool, { allowedOrigin: ORIGIN });

  const teacherId = await id(
    "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('t','x','老师','teacher') RETURNING id",
  );
  studentId = await id(
    "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s','x','学员','student') RETURNING id",
  );
  const otherStudentId = await id(
    "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s2','x','学员2','student') RETURNING id",
  );
  teacherCookie = `edu_session=${(await createSession(pool, teacherId)).token}`;
  studentCookie = `edu_session=${(await createSession(pool, studentId)).token}`;
  otherStudentCookie = `edu_session=${(await createSession(pool, otherStudentId)).token}`;

  const courseId = await id("INSERT INTO courses (title) VALUES ('课程') RETURNING id");
  const versionId = await id("INSERT INTO course_versions (course_id, version) VALUES ($1,1) RETURNING id", [courseId]);
  cohortId = await id(
    "INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'班期1','CNY','running') RETURNING id",
    [courseId, versionId],
  );
  otherCohortId = await id(
    "INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'班期2','CNY','upcoming') RETURNING id",
    [courseId, versionId],
  );
  policyId = await id("INSERT INTO policies (version, text) VALUES (1,'政策') RETURNING id");
  const orderId = await id(
    "INSERT INTO orders (student_id, cohort_id, policy_id, paid_cents, source) VALUES ($1,$2,$3,88800,'seed') RETURNING id",
    [studentId, cohortId, policyId],
  );
  enrollmentId = await id(
    "INSERT INTO enrollments (student_id, order_id, cohort_id, status) VALUES ($1,$2,$3,'active') RETURNING id",
    [studentId, orderId, cohortId],
  );
});

after(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const req = (method: string, path: string, body: unknown, cookie?: string, extraHeaders?: Record<string, string>) =>
  app.request(`/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const post = (path: string, body: unknown, cookie?: string, extraHeaders?: Record<string, string>) =>
  req("POST", path, body, cookie, extraHeaders);
const patch = (path: string, body: unknown, cookie?: string) => req("PATCH", path, body, cookie);
const get = (path: string, cookie?: string) => req("GET", path, undefined, cookie);

describe("POST /applications/drafts", () => {
  test("没登录：401", async () => {
    const res = await post("/applications/drafts", { type: "transfer", enrollmentId, reason: "冲突" });
    assert.equal(res.status, 401);
  });

  test("enrollmentId 不属于当前学员：404", async () => {
    const res = await post("/applications/drafts", { type: "transfer", enrollmentId, reason: "冲突" }, otherStudentCookie);
    assert.equal(res.status, 404);
  });

  test("目标班期未知（targetCohortId 不给）：允许创建（AC-007）", async () => {
    const res = await post("/applications/drafts", { type: "transfer", enrollmentId, reason: "工作冲突" }, studentCookie);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, "draft");
    assert.equal(body.revision, 1);
    assert.equal(body.summary.targetCohortId, null);
    assert.ok(body.confirmation.confirmationId);
    assert.equal(body.confirmation.revision, 1);

    // 同一 enrollment/type 再次创建草稿：AC-006，返回同一个 id（还在 draft 阶段）
    const again = await post("/applications/drafts", { type: "transfer", enrollmentId, reason: "换个理由" }, studentCookie);
    assert.equal(again.status, 200);
    const againBody = await again.json();
    assert.equal(againBody.id, body.id);
  });

  test("已有一张 submitted 的同类型申请：再次创建 409", async () => {
    const draft = await post("/applications/drafts", { type: "refund", enrollmentId, reason: "想退费" }, studentCookie);
    const draftBody = await draft.json();
    await pool.query("UPDATE applications SET status = 'submitted' WHERE id = $1", [draftBody.id]);

    const res = await post("/applications/drafts", { type: "refund", enrollmentId, reason: "又想退费" }, studentCookie);
    assert.equal(res.status, 409);
  });
});

describe("PATCH /applications/:id/draft", () => {
  async function createDraft() {
    const freshEnrollmentId = await createFreshEnrollment();
    const res = await post(
      "/applications/drafts",
      { type: "transfer", enrollmentId: freshEnrollmentId, reason: "初始理由", targetCohortId: null },
      studentCookie,
    );
    return res.json();
  }

  test("正常编辑：revision +1，旧确认卡失效，签发新的", async () => {
    const draft = await createDraft();
    const res = await patch(
      `/applications/${draft.id}/draft`,
      { reason: "新理由", targetCohortId: otherCohortId, expectedRevision: draft.revision },
      studentCookie,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.revision, draft.revision + 1);
    assert.equal(body.summary.reason, "新理由");
    assert.notEqual(body.confirmation.confirmationId, draft.confirmation.confirmationId);

    const { rows } = await pool.query("SELECT revoked_at FROM confirmations WHERE id = $1", [draft.confirmation.confirmationId]);
    assert.ok(rows[0]!.revoked_at, "旧确认卡应该被标记撤销");
  });

  test("expectedRevision 对不上：409", async () => {
    const draft = await createDraft();
    const res = await patch(`/applications/${draft.id}/draft`, { reason: "x", expectedRevision: draft.revision + 1 }, studentCookie);
    assert.equal(res.status, 409);
  });

  test("不是本人的申请：404", async () => {
    const draft = await createDraft();
    const res = await patch(`/applications/${draft.id}/draft`, { reason: "x", expectedRevision: draft.revision }, otherStudentCookie);
    assert.equal(res.status, 404);
  });
});

describe("GET /me/applications、GET /applications/:id", () => {
  test("学员只能看到自己的申请列表；详情里有 events", async () => {
    const draft = await post("/applications/drafts", { type: "transfer", enrollmentId, reason: "看列表" }, studentCookie);
    const draftBody = await draft.json();

    const list = await get("/me/applications", studentCookie);
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.ok(listBody.items.some((a: { id: string }) => a.id === draftBody.id));

    const otherList = await get("/me/applications", otherStudentCookie);
    const otherListBody = await otherList.json();
    assert.ok(!otherListBody.items.some((a: { id: string }) => a.id === draftBody.id));

    const detail = await get(`/applications/${draftBody.id}`, studentCookie);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.ok(Array.isArray(detailBody.events));

    const teacherView = await get(`/applications/${draftBody.id}`, teacherCookie);
    assert.equal(teacherView.status, 200, "老师可以看任意申请详情");

    const strangerView = await get(`/applications/${draftBody.id}`, otherStudentCookie);
    assert.equal(strangerView.status, 404, "不是本人也不是老师：404，不暴露申请是否存在");
  });
});

// ---------------------------------------------------------------------------
// POST /applications/:id/confirm —— 学员手写练习。下面的用例描述了预期行为，
// 目前全部会失败（路由还是占位的 501）。实现见 applications.ts 里 confirm 那个
// handler 上方的大段注释，写完后这些用例应该全绿，不需要改用例本身。
// ---------------------------------------------------------------------------
describe("POST /applications/:id/confirm", () => {
  async function createDraft(type: "transfer" | "refund" = "transfer") {
    const freshEnrollmentId = await createFreshEnrollment();
    const res = await post("/applications/drafts", { type, enrollmentId: freshEnrollmentId, reason: "待确认" }, studentCookie);
    return res.json();
  }

  test("真并发：两个请求同时用同一张确认卡确认，恰好一个成功", async () => {
    const draft = await createDraft();
    const payload = { confirmationId: draft.confirmation.confirmationId, expectedRevision: draft.revision };

    const [a, b] = await Promise.all([
      post(`/applications/${draft.id}/confirm`, payload, studentCookie),
      post(`/applications/${draft.id}/confirm`, payload, studentCookie),
    ]);
    // 两个请求谁先跑到谁后跑到是调度决定的，不保证是"一个 200 一个 409"（后到的那个如果晚到
    // 已经能读到别人提交完的状态，走的是合法的幂等重放分支，也是 200）——两个都是 200 或 409
    // 都算正常；真正决定性的是下面这条：不管状态码组合是什么，"确认"这个业务动作只能真的执行一次。
    for (const status of [a.status, b.status]) assert.ok(status === 200 || status === 409, `意外状态码 ${status}`);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM application_events WHERE application_id = $1 AND event_type = 'submitted'",
      [draft.id],
    );
    assert.equal(rows[0]!.n, 1, "只应该有一条 submitted 审计事件，不能两个请求都执行了业务逻辑");
  });

  test("正常确认：状态变为 submitted，并写入一条 submitted 审计事件", async () => {
    const draft = await createDraft();
    const res = await post(
      `/applications/${draft.id}/confirm`,
      { confirmationId: draft.confirmation.confirmationId, expectedRevision: draft.revision },
      studentCookie,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "submitted");

    const { rows } = await pool.query(
      "SELECT event_type FROM application_events WHERE application_id = $1 ORDER BY created_at",
      [draft.id],
    );
    assert.ok(rows.some((r) => r.event_type === "submitted"));
  });

  test("重复调用同一个 confirmationId（幂等重放）：第二次也是 200，不报错", async () => {
    const draft = await createDraft();
    const payload = { confirmationId: draft.confirmation.confirmationId, expectedRevision: draft.revision };
    const first = await post(`/applications/${draft.id}/confirm`, payload, studentCookie);
    assert.equal(first.status, 200);

    const second = await post(`/applications/${draft.id}/confirm`, payload, studentCookie);
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.status, "submitted");
  });

  test("草稿被改过之后再用旧确认卡确认（AC-005）：409 STALE_CONFIRMATION", async () => {
    const draft = await createDraft();
    await patch(`/applications/${draft.id}/draft`, { reason: "改一下", expectedRevision: draft.revision }, studentCookie);

    const res = await post(
      `/applications/${draft.id}/confirm`,
      { confirmationId: draft.confirmation.confirmationId, expectedRevision: draft.revision },
      studentCookie,
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, "STALE_CONFIRMATION");
  });

  test("confirmationId 不存在：409 STALE_CONFIRMATION（不是 404，不暴露内部 id 是否存在）", async () => {
    const draft = await createDraft();
    const res = await post(
      `/applications/${draft.id}/confirm`,
      { confirmationId: "00000000-0000-0000-0000-000000000000", expectedRevision: draft.revision },
      studentCookie,
    );
    assert.equal(res.status, 409);
  });

  test("不是本人的申请：404", async () => {
    const draft = await createDraft();
    const res = await post(
      `/applications/${draft.id}/confirm`,
      { confirmationId: draft.confirmation.confirmationId, expectedRevision: draft.revision },
      otherStudentCookie,
    );
    assert.equal(res.status, 404);
  });

  test("带 Idempotency-Key 重试：不产生第二条 submitted 审计事件", async () => {
    const draft = await createDraft();
    const payload = { confirmationId: draft.confirmation.confirmationId, expectedRevision: draft.revision };
    const headers = { "Idempotency-Key": "confirm-retry-test-1" };

    const first = await post(`/applications/${draft.id}/confirm`, payload, studentCookie, headers);
    assert.equal(first.status, 200);
    const second = await post(`/applications/${draft.id}/confirm`, payload, studentCookie, headers);
    assert.equal(second.status, 200);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM application_events WHERE application_id = $1 AND event_type = 'submitted'",
      [draft.id],
    );
    assert.equal(rows[0]!.n, 1);
  });
});

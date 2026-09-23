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
  db = createDb(pool);
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
  teacherCookie = `edu_session=${(await createSession(db, teacherId)).token}`;
  studentCookie = `edu_session=${(await createSession(db, studentId)).token}`;
  otherStudentCookie = `edu_session=${(await createSession(db, otherStudentId)).token}`;

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

/** 建一条新报名、走完 draft→confirm，返回已经是 submitted 状态的申请（供 T-13 各用例做起点）。 */
async function submitApplication(
  type: "transfer" | "refund" = "transfer",
  reason = "T-13 用例起点",
  targetCohortId?: string,
): Promise<{ id: string; revision: number; enrollmentId: string }> {
  const freshEnrollmentId = await createFreshEnrollment();
  const draftRes = await post("/applications/drafts", { type, enrollmentId: freshEnrollmentId, reason, targetCohortId }, studentCookie);
  const draft = await draftRes.json();
  const confirmRes = await post(
    `/applications/${draft.id}/confirm`,
    { confirmationId: draft.confirmation.confirmationId, expectedRevision: draft.revision },
    studentCookie,
  );
  const submitted = await confirmRes.json();
  return { ...submitted, enrollmentId: freshEnrollmentId };
}

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

describe("POST /applications/:id/supplement", () => {
  test("非 needs_info 状态：409", async () => {
    const app1 = await submitApplication();
    const res = await post(`/applications/${app1.id}/supplement`, { text: "补充", expectedRevision: app1.revision }, studentCookie);
    assert.equal(res.status, 409);
  });

  test("老师要求补充后，学员补充：回到 submitted，留一条审计事件", async () => {
    const app1 = await submitApplication();
    await post(`/teacher/applications/${app1.id}/request-info`, { question: "能说说原因吗", expectedRevision: app1.revision }, teacherCookie);

    const res = await post(`/applications/${app1.id}/supplement`, { text: "详细原因", expectedRevision: app1.revision + 1 }, studentCookie);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "submitted");
    assert.equal(body.revision, app1.revision + 2);

    const { rows } = await pool.query(
      "SELECT event_type, details FROM application_events WHERE application_id = $1 AND event_type = 'supplement'",
      [app1.id],
    );
    assert.equal(rows[0]!.details.text, "详细原因");
  });
});

describe("POST /applications/:id/withdraw", () => {
  test("submitted 状态可以撤回", async () => {
    const app1 = await submitApplication();
    const res = await post(`/applications/${app1.id}/withdraw`, { expectedRevision: app1.revision }, studentCookie);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "withdrawn");
  });

  test("AC-022：撤回之后老师再处理（用撤回前的 expectedRevision）：409，不再变更报名", async () => {
    const app1 = await submitApplication();
    const withdrawRes = await post(`/applications/${app1.id}/withdraw`, { expectedRevision: app1.revision }, studentCookie);
    assert.equal(withdrawRes.status, 200);

    const res = await post(
      `/teacher/applications/${app1.id}/request-info`,
      { question: "还能处理吗", expectedRevision: app1.revision },
      teacherCookie,
    );
    assert.equal(res.status, 409);

    const { rows } = await pool.query("SELECT status FROM applications WHERE id = $1", [app1.id]);
    assert.equal(rows[0]!.status, "withdrawn", "老师的操作不能让已撤回的申请变回其它状态");
  });

  test("已批准状态不能撤回", async () => {
    const app1 = await submitApplication();
    await pool.query("UPDATE applications SET status = 'approved' WHERE id = $1", [app1.id]);
    const res = await post(`/applications/${app1.id}/withdraw`, { expectedRevision: app1.revision }, studentCookie);
    assert.equal(res.status, 409);
  });
});

describe("老师提出方案与学员回应（propose / proposal-response）", () => {
  test("非 submitted 状态不能提方案：409", async () => {
    const app1 = await submitApplication();
    await post(`/teacher/applications/${app1.id}/request-info`, { question: "q", expectedRevision: app1.revision }, teacherCookie);
    const res = await post(
      `/teacher/applications/${app1.id}/propose`,
      { targetCohortId: otherCohortId, reason: "建议转班", expectedRevision: app1.revision + 1 },
      teacherCookie,
    );
    assert.equal(res.status, 409);
  });

  test("转班方案没给 targetCohortId：422", async () => {
    const app1 = await submitApplication("transfer");
    const res = await post(`/teacher/applications/${app1.id}/propose`, { reason: "建议转班", expectedRevision: app1.revision }, teacherCookie);
    assert.equal(res.status, 422);
  });

  test("完整流程：propose → 学员 accept → submitted，proposal 保留；再 accept 用旧卡是 409", async () => {
    const app1 = await submitApplication("transfer");
    const proposeRes = await post(
      `/teacher/applications/${app1.id}/propose`,
      { targetCohortId: otherCohortId, reason: "建议转到新班", expectedRevision: app1.revision },
      teacherCookie,
    );
    assert.equal(proposeRes.status, 200);
    const proposed = await proposeRes.json();
    assert.equal(proposed.status, "awaiting_student_confirmation");
    assert.equal(proposed.summary.targetCohortId, otherCohortId, "摘要要反映方案里的目标班期，不是草稿原来的");
    assert.ok(proposed.pendingConfirmation.confirmationId);

    const acceptRes = await post(
      `/applications/${app1.id}/proposal-response`,
      { accept: true, confirmationId: proposed.pendingConfirmation.confirmationId, expectedRevision: proposed.revision },
      studentCookie,
    );
    assert.equal(acceptRes.status, 200);
    const accepted = await acceptRes.json();
    assert.equal(accepted.status, "submitted");
    assert.equal(accepted.revision, proposed.revision, "accept 不改 revision");
    assert.equal(accepted.proposal.targetCohortId, otherCohortId, "接受后方案还在，留给 T-14 approve 用");

    const replay = await post(
      `/applications/${app1.id}/proposal-response`,
      { accept: true, confirmationId: proposed.pendingConfirmation.confirmationId, expectedRevision: proposed.revision },
      studentCookie,
    );
    assert.equal(replay.status, 409, "同一张确认卡已经用过，不是幂等重放（proposal-response 没有类似 confirm 的重放豁免）");
  });

  test("拒绝方案：回到 submitted，proposal 清空，revision 前进一格；不自动执行任何变更", async () => {
    const app1 = await submitApplication("refund");
    const proposeRes = await post(
      `/teacher/applications/${app1.id}/propose`,
      { refundCents: 5000, reason: "同意部分退款", expectedRevision: app1.revision },
      teacherCookie,
    );
    const proposed = await proposeRes.json();

    const rejectRes = await post(
      `/applications/${app1.id}/proposal-response`,
      { accept: false, confirmationId: proposed.pendingConfirmation.confirmationId, expectedRevision: proposed.revision },
      studentCookie,
    );
    assert.equal(rejectRes.status, 200);
    const rejected = await rejectRes.json();
    assert.equal(rejected.status, "submitted");
    assert.equal(rejected.proposal, null);
    assert.equal(rejected.revision, proposed.revision + 1);
    assert.equal(rejected.executionStatus, "not_started", "拒绝方案不代表执行了任何退款/转班");
  });
});

describe("GET /teacher/applications", () => {
  test("学员访问：403", async () => {
    const res = await get("/teacher/applications", studentCookie);
    assert.equal(res.status, 403);
  });

  test("按 status 过滤", async () => {
    const app1 = await submitApplication();
    const res = await get(`/teacher/applications?status=submitted`, teacherCookie);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.items.some((a: { id: string }) => a.id === app1.id));
    assert.ok(body.items.every((a: { status: string }) => a.status === "submitted"));
  });
});

describe("POST /teacher/applications/:id/reject", () => {
  test("拒绝申请：终态 rejected，撤销活着的确认卡", async () => {
    const app1 = await submitApplication("transfer");
    const proposeRes = await post(
      `/teacher/applications/${app1.id}/propose`,
      { targetCohortId: otherCohortId, reason: "先提个方案", expectedRevision: app1.revision },
      teacherCookie,
    );
    const proposed = await proposeRes.json();

    const res = await post(`/teacher/applications/${app1.id}/reject`, { reason: "最终不批准", expectedRevision: proposed.revision }, teacherCookie);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "rejected");

    const { rows } = await pool.query("SELECT revoked_at FROM confirmations WHERE id = $1", [proposed.pendingConfirmation.confirmationId]);
    assert.ok(rows[0]!.revoked_at, "拒绝申请之后，还没被消费的确认卡应该被撤销");
  });
});

describe("POST /teacher/applications/:id/approve", () => {
  test("转班：草稿时就知道目标 + oldReplayAccess=keep —— 报名真的换班期，留一条转班历史和一条回放权益", async () => {
    const app1 = await submitApplication("transfer", "直接知道目标", otherCohortId);
    const res = await post(
      `/teacher/applications/${app1.id}/approve`,
      { expectedRevision: app1.revision, oldReplayAccess: "keep" },
      teacherCookie,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "approved");
    assert.equal(body.executionStatus, "completed");

    const { rows: enrollmentRows } = await pool.query("SELECT cohort_id, revision FROM enrollments WHERE id = $1", [app1.enrollmentId]);
    assert.equal(enrollmentRows[0]!.cohort_id, otherCohortId, "报名的 cohort_id 应该真的变成目标班期");

    const { rows: changeRows } = await pool.query("SELECT from_cohort_id, to_cohort_id FROM enrollment_changes WHERE application_id = $1", [
      app1.id,
    ]);
    assert.equal(changeRows.length, 1);
    assert.equal(changeRows[0]!.to_cohort_id, otherCohortId);
    assert.equal(changeRows[0]!.from_cohort_id, cohortId);

    const { rows: entitlementRows } = await pool.query(
      "SELECT cohort_id FROM replay_entitlements WHERE source_application_id = $1",
      [app1.id],
    );
    assert.equal(entitlementRows.length, 1, "oldReplayAccess=keep 应该留一条旧班期的回放权益");
    assert.equal(entitlementRows[0]!.cohort_id, cohortId);
  });

  test("转班：oldReplayAccess=revoke —— 不产生回放权益记录", async () => {
    const app1 = await submitApplication("transfer", "换个理由", otherCohortId);
    const res = await post(
      `/teacher/applications/${app1.id}/approve`,
      { expectedRevision: app1.revision, oldReplayAccess: "revoke" },
      teacherCookie,
    );
    assert.equal(res.status, 200);

    const { rows } = await pool.query("SELECT 1 FROM replay_entitlements WHERE source_application_id = $1", [app1.id]);
    assert.equal(rows.length, 0);
  });

  test("转班没给 oldReplayAccess：422", async () => {
    const app1 = await submitApplication("transfer", "缺参数", otherCohortId);
    const res = await post(`/teacher/applications/${app1.id}/approve`, { expectedRevision: app1.revision }, teacherCookie);
    assert.equal(res.status, 422);
  });

  test("目标未知（没走 propose 就直接 approve）：409", async () => {
    const app1 = await submitApplication("transfer", "没有目标");
    const res = await post(
      `/teacher/applications/${app1.id}/approve`,
      { expectedRevision: app1.revision, oldReplayAccess: "keep" },
      teacherCookie,
    );
    assert.equal(res.status, 409);
  });

  test("退费：只标记 approved+pending，不改任何报名/权益数据", async () => {
    const app1 = await submitApplication("refund", "申请退费");
    const res = await post(`/teacher/applications/${app1.id}/approve`, { expectedRevision: app1.revision }, teacherCookie);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "approved");
    assert.equal(body.executionStatus, "pending", "退费批准不代表已经打钱");

    const { rows } = await pool.query("SELECT cohort_id FROM enrollments WHERE id = $1", [app1.enrollmentId]);
    assert.equal(rows[0]!.cohort_id, cohortId, "退费批准不应该动报名的班期");
  });

  test("内容在学员确认之后又变过（revision 和 confirmed_revision 不一致）：409，不是用最新 revision 就能批", async () => {
    const app1 = await submitApplication("transfer", "先确认", otherCohortId);
    // 老师要求补充信息，学员补充：revision 往前走了两格，但没人重新"确认"过这两次变化
    await post(`/teacher/applications/${app1.id}/request-info`, { question: "补充下", expectedRevision: app1.revision }, teacherCookie);
    const supplementRes = await post(
      `/applications/${app1.id}/supplement`,
      { text: "补充说明", expectedRevision: app1.revision + 1 },
      studentCookie,
    );
    const supplemented = await supplementRes.json();
    assert.equal(supplemented.revision, app1.revision + 2);

    const res = await post(
      `/teacher/applications/${app1.id}/approve`,
      { expectedRevision: supplemented.revision, oldReplayAccess: "keep" },
      teacherCookie,
    );
    assert.equal(res.status, 409, "revision 对得上，但 confirmed_revision 还停在最初确认那次，不该被批准");
  });

  test("AC-008：两位老师并发批准同一张申请，只执行一次", async () => {
    const app1 = await submitApplication("transfer", "并发批准", otherCohortId);
    const payload = { expectedRevision: app1.revision, oldReplayAccess: "keep" as const };

    const [a, b] = await Promise.all([
      post(`/teacher/applications/${app1.id}/approve`, payload, teacherCookie),
      post(`/teacher/applications/${app1.id}/approve`, payload, teacherCookie),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], "应该恰好一个成功、一个因为 revision 冲突失败");

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM enrollment_changes WHERE application_id = $1", [app1.id]);
    assert.equal(rows[0]!.n, 1, "转班历史只能有一条，不能两个请求都执行了转班");
  });
});

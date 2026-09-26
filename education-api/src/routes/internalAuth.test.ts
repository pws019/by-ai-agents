// 内部（Agent）通道的认证与权限边界（T-18）。核心保证：
// ① 身份只能来自 BFF 签名的上下文，伪造/过期/换密钥都拿不到身份；
// ② 内部通道来的请求，业务 API 仍按"这个学员"做资源授权（看不到别人的数据）；
// ③ "确认申请/回应方案/老师端点"这类必须由用户本人完成的操作，Agent 通道一律 403。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "../app.js";
import { signInternalContext } from "../auth/internalContext.js";
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
const SECRET = "internal-test-secret";

let admin: pg.Client;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let studentId: string;
let otherStudentId: string;
let teacherId: string;
let studentCookie: string;
let otherEnrollmentId: string;
let enrollmentId: string;

const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
const id = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;

before(async () => {
  admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl, migrationsDir);
  pool = createPool(testUrl);
  const db = createDb(pool);
  app = createApp(pool, { allowedOrigin: ORIGIN, internalAuthSecret: SECRET });

  teacherId = await id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('t','x','老师','teacher') RETURNING id");
  studentId = await id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s','x','学员','student') RETURNING id");
  otherStudentId = await id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s2','x','学员2','student') RETURNING id");
  studentCookie = `edu_session=${(await createSession(db, studentId)).token}`;

  const courseId = await id("INSERT INTO courses (title) VALUES ('课程') RETURNING id");
  const versionId = await id("INSERT INTO course_versions (course_id, version) VALUES ($1,1) RETURNING id", [courseId]);
  const cohortId = await id(
    "INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'班期1','CNY','running') RETURNING id",
    [courseId, versionId],
  );
  const policyId = await id("INSERT INTO policies (version, text) VALUES (1,'政策') RETURNING id");
  const enroll = async (sid: string) => {
    const orderId = await id(
      "INSERT INTO orders (student_id, cohort_id, policy_id, paid_cents, source) VALUES ($1,$2,$3,88800,'seed') RETURNING id",
      [sid, cohortId, policyId],
    );
    return id("INSERT INTO enrollments (student_id, order_id, cohort_id, status) VALUES ($1,$2,$3,'active') RETURNING id", [sid, orderId, cohortId]);
  };
  enrollmentId = await enroll(studentId);
  otherEnrollmentId = await enroll(otherStudentId);
});

after(async () => {
  await pool.end();
  await dropTestDatabase(admin, dbName);
  await admin.end();
});

const ctxToken = (actorId: string, role: "student" | "teacher" = "student", secret = SECRET, opts?: { ttlSeconds?: number }) =>
  signInternalContext({ actorId, role, requestId: "req-test" }, secret, opts);

/** 模拟 Agent 服务：只带签名头，没有 cookie，没有 Origin。 */
const agent = (method: string, path: string, token: string, body?: unknown) =>
  app.request(`/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Actor-Context": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("内部上下文认证", () => {
  test("有效签名：身份就是签名里的那个学员", async () => {
    const res = await agent("GET", "/me", ctxToken(studentId));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, studentId);
  });

  test("签名密钥不对 / 已过期：401", async () => {
    assert.equal((await agent("GET", "/me", ctxToken(studentId, "student", "wrong-secret"))).status, 401);
    // ttl 负数 = 签发时就已经过期
    assert.equal((await agent("GET", "/me", ctxToken(studentId, "student", SECRET, { ttlSeconds: -1 }))).status, 401);
  });

  test("头无效时不回退去认 cookie：即使同时带了有效 session cookie 也是 401", async () => {
    const res = await app.request("/api/v1/me", { headers: { "X-Actor-Context": "garbage", Cookie: studentCookie } });
    assert.equal(res.status, 401);
  });

  test("签名里的 role 与库里不一致：401（以库为准，不信签发时的快照）", async () => {
    assert.equal((await agent("GET", "/me", ctxToken(studentId, "teacher"))).status, 401);
  });

  test("签名里的用户不存在：401", async () => {
    assert.equal((await agent("GET", "/me", ctxToken("00000000-0000-0000-0000-00000000dead"))).status, 401);
  });

  test("服务端没配置密钥：内部通道整体不可用（不是'空密钥都能过'）", async () => {
    const noSecretApp = createApp(pool, { allowedOrigin: ORIGIN, internalAuthSecret: "" });
    const res = await noSecretApp.request("/api/v1/me", { headers: { "X-Actor-Context": ctxToken(studentId, "student", "") } });
    assert.equal(res.status, 401);
  });
});

describe("内部通道下的资源授权与写操作边界", () => {
  test("代表学员 A 读别人的报名进度：404（业务 API 仍按 A 做资源授权）", async () => {
    const own = await agent("GET", `/me/enrollments/${enrollmentId}/progress`, ctxToken(studentId));
    assert.equal(own.status, 200);
    const other = await agent("GET", `/me/enrollments/${otherEnrollmentId}/progress`, ctxToken(studentId));
    assert.equal(other.status, 404);
  });

  test("Agent 通道可以创建草稿（无 Origin 也不被 CSRF 检查挡掉），但拿到的只是草稿", async () => {
    const res = await agent("POST", "/applications/drafts", ctxToken(studentId), { type: "transfer", enrollmentId, reason: "agent 代为起草" });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).status, "draft");
  });

  test("没带内部头、也没 Origin 的写请求仍被 CSRF 检查拒绝（跳过 CSRF 只限于已认证的 Agent 通道）", async () => {
    const res = await app.request("/api/v1/applications/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: studentCookie },
      body: JSON.stringify({ type: "refund", enrollmentId, reason: "x" }),
    });
    assert.equal(res.status, 403);
  });

  test("AC-004/AC-017：Agent 通道不能确认申请、不能回应方案——同一请求走用户 session 则正常", async () => {
    const draftRes = await agent("POST", "/applications/drafts", ctxToken(otherStudentId), {
      type: "transfer",
      enrollmentId: otherEnrollmentId,
      reason: "待确认",
    });
    const draft = await draftRes.json();
    const body = { confirmationId: draft.confirmation.confirmationId, expectedRevision: draft.revision };

    const viaAgent = await agent("POST", `/applications/${draft.id}/confirm`, ctxToken(otherStudentId), body);
    assert.equal(viaAgent.status, 403);
    const { rows } = await q("SELECT status FROM applications WHERE id = $1", [draft.id]);
    assert.equal(rows[0]!.status, "draft", "被拒绝的确认请求不能有任何副作用");

    const proposal = await agent("POST", `/applications/${draft.id}/proposal-response`, ctxToken(otherStudentId), { accept: true, ...body });
    assert.equal(proposal.status, 403);

    // 对照：同一份 body 走用户本人的 session（带 Origin）就能确认，说明上面的 403 来自通道而不是请求本身有问题。
    const otherCookie = `edu_session=${(await createSession(createDb(pool), otherStudentId)).token}`;
    const viaSession = await app.request(`/api/v1/applications/${draft.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: otherCookie },
      body: JSON.stringify(body),
    });
    assert.equal(viaSession.status, 200);
  });

  test("老师端点对 Agent 通道一律 403，即使上下文声称是老师", async () => {
    const res = await agent("GET", "/teacher/applications", ctxToken(teacherId, "teacher"));
    assert.equal(res.status, 403);
  });
});

// 断线重连后找回"待确认的草稿"（T-21 的后端前置）与会话标题。真实临时库。
// 关键保证：草稿的来源只由已验签工作证里的 runId 决定——请求体、模型都无法指定；
// 且只有"本人会话里的运行"才会被记为来源。
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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
const SECRET = "pending-test-secret";

let admin: pg.Client;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let studentId: string;
let otherStudentId: string;
let studentCookie: string;
let cohortId: string;
let policyId: string;

const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
const id = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;

const newConversation = (ownerId = studentId) => id("INSERT INTO conversations (owner_id) VALUES ($1) RETURNING id", [ownerId]);
const newRun = (conversationId: string) =>
  id("INSERT INTO runs (conversation_id, kind, status, lease_until) VALUES ($1,'message','running', now() + interval '90 seconds') RETURNING id", [conversationId]);
const newEnrollment = async (sid: string) => {
  const orderId = await id("INSERT INTO orders (student_id, cohort_id, policy_id, paid_cents, source) VALUES ($1,$2,$3,88800,'seed') RETURNING id", [sid, cohortId, policyId]);
  return id("INSERT INTO enrollments (student_id, order_id, cohort_id, status) VALUES ($1,$2,$3,'active') RETURNING id", [sid, orderId, cohortId]);
};

before(async () => {
  admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl, migrationsDir);
  pool = createPool(testUrl);
  const db = createDb(pool);
  app = createApp(pool, { allowedOrigin: ORIGIN, internalAuthSecret: SECRET });

  studentId = await id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s','x','学员','student') RETURNING id");
  otherStudentId = await id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s2','x','学员2','student') RETURNING id");
  studentCookie = `edu_session=${(await createSession(db, studentId)).token}`;
  const courseId = await id("INSERT INTO courses (title) VALUES ('课程') RETURNING id");
  const versionId = await id("INSERT INTO course_versions (course_id, version) VALUES ($1,1) RETURNING id", [courseId]);
  cohortId = await id("INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'班期1','CNY','running') RETURNING id", [courseId, versionId]);
  policyId = await id("INSERT INTO policies (version, text) VALUES (1,'政策') RETURNING id");
});

after(async () => {
  await pool.end();
  await dropTestDatabase(admin, dbName);
  await admin.end();
});

/** 模拟 Agent 的 prepareApplication：只带签名头，requestId 由 BFF 设为 runId。 */
const agentDraft = (actorId: string, requestId: string, enrollmentId: string) =>
  app.request("/api/v1/applications/drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Actor-Context": signInternalContext({ actorId, role: "student", requestId }, SECRET) },
    body: JSON.stringify({ type: "refund", enrollmentId, reason: "测试" }),
  });
const web = (method: string, path: string, body?: unknown, cookie = studentCookie) =>
  app.request(`/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const pendingOf = async (conversationId: string) => (await (await web("GET", `/conversations/${conversationId}/messages`)).json()).pendingConfirmation;
const sourceOf = async (applicationId: string) => (await q("SELECT source_run_id FROM applications WHERE id = $1", [applicationId])).rows[0]!.source_run_id;

describe("草稿来源与待确认草稿", () => {
  test("Agent 在会话的某次运行里起草：记录来源；重连读消息能拿到与起草时一致的确认卡", async () => {
    const conversationId = await newConversation();
    const runId = await newRun(conversationId);
    const res = await agentDraft(studentId, runId, await newEnrollment(studentId));
    assert.equal(res.status, 201);
    const draft = await res.json();
    assert.equal(await sourceOf(draft.id), runId);

    const pending = await pendingOf(conversationId);
    assert.deepEqual(Object.keys(pending).sort(), ["applicationId", "confirmationId", "expiresAt", "revision", "summary"]);
    assert.equal(pending.applicationId, draft.id);
    assert.equal(pending.confirmationId, draft.confirmation.confirmationId);
    assert.equal(pending.revision, draft.revision);
  });

  test("来源只认已验签工作证里的 runId：别人的会话的 run / 不存在的 run / 非 UUID，都不记来源，且草稿仍能创建", async () => {
    const othersRun = await newRun(await newConversation(otherStudentId));
    for (const requestId of [othersRun, randomUUID(), "req-test", "'; drop table runs; --"]) {
      const res = await agentDraft(studentId, requestId, await newEnrollment(studentId));
      assert.equal(res.status, 201, requestId);
      assert.equal(await sourceOf((await res.json()).id), null, requestId);
    }
  });

  test("请求体里的 sourceRunId 之类字段没有任何作用（来源不由调用方指定）", async () => {
    const conversationId = await newConversation();
    const runId = await newRun(conversationId);
    const res = await app.request("/api/v1/applications/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: studentCookie, Origin: ORIGIN },
      body: JSON.stringify({ type: "refund", enrollmentId: await newEnrollment(studentId), reason: "x", sourceRunId: runId }),
    });
    assert.equal(await sourceOf((await res.json()).id), null);
    assert.equal(await pendingOf(conversationId), null);
  });

  test("用户自己在界面上创建的草稿没有来源，不会出现在任何会话里", async () => {
    const conversationId = await newConversation();
    await web("POST", "/applications/drafts", { type: "refund", enrollmentId: await newEnrollment(studentId), reason: "自己起草" });
    assert.equal(await pendingOf(conversationId), null);
  });

  test("只在它自己的会话里出现，不会冒到别的会话", async () => {
    const a = await newConversation();
    const b = await newConversation();
    await agentDraft(studentId, await newRun(a), await newEnrollment(studentId));
    assert.ok(await pendingOf(a));
    assert.equal(await pendingOf(b), null);
  });

  test("用户确认之后不再是待确认", async () => {
    const conversationId = await newConversation();
    const draft = await (await agentDraft(studentId, await newRun(conversationId), await newEnrollment(studentId))).json();
    const res = await web("POST", `/applications/${draft.id}/confirm`, { confirmationId: draft.confirmation.confirmationId, expectedRevision: draft.revision });
    assert.equal(res.status, 200);
    assert.equal(await pendingOf(conversationId), null);
  });

  test("确认卡已过期 / 已撤销 / 已使用：都不再返回", async () => {
    for (const [label, update] of [
      ["过期", "expires_at = now() - interval '1 second'"],
      ["撤销", "revoked_at = now()"],
      ["已用", "used_at = now()"],
    ] as const) {
      const conversationId = await newConversation();
      const draft = await (await agentDraft(studentId, await newRun(conversationId), await newEnrollment(studentId))).json();
      assert.ok(await pendingOf(conversationId), `${label}前应当有`);
      await q(`UPDATE confirmations SET ${update} WHERE application_id = $1`, [draft.id]);
      assert.equal(await pendingOf(conversationId), null, label);
    }
  });

  test("只有草稿才算待确认：老师提出新方案后（awaiting_student_confirmation），即使还有未使用的确认卡也不出现在聊天里", async () => {
    // "回应方案"走的是另一条流程（我的申请页），不该被当成聊天里等待确认的草稿。
    const conversationId = await newConversation();
    const draft = await (await agentDraft(studentId, await newRun(conversationId), await newEnrollment(studentId))).json();
    assert.ok(await pendingOf(conversationId));
    await q("UPDATE applications SET status = 'awaiting_student_confirmation' WHERE id = $1", [draft.id]);
    assert.equal(await pendingOf(conversationId), null);
  });

  test("草稿被修改后返回的是新签发的确认卡（旧卡已撤销），revision 随之增加", async () => {
    const conversationId = await newConversation();
    const draft = await (await agentDraft(studentId, await newRun(conversationId), await newEnrollment(studentId))).json();
    const patched = await (await web("PATCH", `/applications/${draft.id}/draft`, { reason: "改了原因", expectedRevision: draft.revision })).json();
    const pending = await pendingOf(conversationId);
    assert.equal(pending.revision, draft.revision + 1);
    assert.equal(pending.confirmationId, patched.confirmation.confirmationId);
    assert.notEqual(pending.confirmationId, draft.confirmation.confirmationId);
  });

  test("同一张草稿在另一个会话里被再次起草：来源转移到最近这个会话", async () => {
    const older = await newConversation();
    const newer = await newConversation();
    const enrollmentId = await newEnrollment(studentId);
    const first = await agentDraft(studentId, await newRun(older), enrollmentId);
    assert.equal(first.status, 201);
    const second = await agentDraft(studentId, await newRun(newer), enrollmentId);
    assert.equal(second.status, 200, "同一报名同类型的草稿被原样返回");

    assert.equal(await pendingOf(older), null);
    assert.ok(await pendingOf(newer));
  });

  test("别人的会话读不到（404），也就读不到里面的确认卡", async () => {
    const conversationId = await newConversation(otherStudentId);
    assert.equal((await web("GET", `/conversations/${conversationId}/messages`)).status, 404);
  });
});

describe("删除会话", () => {
  test("删掉当时起草这张申请的会话：source_run_id 置空，申请本身还在（不是业务记录，不跟着级联删除）", async () => {
    const conversationId = await newConversation();
    const runId = await newRun(conversationId);
    const draft = await (await agentDraft(studentId, runId, await newEnrollment(studentId))).json();
    assert.equal(await sourceOf(draft.id), runId);
    await q("UPDATE runs SET status = 'completed', finished_at = now() WHERE id = $1", [runId]); // 不然这次运行还在跑，删除会被 409 挡住

    assert.equal((await web("DELETE", `/conversations/${conversationId}`)).status, 204);

    assert.equal(await sourceOf(draft.id), null);
    assert.equal((await q("SELECT status FROM applications WHERE id = $1", [draft.id])).rows[0]?.status, "draft");
  });
});

describe("会话标题", () => {
  const titles = async () => Object.fromEntries((await (await web("GET", "/conversations")).json()).items.map((c: { id: string; title: string | null }) => [c.id, c.title]));
  const addUserMessage = (conversationId: string, text: string, clientId: string, offsetSeconds: number) =>
    q("INSERT INTO messages (conversation_id, role, content, client_message_id, created_at) VALUES ($1,'user',$2,$3, now() + make_interval(secs => $4))", [conversationId, text, clientId, offsetSeconds]);

  test("取首条用户消息作标题；后来的消息不改变标题；没有消息则为 null", async () => {
    const empty = await newConversation();
    const withMessages = await newConversation();
    await addUserMessage(withMessages, "我想转班", "a", 0);
    await addUserMessage(withMessages, "后来说的话", "b", 5);
    const t = await titles();
    assert.equal(t[empty], null);
    assert.equal(t[withMessages], "我想转班");
  });

  test("超长标题按字符（不是字节）截断并加省略号，不会把汉字切成两半", async () => {
    const conversationId = await newConversation();
    await addUserMessage(conversationId, "退".repeat(40), "long", 0);
    const title = (await titles())[conversationId] as string;
    assert.equal(title, `${"退".repeat(24)}…`);
  });

  test("创建会话的响应也带 title（null）", async () => {
    const created = await (await web("POST", "/conversations")).json();
    assert.equal(created.title, null);
  });
});

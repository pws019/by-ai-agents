// T-29：老师资料维护接口。导入/列表直接在本地库验证；发布/撤回不起真的 education-agent 进程，
// 用一个假的 AgentKnowledgeAdminClient（跟 chat 测试里假 AgentClient 同一个做法）——
// 真正的并发/状态机正确性已经在 education-agent 的 tests/test_agent_server_knowledge.py 测过。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "../app.js";
import { verifyInternalContext } from "../auth/internalContext.js";
import { createSession } from "../auth/session.js";
import { DATABASE_URL } from "../db/config.js";
import { migrate } from "../db/migrate.js";
import { createDb, createPool } from "../db/pool.js";
import type { AgentAdminResult, AgentKnowledgeAdminClient } from "../knowledge/agentAdminClient.js";
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
const SECRET = "teacher-knowledge-test-secret";

let admin: pg.Client;
let pool: pg.Pool;
let db: ReturnType<typeof createDb>;
let app: ReturnType<typeof createApp>;

const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
const id = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;

let teacherCookie: string;
let studentCookie: string;
let lessonId: string;
let cohortId: string;

// 调用方可以配置 activate/withdraw 各自返回什么；calls 记录每次调用传了什么 documentId/token，
// 供测试断言"老师这次操作真的签发了一张 role=teacher 的工作证"。
function fakeAgentAdmin() {
  const calls: { fn: "activate" | "withdraw"; documentId: string; token: string }[] = [];
  let activateResult: AgentAdminResult<void> = { kind: "ok", data: undefined };
  let withdrawResult: AgentAdminResult<{ withdrawn: boolean }> = { kind: "ok", data: { withdrawn: true } };
  const client: AgentKnowledgeAdminClient = {
    async activate(documentId, token) {
      calls.push({ fn: "activate", documentId, token });
      return activateResult;
    },
    async withdraw(documentId, token) {
      calls.push({ fn: "withdraw", documentId, token });
      return withdrawResult;
    },
  };
  return {
    client,
    calls,
    setActivateResult: (r: AgentAdminResult<void>) => (activateResult = r),
    setWithdrawResult: (r: AgentAdminResult<{ withdrawn: boolean }>) => (withdrawResult = r),
  };
}

let agentAdmin: ReturnType<typeof fakeAgentAdmin>;

before(async () => {
  admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl, migrationsDir);
  pool = createPool(testUrl);
  db = createDb(pool);
  agentAdmin = fakeAgentAdmin();
  app = createApp(pool, { allowedOrigin: ORIGIN, internalAuthSecret: SECRET, agentAdmin: agentAdmin.client });

  const teacherId = await id(
    "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('t','x','老师','teacher') RETURNING id",
  );
  const studentId = await id(
    "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s','x','学员','student') RETURNING id",
  );
  teacherCookie = `edu_session=${(await createSession(db, teacherId)).token}`;
  studentCookie = `edu_session=${(await createSession(db, studentId)).token}`;

  const courseId = await id("INSERT INTO courses (title) VALUES ('课程') RETURNING id");
  const versionId = await id("INSERT INTO course_versions (course_id, version) VALUES ($1,1) RETURNING id", [courseId]);
  cohortId = await id(
    "INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'资料班期','CNY','running') RETURNING id",
    [courseId, versionId],
  );
  lessonId = await id("INSERT INTO lessons (cohort_id, title, position) VALUES ($1,'第一课',1) RETURNING id", [cohortId]);
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
const get = (path: string, cookie?: string) =>
  app.request(`/api/v1${path}`, { headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) } });

describe("GET /teacher/lessons/:lessonId", () => {
  test("没登录：401；学员：403", async () => {
    assert.equal((await get(`/teacher/lessons/${lessonId}`)).status, 401);
    assert.equal((await get(`/teacher/lessons/${lessonId}`, studentCookie)).status, 403);
  });

  test("存在：200，带标题和所属班期", async () => {
    const res = await get(`/teacher/lessons/${lessonId}`, teacherCookie);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { lessonId, title: "第一课", cohortId, cohortName: "资料班期" });
  });

  test("不存在：404", async () => {
    const res = await get("/teacher/lessons/00000000-0000-0000-0000-00000000dead", teacherCookie);
    assert.equal(res.status, 404);
  });
});

describe("GET /teacher/knowledge/documents", () => {
  test("没有 lessonId：422", async () => {
    assert.equal((await get("/teacher/knowledge/documents", teacherCookie)).status, 422);
  });

  test("这节课还没导入过任何资料：200，空列表", async () => {
    const otherLesson = await id("INSERT INTO lessons (cohort_id, title, position) VALUES ($1,'空课次',2) RETURNING id", [cohortId]);
    const res = await get(`/teacher/knowledge/documents?lessonId=${otherLesson}`, teacherCookie);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { items: [] });
  });
});

describe("POST /teacher/knowledge/documents —— 导入", () => {
  test("缺字段或 kind 不合法：422", async () => {
    assert.equal((await post("/teacher/knowledge/documents", { lessonId, sourceName: "a.srt", rawContent: "x" }, teacherCookie)).status, 422);
    assert.equal(
      (await post("/teacher/knowledge/documents", { lessonId, kind: "pdf", sourceName: "a", rawContent: "x" }, teacherCookie)).status,
      422,
    );
  });

  test("lesson 不存在：404", async () => {
    const res = await post(
      "/teacher/knowledge/documents",
      { lessonId: "00000000-0000-0000-0000-00000000dead", kind: "markdown", sourceName: "a.md", rawContent: "内容" },
      teacherCookie,
    );
    assert.equal(res.status, 404);
  });

  test("首次导入：201，自动登记一条 index 任务；列表里能看到这一版、indexStatus 是 pending", async () => {
    const importLesson = await id("INSERT INTO lessons (cohort_id, title, position) VALUES ($1,'导入课',3) RETURNING id", [cohortId]);
    const res = await post(
      "/teacher/knowledge/documents",
      { lessonId: importLesson, kind: "markdown", sourceName: "a.md", rawContent: "第一版内容" },
      teacherCookie,
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body, { documentId: body.documentId, version: 1, kind: "imported", segmentCount: 1 });

    const job = await q("SELECT status FROM app.knowledge_index_jobs WHERE document_id = $1 AND kind = 'index'", [body.documentId]);
    assert.equal(job.rows.length, 1, "导入之后应该恰好有一条 index 任务");
    assert.equal(job.rows[0]!.status, "pending");

    const list = await get(`/teacher/knowledge/documents?lessonId=${importLesson}`, teacherCookie);
    const { items } = await list.json();
    assert.deepEqual(items, [
      {
        documentId: body.documentId, version: 1, kind: "markdown", sourceName: "a.md", visibility: "private",
        activatedAt: null, revokedAt: null, createdAt: items[0].createdAt, indexStatus: "pending", segmentCount: 1,
      },
    ]);
  });

  test("内容完全没变：200，kind=unchanged，不会再插一条 index 任务", async () => {
    const importLesson = await id("INSERT INTO lessons (cohort_id, title, position) VALUES ($1,'重复导入课',4) RETURNING id", [cohortId]);
    const first = await post("/teacher/knowledge/documents", { lessonId: importLesson, kind: "markdown", sourceName: "a.md", rawContent: "内容" }, teacherCookie);
    const firstBody = await first.json();

    const again = await post("/teacher/knowledge/documents", { lessonId: importLesson, kind: "markdown", sourceName: "a2.md", rawContent: "内容" }, teacherCookie);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { documentId: firstBody.documentId, version: 1, kind: "unchanged" });

    const jobs = await q("SELECT id FROM app.knowledge_index_jobs WHERE document_id = $1", [firstBody.documentId]);
    assert.equal(jobs.rows.length, 1, "没有产生新版本，自然也不该多出一条任务");
  });

  test("可以指定 visibility=public", async () => {
    const importLesson = await id("INSERT INTO lessons (cohort_id, title, position) VALUES ($1,'公开课',5) RETURNING id", [cohortId]);
    const res = await post(
      "/teacher/knowledge/documents",
      { lessonId: importLesson, kind: "markdown", sourceName: "a.md", rawContent: "公开内容", visibility: "public" },
      teacherCookie,
    );
    const body = await res.json();
    const row = await q("SELECT visibility FROM app.knowledge_documents WHERE id = $1", [body.documentId]);
    assert.equal(row.rows[0]!.visibility, "public");
  });
});

describe("POST /teacher/knowledge/documents/:id/publish 与 /withdraw", () => {
  test("没登录：401；学员：403（两个接口都要）", async () => {
    const docId = "00000000-0000-0000-0000-000000000abc";
    assert.equal((await post(`/teacher/knowledge/documents/${docId}/publish`, {})).status, 401);
    assert.equal((await post(`/teacher/knowledge/documents/${docId}/publish`, {}, studentCookie)).status, 403);
    assert.equal((await post(`/teacher/knowledge/documents/${docId}/withdraw`, {})).status, 401);
    assert.equal((await post(`/teacher/knowledge/documents/${docId}/withdraw`, {}, studentCookie)).status, 403);
  });

  test("发布成功：204，签给 Agent 的工作证 role 是 teacher 且能通过验签", async () => {
    agentAdmin.calls.length = 0;
    agentAdmin.setActivateResult({ kind: "ok", data: undefined });
    const docId = "00000000-0000-0000-0000-000000000a01";
    const res = await post(`/teacher/knowledge/documents/${docId}/publish`, {}, teacherCookie);
    assert.equal(res.status, 204);

    assert.equal(agentAdmin.calls.length, 1);
    assert.equal(agentAdmin.calls[0]!.documentId, docId);
    const ctx = verifyInternalContext(agentAdmin.calls[0]!.token, SECRET);
    assert.equal(ctx?.role, "teacher");
  });

  test("Agent 报 LESSON_BUSY：映射成 409 LESSON_BUSY", async () => {
    agentAdmin.setActivateResult({ kind: "error", status: 409, code: "LESSON_BUSY" });
    const res = await post("/teacher/knowledge/documents/00000000-0000-0000-0000-000000000a02/publish", {}, teacherCookie);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "LESSON_BUSY");
  });

  test("Agent 报 NOT_READY（索引还没成功）：映射成 422 INVALID_STATE", async () => {
    agentAdmin.setActivateResult({ kind: "error", status: 422, code: "NOT_READY" });
    const res = await post("/teacher/knowledge/documents/00000000-0000-0000-0000-000000000a03/publish", {}, teacherCookie);
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, "INVALID_STATE");
  });

  test("没配置 agentAdmin（比如本地没起 education-agent）：503", async () => {
    const bareApp = createApp(pool, { allowedOrigin: ORIGIN, internalAuthSecret: SECRET });
    const res = await bareApp.request("/api/v1/teacher/knowledge/documents/00000000-0000-0000-0000-000000000a04/publish", {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: teacherCookie },
    });
    assert.equal(res.status, 503);
  });

  test("撤回：把 Agent 返回的 withdrawn 原样透传", async () => {
    agentAdmin.setWithdrawResult({ kind: "ok", data: { withdrawn: false } });
    const res = await post("/teacher/knowledge/documents/00000000-0000-0000-0000-000000000a05/withdraw", {}, teacherCookie);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { withdrawn: false });
  });
});

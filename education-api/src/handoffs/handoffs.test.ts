// T-22 / 22a：转人工。全部跑在真实临时数据库上——这里保护的是数据库层面的仲裁
// （两位老师抢同一条、接管与"学员发消息"互斥、会话 mode 与 handoff 状态一起变），mock 证明不了它们成立。
// AC-012：老师接管后学员发言，只有老师处理，机器人不抢答。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "../app.js";
import { verifyInternalContext } from "../auth/internalContext.js";
import { createSession } from "../auth/session.js";
import type { AgentClient, AgentEvent, AgentRequest, AgentStart } from "../chat/agentClient.js";
import { DATABASE_URL } from "../db/config.js";
import { migrate } from "../db/migrate.js";
import { createDb, createPool } from "../db/pool.js";
import { dropTestDatabase } from "../testing/db.js";
import { startMessageRun, startResumeRun } from "../chat/runs.js";
import { requestHandoff, teacherSendMessage } from "./handoffs.js";

const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));
const dbName = `edu_test_${randomBytes(4).toString("hex")}`;
const withDb = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
};
const testUrl = withDb(dbName);
const ORIGIN = "http://localhost:5173";
const SECRET = "handoff-test-secret";

let admin: pg.Client;
let pool: pg.Pool;
let db: ReturnType<typeof createDb>;
let app: ReturnType<typeof createApp>;
let agent: FakeAgent;
let studentId: string;
let otherStudentId: string;
let teacherId: string;
let teacher2Id: string;
let studentCookie: string;
let otherCookie: string;
let teacherCookie: string;
let teacher2Cookie: string;

const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
const id = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;
const count = async (sql: string, params: unknown[] = []) => Number((await q<{ n: string }>(sql, params)).rows[0]!.n);
const newConversation = (ownerId = studentId) => id("INSERT INTO conversations (owner_id) VALUES ($1) RETURNING id", [ownerId]);
const modeOf = async (conversationId: string) => (await q<{ mode: string }>("SELECT mode FROM conversations WHERE id = $1", [conversationId])).rows[0]!.mode;

/**
 * 记录被调用次数的假 Agent：机器人有没有"抢答"，看它有没有被叫到。
 * 默认只吐一个 message.completed；测试可以在下一次调用之前设置 script，让它吐指定的事件（用完自动复位）。
 */
class FakeAgent implements AgentClient {
  calls: AgentRequest[] = [];
  script: Array<{ type: string; payload: Record<string, unknown> }> | null = null;
  start(req: AgentRequest): Promise<AgentStart> {
    this.calls.push(req);
    const ctx = verifyInternalContext(req.token, SECRET)!;
    const steps = this.script ?? [{ type: "message.completed", payload: { text: "机器人的回答" } }];
    this.script = null;
    async function* gen(): AsyncGenerator<AgentEvent> {
      let n = 0;
      for (const step of steps) {
        n += 1;
        yield { eventId: String(n), conversationId: req.conversationId, runId: ctx.requestId, type: step.type, payload: step.payload };
      }
    }
    return Promise.resolve({ kind: "stream", events: gen() });
  }
}

const call = (method: "GET" | "POST", path: string, cookie: string | null, body?: unknown) =>
  app.request(`/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(method === "POST" ? { Origin: ORIGIN } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const post = (path: string, body: unknown, cookie: string | null = studentCookie) => call("POST", path, cookie, body);
const get = (path: string, cookie: string | null = studentCookie) => call("GET", path, cookie);

const requestHandoffVia = async (conversationId: string, reason?: string, cookie = studentCookie) =>
  (await post(`/conversations/${conversationId}/handoff`, reason === undefined ? {} : { reason }, cookie)).json();
const claim = (handoffId: string, expectedRevision: number, cookie = teacherCookie) => post(`/teacher/handoffs/${handoffId}/claim`, { expectedRevision }, cookie);
const release = (handoffId: string, expectedRevision: number, cookie = teacherCookie) => post(`/teacher/handoffs/${handoffId}/release`, { expectedRevision }, cookie);
const studentSays = (conversationId: string, text: string, clientMessageId: string) =>
  post(`/conversations/${conversationId}/messages`, { clientMessageId, text });
const teacherSays = (conversationId: string, text: string, clientMessageId: string, cookie = teacherCookie) =>
  post(`/teacher/conversations/${conversationId}/messages`, { clientMessageId, text }, cookie);

const sseEvents = (text: string): AgentEvent[] =>
  text.split("\n\n").flatMap((block) => {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    return line ? [JSON.parse(line.slice(6)) as AgentEvent] : [];
  });

before(async () => {
  admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl, migrationsDir);
  pool = createPool(testUrl);
  db = createDb(pool);
  agent = new FakeAgent();
  app = createApp(pool, { allowedOrigin: ORIGIN, internalAuthSecret: SECRET, agent, heartbeatIntervalMs: 0 });

  const user = (login: string, name: string, role: string) =>
    id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ($1,'x',$2,$3) RETURNING id", [login, name, role]);
  teacherId = await user("t1", "老师1", "teacher");
  teacher2Id = await user("t2", "老师2", "teacher");
  studentId = await user("s1", "学员1", "student");
  otherStudentId = await user("s2", "学员2", "student");
  const cookieOf = async (userId: string) => `edu_session=${(await createSession(db, userId)).token}`;
  studentCookie = await cookieOf(studentId);
  otherCookie = await cookieOf(otherStudentId);
  teacherCookie = await cookieOf(teacherId);
  teacher2Cookie = await cookieOf(teacher2Id);
});

after(async () => {
  await pool.end();
  await dropTestDatabase(admin, dbName);
  await admin.end();
});

describe("学员请求接管", () => {
  test("bot → queued：新建一条排队记录，原因保存，revision 从 1 开始", async () => {
    const conversationId = await newConversation();
    const res = await post(`/conversations/${conversationId}/handoff`, { reason: "我想找老师聊聊" });
    assert.equal(res.status, 200);
    const h = await res.json();
    assert.equal(h.status, "queued");
    assert.equal(h.revision, 1);
    assert.equal(h.reason, "我想找老师聊聊");
    assert.equal(h.teacherId, null);
    assert.equal(h.conversationId, conversationId);
    assert.equal(await modeOf(conversationId), "queued");
  });

  test("重复请求幂等：返回同一条记录，不新建第二条", async () => {
    const conversationId = await newConversation();
    const first = await requestHandoffVia(conversationId, "第一次");
    const second = await requestHandoffVia(conversationId, "第二次");
    assert.equal(second.id, first.id);
    assert.equal(second.reason, "第一次", "已有记录原样返回，不被后来的请求覆盖");
    assert.equal(await count("SELECT count(*) AS n FROM handoffs WHERE conversation_id = $1", [conversationId]), 1);
  });

  test("并发请求：数据库只留一条进行中的记录（两个请求都成功，拿到同一个 id）", async () => {
    const conversationId = await newConversation();
    const results = await Promise.all(Array.from({ length: 6 }, () => requestHandoff(db, { conversationId })));
    assert.equal(new Set(results.map((r) => (r.kind === "closed" ? "closed" : r.handoff.id))).size, 1);
    assert.equal(results.filter((r) => r.kind === "queued").length, 1, "只有一个真正新建，其余都是 existing");
    assert.equal(await count("SELECT count(*) AS n FROM handoffs WHERE conversation_id = $1", [conversationId]), 1);
  });

  test("不是本人的会话：404，什么都没有改；老师不能调用学员接口：403", async () => {
    const conversationId = await newConversation();
    assert.equal((await post(`/conversations/${conversationId}/handoff`, {}, otherCookie)).status, 404);
    assert.equal((await post(`/conversations/${conversationId}/handoff`, {}, teacherCookie)).status, 403);
    assert.equal((await post(`/conversations/${conversationId}/handoff`, {}, null)).status, 401);
    assert.equal((await post(`/conversations/not-a-uuid/handoff`, {})).status, 404);
    assert.equal(await modeOf(conversationId), "bot");
  });

  test("reason 类型不对或过长：422；不带 reason 可以", async () => {
    const conversationId = await newConversation();
    assert.equal((await post(`/conversations/${conversationId}/handoff`, { reason: 123 })).status, 422);
    assert.equal((await post(`/conversations/${conversationId}/handoff`, { reason: "x".repeat(501) })).status, 422);
    assert.equal(await modeOf(conversationId), "bot");
    assert.equal((await post(`/conversations/${conversationId}/handoff`, {})).status, 200);
  });

  test("已关闭的会话：409 INVALID_STATE", async () => {
    const conversationId = await newConversation();
    await q("UPDATE conversations SET mode = 'closed' WHERE id = $1", [conversationId]);
    const res = await post(`/conversations/${conversationId}/handoff`, {});
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "INVALID_STATE");
  });
});

describe("老师接管与结束接管", () => {
  test("claim：queued → claimed，会话变 human，revision 加一，记录接管老师", async () => {
    const conversationId = await newConversation();
    const h = await requestHandoffVia(conversationId);
    const res = await claim(h.id, h.revision);
    assert.equal(res.status, 200);
    const claimed = await res.json();
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.teacherId, teacherId);
    assert.equal(claimed.revision, h.revision + 1);
    assert.equal(await modeOf(conversationId), "human");
  });

  test("重复接管：第二位老师拿到 409 INVALID_STATE，接管人不变（验收：重复接管状态冲突）", async () => {
    const conversationId = await newConversation();
    const h = await requestHandoffVia(conversationId);
    assert.equal((await claim(h.id, h.revision, teacherCookie)).status, 200);
    const second = await claim(h.id, h.revision, teacher2Cookie);
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, "INVALID_STATE");
    assert.equal((await q<{ teacher_id: string }>("SELECT teacher_id FROM handoffs WHERE id = $1", [h.id])).rows[0]!.teacher_id, teacherId);
    // 同一位老师再点一次也一样：接管不是幂等的"再接一次"。
    assert.equal((await claim(h.id, h.revision + 1, teacherCookie)).status, 409);
  });

  test("两位老师并发接管同一条：恰好一个成功，另一个 409", async () => {
    const conversationId = await newConversation();
    const h = await requestHandoffVia(conversationId);
    const results = await Promise.all([
      claim(h.id, h.revision, teacherCookie),
      claim(h.id, h.revision, teacher2Cookie),
      claim(h.id, h.revision, teacherCookie),
      claim(h.id, h.revision, teacher2Cookie),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409, 409, 409]);
    assert.equal(await count("SELECT count(*) AS n FROM handoffs WHERE conversation_id = $1 AND status = 'claimed'", [conversationId]), 1);
    assert.equal(await modeOf(conversationId), "human");
  });

  test("expectedRevision 已过期：409 REVISION_CONFLICT，记录没变", async () => {
    const conversationId = await newConversation();
    const h = await requestHandoffVia(conversationId);
    const res = await claim(h.id, h.revision + 5);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "REVISION_CONFLICT");
    assert.equal((await q<{ status: string }>("SELECT status FROM handoffs WHERE id = $1", [h.id])).rows[0]!.status, "queued");
    assert.equal(await modeOf(conversationId), "queued");
  });

  test("参数与权限：学员 403、未登录 401、缺 expectedRevision 422、不存在或非 uuid 404", async () => {
    const conversationId = await newConversation();
    const h = await requestHandoffVia(conversationId);
    assert.equal((await claim(h.id, h.revision, studentCookie)).status, 403);
    assert.equal((await post(`/teacher/handoffs/${h.id}/claim`, { expectedRevision: h.revision }, null)).status, 401);
    assert.equal((await post(`/teacher/handoffs/${h.id}/claim`, {}, teacherCookie)).status, 422);
    assert.equal((await claim("00000000-0000-4000-8000-000000000000", 1)).status, 404);
    assert.equal((await claim("nope", 1)).status, 404);
    assert.equal(await modeOf(conversationId), "queued");
  });

  test("release：只有接管人能结束；结束后会话回到 bot，之后可以再次请求接管（新记录）", async () => {
    const conversationId = await newConversation();
    const h = await requestHandoffVia(conversationId);
    const claimed = await (await claim(h.id, h.revision)).json();

    assert.equal((await release(h.id, claimed.revision, teacher2Cookie)).status, 403, "别的老师不能结束");
    assert.equal(await modeOf(conversationId), "human");
    assert.equal((await release(h.id, claimed.revision + 9)).status, 409, "版本旧了");

    const res = await release(h.id, claimed.revision);
    assert.equal(res.status, 200);
    const released = await res.json();
    assert.equal(released.status, "released");
    assert.equal(released.revision, claimed.revision + 1);
    assert.equal(await modeOf(conversationId), "bot");
    assert.equal((await release(h.id, released.revision)).status, 409, "已经结束，不能再结束");

    const again = await requestHandoffVia(conversationId);
    assert.notEqual(again.id, h.id);
    assert.equal(again.status, "queued");
  });

  test("交接摘要只给老师：学员侧（再次请求、读消息）不返回 summary；老师接管和结束的响应带着它", async () => {
    const conversationId = await newConversation();
    const created = await requestHandoff(db, { conversationId, reason: "r", summary: "给老师看的摘要" });
    assert.equal(created.kind, "queued");
    if (created.kind !== "queued") return;
    const handoffId = created.handoff.id;

    const again = await requestHandoffVia(conversationId);
    assert.equal(again.id, handoffId);
    assert.ok(!("summary" in again), "请求接管的响应不能带摘要");
    const list = await (await get(`/conversations/${conversationId}/messages`)).json();
    assert.equal(list.handoff.id, handoffId);
    assert.ok(!("summary" in list.handoff), "读消息时的 handoff 不能带摘要");

    const claimed = await (await claim(handoffId, 1)).json();
    assert.equal(claimed.summary, "给老师看的摘要");
    const released = await (await release(handoffId, claimed.revision)).json();
    assert.equal(released.summary, "给老师看的摘要");
  });

  test("还在排队（没人接管）就结束：409 INVALID_STATE", async () => {
    const h = await requestHandoffVia(await newConversation());
    const res = await release(h.id, h.revision);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "INVALID_STATE");
  });
});

describe("AC-012：接管期间学员发言，机器人不抢答", () => {
  test("排队中：消息被记录（老师能看到），不启动运行、不调用 Agent，响应是单个 handoff.status 事件", async () => {
    const conversationId = await newConversation();
    await requestHandoffVia(conversationId);
    const before = agent.calls.length;

    const res = await studentSays(conversationId, "有人在吗", "q1");
    assert.equal(res.status, 200);
    const events = sseEvents(await res.text());
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "handoff.status");
    assert.deepEqual(events[0]!.payload, { mode: "queued" });

    assert.equal(agent.calls.length, before, "机器人没有被叫到");
    assert.equal(await count("SELECT count(*) AS n FROM runs WHERE conversation_id = $1", [conversationId]), 0);
    const msg = (await q("SELECT role, content, run_id FROM messages WHERE conversation_id = $1", [conversationId])).rows;
    assert.deepEqual(msg, [{ role: "user", content: "有人在吗", run_id: null }]);
  });

  test("老师接管后：学员再发言仍只被记录；老师回复出现在会话里，全程没有机器人的消息", async () => {
    const conversationId = await newConversation();
    const h = await requestHandoffVia(conversationId);
    await claim(h.id, h.revision);
    const before = agent.calls.length;

    const said = await studentSays(conversationId, "我的转班申请怎么样了", "h1");
    assert.equal(sseEvents(await said.text())[0]!.payload.mode, "human");
    const reply = await teacherSays(conversationId, "我帮你看一下", "t-1");
    assert.equal(reply.status, 201);
    assert.equal((await reply.json()).role, "teacher");

    assert.equal(agent.calls.length, before);
    const list = await (await get(`/conversations/${conversationId}/messages`)).json();
    assert.deepEqual(list.items.map((m: { role: string; content: string }) => [m.role, m.content]), [
      ["user", "我的转班申请怎么样了"],
      ["teacher", "我帮你看一下"],
    ]);
    assert.equal(list.mode, "human");
    assert.equal(list.handoff.status, "claimed");
    assert.equal(list.handoff.teacherId, teacherId);
  });

  test("同一个 clientMessageId 重试：只记录一条；结束接管之后再重试它，也不会补一次机器人回复", async () => {
    const conversationId = await newConversation();
    const h = await requestHandoffVia(conversationId);
    const claimed = await (await claim(h.id, h.revision)).json();
    await studentSays(conversationId, "重要问题", "dup-1");
    await studentSays(conversationId, "重要问题", "dup-1");
    assert.equal(await count("SELECT count(*) AS n FROM messages WHERE conversation_id = $1", [conversationId]), 1);

    await release(h.id, claimed.revision);
    const before = agent.calls.length;
    const retry = await studentSays(conversationId, "重要问题", "dup-1");
    assert.equal(retry.status, 200);
    assert.equal(sseEvents(await retry.text())[0]!.payload.mode, "bot");
    assert.equal(agent.calls.length, before, "那条消息当时是老师在处理的，不因为机器人回来了就再答一次");
    assert.equal(await count("SELECT count(*) AS n FROM runs WHERE conversation_id = $1", [conversationId]), 0);
  });

  test("结束接管之后：新的消息重新交给机器人（运行被创建、Agent 被调用）", async () => {
    const conversationId = await newConversation();
    const h = await requestHandoffVia(conversationId);
    const claimed = await (await claim(h.id, h.revision)).json();
    await release(h.id, claimed.revision);
    const before = agent.calls.length;

    const res = await studentSays(conversationId, "老师，谢谢，还有个问题", "back-1");
    assert.equal(res.status, 200);
    const events = sseEvents(await res.text());
    assert.equal(events.at(-1)!.type, "message.completed");
    assert.equal(agent.calls.length, before + 1);
  });

  test("接管中不能恢复 Agent：/resume 返回 409 HANDOFF_ACTIVE，且没有创建运行", async () => {
    const conversationId = await newConversation();
    await requestHandoffVia(conversationId);
    const res = await post(`/conversations/${conversationId}/resume`, undefined);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "HANDOFF_ACTIVE");
    assert.equal(await count("SELECT count(*) AS n FROM runs WHERE conversation_id = $1", [conversationId]), 0);
  });

  test("会话已关闭：学员发消息 409 INVALID_STATE，什么都没记录", async () => {
    const conversationId = await newConversation();
    await q("UPDATE conversations SET mode = 'closed' WHERE id = $1", [conversationId]);
    const res = await studentSays(conversationId, "还能发吗", "closed-1");
    assert.equal(res.status, 409);
    assert.equal(await count("SELECT count(*) AS n FROM messages WHERE conversation_id = $1", [conversationId]), 0);
  });
});

// 下面三条保护同一件事：业务函数读到的"谁在应答"，在它提交之前不能被接管/结束接管悄悄改掉。
// 做法：另开一个连接，开事务、做一次"未提交"的状态修改并持有行锁，再调用业务函数——
// 它必须等这个事务提交之后才读，读到的是提交后的新状态。若业务函数用的是普通 SELECT（读旧快照），
// 它会立刻返回，并在"老师已经接管"的会话里启动机器人 / 在"老师已经结束接管"的会话里写老师消息。
async function whileHolding<T>(setup: string[], work: () => Promise<T>): Promise<{ stillWaiting: boolean; result: T }> {
  const holder = new pg.Client({ connectionString: testUrl, options: "-c search_path=app" });
  await holder.connect();
  try {
    await holder.query("BEGIN");
    for (const sql of setup) await holder.query(sql);
    let done = false;
    const pending = work().then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    const stillWaiting = !done;
    await holder.query("COMMIT");
    return { stillWaiting, result: await pending };
  } finally {
    await holder.end();
  }
}

describe("并发仲裁：读到的状态在提交前不会被改掉（FOR SHARE）", () => {
  test("学员发消息 vs 老师接管：接管提交之前，消息事务必须等待；等到之后看到 human，只记录、不启动机器人", async () => {
    const conversationId = await newConversation();
    const { stillWaiting, result } = await whileHolding(
      [`UPDATE conversations SET mode = 'human' WHERE id = '${conversationId}'`],
      () => startMessageRun(db, { conversationId, clientMessageId: "race-1", text: "接管的同时发的话" }),
    );
    assert.equal(stillWaiting, true, "消息事务没有等待接管提交，说明它读的是旧快照");
    assert.equal(result.kind, "recorded");
    assert.equal(await count("SELECT count(*) AS n FROM runs WHERE conversation_id = $1", [conversationId]), 0, "接管之后不能再启动机器人");
  });

  test("学员确认后恢复 vs 老师接管：同样必须等待，看到 human 返回 handoff_active，不创建运行", async () => {
    const conversationId = await newConversation();
    const { stillWaiting, result } = await whileHolding(
      [`UPDATE conversations SET mode = 'human' WHERE id = '${conversationId}'`],
      () => startResumeRun(db, conversationId),
    );
    assert.equal(stillWaiting, true);
    assert.equal(result.kind, "handoff_active");
    assert.equal(await count("SELECT count(*) AS n FROM runs WHERE conversation_id = $1", [conversationId]), 0);
  });

  test("老师发消息 vs 结束接管：结束提交之前，发消息必须等待；等到之后发现已不在接管中，不写消息", async () => {
    const conversationId = await newConversation();
    const h = await requestHandoffVia(conversationId);
    const claimed = await (await claim(h.id, h.revision)).json();
    const { stillWaiting, result } = await whileHolding(
      [
        `UPDATE handoffs SET status = 'released', released_at = now() WHERE id = '${h.id}'`,
        `UPDATE conversations SET mode = 'bot' WHERE id = '${conversationId}'`,
      ],
      () => teacherSendMessage(db, { conversationId, teacherId, clientMessageId: "race-2", text: "结束接管的同时发的话" }),
    );
    assert.equal(claimed.status, "claimed");
    assert.equal(stillWaiting, true);
    assert.equal(result.kind, "not_human");
    assert.equal(await count("SELECT count(*) AS n FROM messages WHERE conversation_id = $1", [conversationId]), 0);
  });
});

describe("老师发消息", () => {
  test("只有接管这个会话的老师能发：没接管 409、别的老师 403、学员 403、参数错 422、会话不存在 404", async () => {
    const conversationId = await newConversation();
    assert.equal((await teacherSays(conversationId, "x", "a")).status, 409, "机器人负责的会话");
    const h = await requestHandoffVia(conversationId);
    assert.equal((await teacherSays(conversationId, "x", "b")).status, 409, "只是排队，还没人接管");
    await claim(h.id, h.revision);
    assert.equal((await teacherSays(conversationId, "x", "c", teacher2Cookie)).status, 403);
    assert.equal((await teacherSays(conversationId, "x", "d", studentCookie)).status, 403);
    assert.equal((await post(`/teacher/conversations/${conversationId}/messages`, { text: "缺 id" }, teacherCookie)).status, 422);
    assert.equal((await teacherSays("00000000-0000-4000-8000-000000000000", "x", "e")).status, 404);
    assert.equal(await count("SELECT count(*) AS n FROM messages WHERE conversation_id = $1", [conversationId]), 0);
  });

  test("重复 clientMessageId：200 返回原消息，不再写第二条；被别的消息占用的 id：422", async () => {
    const conversationId = await newConversation();
    const h = await requestHandoffVia(conversationId);
    await claim(h.id, h.revision);
    const first = await (await teacherSays(conversationId, "第一句", "same")).json();
    const again = await teacherSays(conversationId, "第一句", "same");
    assert.equal(again.status, 200);
    assert.equal((await again.json()).id, first.id);
    assert.equal(await count("SELECT count(*) AS n FROM messages WHERE conversation_id = $1", [conversationId]), 1);

    await studentSays(conversationId, "学员的话", "student-id");
    assert.equal((await teacherSays(conversationId, "冒用", "student-id")).status, 422);
  });

  test("结束接管之后老师不能再发", async () => {
    const conversationId = await newConversation();
    const h = await requestHandoffVia(conversationId);
    const claimed = await (await claim(h.id, h.revision)).json();
    await release(h.id, claimed.revision);
    assert.equal((await teacherSays(conversationId, "还想补一句", "late")).status, 409);
  });
});

describe("数据库约束（绕过应用层直接写也挡得住）", () => {
  test("同一会话不能有两条进行中的接管", async () => {
    const conversationId = await newConversation();
    await q("INSERT INTO handoffs (conversation_id, status) VALUES ($1, 'queued')", [conversationId]);
    await assert.rejects(q("INSERT INTO handoffs (conversation_id, status) VALUES ($1, 'queued')", [conversationId]), /handoffs_one_active_per_conversation/);
  });

  test("状态与字段互相印证：排队的不能有老师，接管的必须有老师，结束的必须有结束时间", async () => {
    const conversationId = await newConversation();
    await assert.rejects(q("INSERT INTO handoffs (conversation_id, status, teacher_id) VALUES ($1, 'queued', $2)", [conversationId, teacherId]));
    await assert.rejects(q("INSERT INTO handoffs (conversation_id, status) VALUES ($1, 'claimed')", [conversationId]));
    await assert.rejects(
      q("INSERT INTO handoffs (conversation_id, status, teacher_id, claimed_at) VALUES ($1, 'released', $2, now())", [conversationId, teacherId]),
    );
  });
});

// 交接摘要样例，及"Agent 认为该转人工"的两步事件（handoff.requested → message.completed）。工作台的队列/消息测试也用得到。
const SUMMARY = "【学员诉求】\n- “我要找老师”\n【已核验事实】\n- 无";
const requested = (payload: Record<string, unknown>) => ({ type: "handoff.requested", payload });
const done = { type: "message.completed", payload: { text: "好的，我已经帮你转接老师。" } };

// 22b：Agent 认为该转人工时，通过事件流发 handoff.requested，由 BFF 落库（业务 API 对 Agent 通道关闭了 /conversations/*）。
describe("Agent 交来的转人工请求（handoff.requested）", () => {
  test("落库：会话进入排队，原因和摘要保存；浏览器只收到 handoff.status 和最终回复，看不到原始事件和摘要", async () => {
    const conversationId = await newConversation();
    agent.script = [requested({ reason: "学员主动请求转人工", summary: SUMMARY }), done];

    const res = await studentSays(conversationId, "我要找老师", "ag-1");
    const text = await res.text();
    const types = sseEvents(text).map((e) => e.type);
    assert.deepEqual(types, ["handoff.status", "message.completed"]);
    assert.deepEqual(sseEvents(text)[0]!.payload, { mode: "queued" });
    assert.ok(!text.includes("handoff.requested"), "原始事件不能转发给浏览器");
    assert.ok(!text.includes("已核验事实"), "交接摘要不能出现在学员的响应里");

    const h = (await q("SELECT status, reason, summary FROM handoffs WHERE conversation_id = $1", [conversationId])).rows;
    assert.deepEqual(h, [{ status: "queued", reason: "学员主动请求转人工", summary: SUMMARY }]);
    assert.equal(await modeOf(conversationId), "queued");
    // 这一轮的机器人回复照常落库；之后的消息才进入"只记录"。
    assert.equal(await count("SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND role = 'assistant'", [conversationId]), 1);
  });

  test("之后学员再发言：只被记录，机器人不再被叫到", async () => {
    const conversationId = await newConversation();
    agent.script = [requested({ reason: "r", summary: SUMMARY }), done];
    await (await studentSays(conversationId, "转人工", "ag-2a")).text();
    const before = agent.calls.length;

    const res = await studentSays(conversationId, "在吗", "ag-2b");
    assert.equal(sseEvents(await res.text())[0]!.payload.mode, "queued");
    assert.equal(agent.calls.length, before);
  });

  test("事件重复（图恢复/重跑）：幂等，仍只有一条记录，也不覆盖第一次的原因和摘要", async () => {
    const conversationId = await newConversation();
    agent.script = [requested({ reason: "第一次", summary: "摘要一" }), requested({ reason: "第二次", summary: "摘要二" }), done];
    await (await studentSays(conversationId, "找老师", "ag-3")).text();
    const h = (await q("SELECT reason, summary FROM handoffs WHERE conversation_id = $1", [conversationId])).rows;
    assert.deepEqual(h, [{ reason: "第一次", summary: "摘要一" }]);
  });

  test("Agent 说了什么都不可信：非字符串字段当作没有，过长的摘要被截断，事件里夹带的别的会话 id 被忽略", async () => {
    const conversationId = await newConversation();
    const victimId = await newConversation(otherStudentId);
    agent.script = [
      requested({ reason: 123, summary: "字".repeat(5000), conversationId: victimId, ownerId: otherStudentId }),
      done,
    ];
    await (await studentSays(conversationId, "转人工", "ag-4")).text();

    const h = (await q<{ reason: string | null; len: number }>("SELECT reason, char_length(summary) AS len FROM handoffs WHERE conversation_id = $1", [conversationId])).rows;
    assert.deepEqual(h, [{ reason: null, len: 4000 }]);
    assert.equal(await modeOf(victimId), "bot", "别人的会话不受影响");
    assert.equal(await count("SELECT count(*) AS n FROM handoffs WHERE conversation_id = $1", [victimId]), 0);
  });

  test("摘要缺失也能转人工：原因、摘要都是 NULL，会话照样进入排队", async () => {
    const conversationId = await newConversation();
    agent.script = [requested({}), done];
    await (await studentSays(conversationId, "转人工", "ag-5")).text();
    const h = (await q("SELECT status, reason, summary FROM handoffs WHERE conversation_id = $1", [conversationId])).rows;
    assert.deepEqual(h, [{ status: "queued", reason: null, summary: null }]);
  });
});

// T-23：老师会话工作台——待接管/已接管队列，以及已接管会话的消息历史。
const queue = async (cookie = teacherCookie) => (await get("/teacher/handoffs", cookie)).json();
const teacherMessages = async (conversationId: string, cookie = teacherCookie) =>
  await get(`/teacher/conversations/${conversationId}/messages`, cookie);

describe("老师工作台：队列（GET /teacher/handoffs）", () => {
  test("只列进行中（排队+已接管）的记录，按发起时间从旧到新；已结束的不在里面", async () => {
    // 队列是全局共享的（不按会话隔离），所以只断言这三条各自的顺序关系与是否出现，不假设队列里只有它们。
    const c1 = await newConversation();
    const { id: h1 } = await requestHandoffVia(c1, "先来的");
    const c2 = await newConversation();
    const { id: h2, revision: rev2 } = await requestHandoffVia(c2, "后来的");
    await claim(h2, rev2); // c2 变成已接管，仍应出现

    const c3 = await newConversation();
    const { id: h3, revision: rev3 } = await requestHandoffVia(c3, "已经结束的");
    const claimed3 = await (await claim(h3, rev3)).json();
    await release(h3, claimed3.revision); // released：不该出现

    const { items } = await queue();
    const ids: string[] = items.map((h: { id: string }) => h.id);
    assert.ok(ids.indexOf(h1) < ids.indexOf(h2), "h1 比 h2 先发起，队列里也该在它前面");
    assert.equal(items.find((h: { id: string }) => h.id === h1).status, "queued");
    assert.equal(items.find((h: { id: string }) => h.id === h2).status, "claimed");
    assert.ok(!ids.includes(h3), "已结束的接管不该出现在队列里");
  });

  test("带交接摘要（老师视角）；学员直接点按钮转人工的没有摘要（null）", async () => {
    const conversationId = await newConversation();
    agent.script = [requested({ reason: "学员主动请求转人工", summary: SUMMARY }), done];
    await (await studentSays(conversationId, "转人工", "wb-1")).text();

    const { items } = await queue();
    const mine = items.find((h: { conversationId: string }) => h.conversationId === conversationId);
    assert.equal(mine.summary, SUMMARY);

    const c2 = await newConversation();
    await requestHandoffVia(c2, "手动点的");
    const { items: items2 } = await queue();
    assert.equal(items2.find((h: { conversationId: string }) => h.conversationId === c2).summary, null);
  });

  test("学员访问返回 403", async () => {
    const res = await get("/teacher/handoffs", studentCookie);
    assert.equal(res.status, 403);
  });
});

describe("老师工作台：会话消息（GET /teacher/conversations/:id/messages）", () => {
  test("排队中还没人接管：409 INVALID_STATE", async () => {
    const conversationId = await newConversation();
    await requestHandoffVia(conversationId);
    assert.equal((await teacherMessages(conversationId)).status, 409);
  });

  test("被另一位老师接管：403，不泄露对话内容", async () => {
    const conversationId = await newConversation();
    const { id, revision } = await requestHandoffVia(conversationId);
    await claim(id, revision, teacherCookie);
    assert.equal((await teacherMessages(conversationId, teacher2Cookie)).status, 403);
  });

  test("接管人能看到完整历史（学员+老师消息）和交接摘要", async () => {
    const conversationId = await newConversation();
    agent.script = [requested({ reason: "学员主动请求转人工", summary: SUMMARY }), done];
    await (await studentSays(conversationId, "我要找老师", "wb-2a")).text();
    await (await studentSays(conversationId, "还在吗", "wb-2b")).text();

    const handoffId = await id("SELECT id FROM handoffs WHERE conversation_id = $1", [conversationId]);
    const claimed = await (await claim(handoffId, 1, teacherCookie)).json();
    await teacherSays(conversationId, "我在的，请说", "wb-2c", teacherCookie);

    const body = await (await teacherMessages(conversationId)).json();
    assert.deepEqual(
      body.items.map((m: { role: string; content: string }) => [m.role, m.content]),
      [
        ["user", "我要找老师"],
        ["assistant", "好的，我已经帮你转接老师。"],
        ["user", "还在吗"],
        ["teacher", "我在的，请说"],
      ],
    );
    assert.equal(body.handoff.id, claimed.id);
    assert.equal(body.handoff.summary, SUMMARY);
  });

  test("带 after 只返回它之后的新消息，供老师工作台轮询用", async () => {
    const conversationId = await newConversation();
    const { id: handoffId, revision } = await requestHandoffVia(conversationId);
    await claim(handoffId, revision, teacherCookie);
    await studentSays(conversationId, "还在吗", "wb-after-1");

    const first = (await (await teacherMessages(conversationId)).json()).items;
    assert.equal(first.length, 1);

    const empty = await (await get(`/teacher/conversations/${conversationId}/messages?after=${first[0].id}`, teacherCookie)).json();
    assert.deepEqual(empty.items, []);

    await teacherSays(conversationId, "我在的", "wb-after-2", teacherCookie);
    const incremental = await (await get(`/teacher/conversations/${conversationId}/messages?after=${first[0].id}`, teacherCookie)).json();
    assert.deepEqual(incremental.items.map((m: { role: string; content: string }) => [m.role, m.content]), [["teacher", "我在的"]]);
  });

  test("结束接管之后：不再是接管人，409（不能翻看已经放回机器人的会话）", async () => {
    const conversationId = await newConversation();
    const { id: handoffId, revision } = await requestHandoffVia(conversationId);
    const claimed = await (await claim(handoffId, revision, teacherCookie)).json();
    await release(handoffId, claimed.revision, teacherCookie);
    assert.equal((await teacherMessages(conversationId)).status, 409);
  });

  test("会话不存在（合法 UUID 但没有这条会话）：409，不额外泄露会话是否存在", async () => {
    // 没有进行中的 handoff，和"排队中没人接管"走同一分支。
    assert.equal((await teacherMessages("00000000-0000-0000-0000-000000000000")).status, 409);
  });

  test("学员访问返回 403", async () => {
    const conversationId = await newConversation();
    const { id: handoffId, revision } = await requestHandoffVia(conversationId);
    await claim(handoffId, revision, teacherCookie);
    assert.equal((await teacherMessages(conversationId, studentCookie)).status, 403);
  });
});

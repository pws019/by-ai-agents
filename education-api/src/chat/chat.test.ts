// 会话与运行的规格（T-20 / 20b）。全部跑在真实临时数据库上，不 mock：
// 这里保护的都是"数据库层面的仲裁"——并发抢锁、消息去重、租约过期、迟到结果的丢弃——mock 无法证明它们成立。
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
import { completeRun, failRun, heartbeat, startMessageRun } from "./runs.js";

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
let studentId: string;
let otherStudentId: string;
let teacherId: string;
let studentCookie: string;
let otherCookie: string;
let teacherCookie: string;

const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
const id = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;
const newConversation = (ownerId = studentId) => id("INSERT INTO conversations (owner_id) VALUES ($1) RETURNING id", [ownerId]);
const count = async (sql: string, params: unknown[] = []) => Number((await q<{ n: string }>(sql, params)).rows[0]!.n);
const expireLease = (runId: string) => q("UPDATE runs SET lease_until = now() - interval '1 second' WHERE id = $1", [runId]);

before(async () => {
  admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl, migrationsDir);
  pool = createPool(testUrl);
  db = createDb(pool);
  app = createApp(pool, { allowedOrigin: ORIGIN, internalAuthSecret: "chat-test-secret" });

  teacherId = await id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('t','x','老师','teacher') RETURNING id");
  studentId = await id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s','x','学员','student') RETURNING id");
  otherStudentId = await id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s2','x','学员2','student') RETURNING id");
  studentCookie = `edu_session=${(await createSession(db, studentId)).token}`;
  otherCookie = `edu_session=${(await createSession(db, otherStudentId)).token}`;
  teacherCookie = `edu_session=${(await createSession(db, teacherId)).token}`;
});

after(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe("开启一次运行", () => {
  test("成功：同时产生一条 running 的 run 和一条用户消息，二者互相关联", async () => {
    const conversationId = await newConversation();
    const r = await startMessageRun(db, { conversationId, clientMessageId: "m1", text: "我想转班" });
    assert.equal(r.kind, "started");
    if (r.kind !== "started") return;
    const run = (await q("SELECT status, lease_until > now() AS leased FROM runs WHERE id = $1", [r.runId])).rows[0];
    assert.deepEqual(run, { status: "running", leased: true });
    const msg = (await q("SELECT role, content, run_id FROM messages WHERE id = $1", [r.userMessageId])).rows[0];
    assert.deepEqual(msg, { role: "user", content: "我想转班", run_id: r.runId });
  });

  test("会话正在生成时再发一条不同的消息：busy，且什么都没写进去（事务整体回滚）", async () => {
    const conversationId = await newConversation();
    const first = await startMessageRun(db, { conversationId, clientMessageId: "a", text: "第一条" });
    const second = await startMessageRun(db, { conversationId, clientMessageId: "b", text: "第二条" });
    assert.equal(second.kind, "busy");
    if (first.kind === "started" && second.kind === "busy") assert.equal(second.runId, first.runId);
    assert.equal(await count("SELECT count(*) n FROM runs WHERE conversation_id = $1", [conversationId]), 1);
    assert.equal(await count("SELECT count(*) n FROM messages WHERE conversation_id = $1", [conversationId]), 1);
  });

  test("并发：5 个不同的消息同时到达，恰好 1 个拿到锁，其余 busy", async () => {
    const conversationId = await newConversation();
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => startMessageRun(db, { conversationId, clientMessageId: `c${n}`, text: `消息${n}` })),
    );
    assert.equal(results.filter((r) => r.kind === "started").length, 1);
    assert.equal(results.filter((r) => r.kind === "busy").length, 4);
    assert.equal(await count("SELECT count(*) n FROM runs WHERE conversation_id = $1 AND status = 'running'", [conversationId]), 1);
    assert.equal(await count("SELECT count(*) n FROM messages WHERE conversation_id = $1", [conversationId]), 1);
  });
});

describe("clientMessageId 去重（AC-021）", () => {
  test("同一个 clientMessageId 重复提交：不产生第二个 run 或第二条消息", async () => {
    const conversationId = await newConversation();
    const args = { conversationId, clientMessageId: "dup", text: "我想转班" };
    const first = await startMessageRun(db, args);
    const again = await startMessageRun(db, args);
    assert.equal(first.kind, "started");
    assert.equal(again.kind, "duplicate");
    assert.equal(await count("SELECT count(*) n FROM runs WHERE conversation_id = $1", [conversationId]), 1);
    assert.equal(await count("SELECT count(*) n FROM messages WHERE conversation_id = $1", [conversationId]), 1);
  });

  test("原 run 已完成：重复提交拿回原来的助手回答", async () => {
    const conversationId = await newConversation();
    const args = { conversationId, clientMessageId: "done", text: "hi" };
    const first = await startMessageRun(db, args);
    assert.equal(first.kind, "started");
    if (first.kind !== "started") return;
    const assistantId = await completeRun(db, first.runId, "你好呀");

    const again = await startMessageRun(db, args);
    assert.equal(again.kind, "duplicate");
    if (again.kind !== "duplicate") return;
    assert.equal(again.run.status, "completed");
    assert.deepEqual(again.assistantMessage, { id: assistantId, content: "你好呀" });
  });

  test("先判重、后判忙：已完成消息的重复提交，即使此刻会话里有别的 run 在跑，也返回原结果而不是 busy", async () => {
    const conversationId = await newConversation();
    const old = await startMessageRun(db, { conversationId, clientMessageId: "old", text: "旧消息" });
    if (old.kind !== "started") return assert.fail();
    await completeRun(db, old.runId, "旧回答");
    const running = await startMessageRun(db, { conversationId, clientMessageId: "new", text: "新消息" });
    assert.equal(running.kind, "started");

    const retryOld = await startMessageRun(db, { conversationId, clientMessageId: "old", text: "旧消息" });
    assert.equal(retryOld.kind, "duplicate");
  });

  test("原 run 失败：重复提交看到的是失败（要重试请换新的 clientMessageId）", async () => {
    const conversationId = await newConversation();
    const first = await startMessageRun(db, { conversationId, clientMessageId: "f", text: "x" });
    if (first.kind !== "started") return assert.fail();
    await failRun(db, first.runId, "INTERNAL");
    const again = await startMessageRun(db, { conversationId, clientMessageId: "f", text: "x" });
    assert.equal(again.kind, "duplicate");
    if (again.kind === "duplicate") assert.deepEqual([again.run.status, again.run.errorCode], ["failed", "INTERNAL"]);
  });

  test("并发的重复提交：5 个相同 clientMessageId 同时到达，只产生 1 个 run、1 条消息，其余都被识别为重复", async () => {
    const conversationId = await newConversation();
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => startMessageRun(db, { conversationId, clientMessageId: "same", text: "同一条" })),
    );
    assert.equal(results.filter((r) => r.kind === "started").length, 1);
    assert.equal(results.filter((r) => r.kind === "duplicate").length, 4, "重复提交不该被误报成 busy");
    assert.equal(await count("SELECT count(*) n FROM messages WHERE conversation_id = $1", [conversationId]), 1);
    assert.equal(await count("SELECT count(*) n FROM runs WHERE conversation_id = $1", [conversationId]), 1);
  });

  test("数据库约束兜底：同一会话同一 clientMessageId 手工插两条用户消息，第二条被拒绝", async () => {
    // 应用层的判重覆盖不到"两个请求都通过了判重、其中一个的整个 run 在另一个插入之前就已完成"这种窄竞态，
    // 最后一道防线是这条唯一索引，这里直接证明它存在。
    const conversationId = await newConversation();
    const first = await startMessageRun(db, { conversationId, clientMessageId: "k", text: "a" });
    if (first.kind !== "started") return assert.fail();
    await completeRun(db, first.runId, "ok");
    const second = await id("INSERT INTO runs (conversation_id, kind, status, lease_until) VALUES ($1,'message','running', now() + interval '90 seconds') RETURNING id", [conversationId]);
    await assert.rejects(
      q("INSERT INTO messages (conversation_id, role, content, client_message_id, run_id) VALUES ($1,'user','b','k',$2)", [conversationId, second]),
    );
  });

  test("不同会话里的相同 clientMessageId 互不影响", async () => {
    const a = await newConversation();
    const b = await newConversation();
    assert.equal((await startMessageRun(db, { conversationId: a, clientMessageId: "x", text: "1" })).kind, "started");
    assert.equal((await startMessageRun(db, { conversationId: b, clientMessageId: "x", text: "2" })).kind, "started");
  });
});

describe("租约（90 秒）", () => {
  test("租约过期的 run 会被新消息接管：旧 run 记为 LEASE_EXPIRED，新 run 开始", async () => {
    const conversationId = await newConversation();
    const old = await startMessageRun(db, { conversationId, clientMessageId: "1", text: "a" });
    if (old.kind !== "started") return assert.fail();
    await expireLease(old.runId);

    const next = await startMessageRun(db, { conversationId, clientMessageId: "2", text: "b" });
    assert.equal(next.kind, "started");
    const row = (await q("SELECT status, error_code FROM runs WHERE id = $1", [old.runId])).rows[0];
    assert.deepEqual(row, { status: "failed", error_code: "LEASE_EXPIRED" });
  });

  test("租约未过期的 run 不会被接管", async () => {
    const conversationId = await newConversation();
    await startMessageRun(db, { conversationId, clientMessageId: "1", text: "a" });
    assert.equal((await startMessageRun(db, { conversationId, clientMessageId: "2", text: "b" })).kind, "busy");
  });

  test("迟到的结果被丢弃：被接管的旧 run 之后才完成，不能写出助手消息，也不能把自己改回 completed", async () => {
    const conversationId = await newConversation();
    const old = await startMessageRun(db, { conversationId, clientMessageId: "1", text: "a" });
    if (old.kind !== "started") return assert.fail();
    await expireLease(old.runId);
    await startMessageRun(db, { conversationId, clientMessageId: "2", text: "b" });

    assert.equal(await completeRun(db, old.runId, "迟到的回答"), null);
    assert.equal(await count("SELECT count(*) n FROM messages WHERE conversation_id = $1 AND role = 'assistant'", [conversationId]), 0);
    assert.equal((await q("SELECT status FROM runs WHERE id = $1", [old.runId])).rows[0]!.status, "failed");
  });

  test("续租：延长运行中 run 的租约；对已结束的 run 无效并返回 false（提示调用方停止工作）", async () => {
    const conversationId = await newConversation();
    const r = await startMessageRun(db, { conversationId, clientMessageId: "1", text: "a" });
    if (r.kind !== "started") return assert.fail();
    await expireLease(r.runId);
    // 续租发生在过期之后、被接管之前：仍是 running，可以续上。
    assert.equal(await heartbeat(db, r.runId), true);
    assert.equal(await count("SELECT count(*) n FROM runs WHERE id = $1 AND lease_until > now() + interval '80 seconds'", [r.runId]), 1);

    await completeRun(db, r.runId, "ok");
    assert.equal(await heartbeat(db, r.runId), false);
  });

  test("读取状态时也会回收过期租约：重试早已死掉的 run，看到的是失败而不是永远'生成中'", async () => {
    const conversationId = await newConversation();
    const r = await startMessageRun(db, { conversationId, clientMessageId: "1", text: "a" });
    if (r.kind !== "started") return assert.fail();
    await expireLease(r.runId);
    const again = await startMessageRun(db, { conversationId, clientMessageId: "1", text: "a" });
    assert.equal(again.kind, "duplicate");
    if (again.kind === "duplicate") assert.deepEqual([again.run.status, again.run.errorCode], ["failed", "LEASE_EXPIRED"]);
  });
});

describe("完成与失败", () => {
  test("完成：run 变 completed，写入一条与它关联的助手消息", async () => {
    const conversationId = await newConversation();
    const r = await startMessageRun(db, { conversationId, clientMessageId: "1", text: "a" });
    if (r.kind !== "started") return assert.fail();
    const mid = await completeRun(db, r.runId, "回答");
    assert.ok(mid);
    const msg = (await q("SELECT role, content, run_id FROM messages WHERE id = $1", [mid])).rows[0];
    assert.deepEqual(msg, { role: "assistant", content: "回答", run_id: r.runId });
  });

  test("重复触发完成：第二次返回 null，不会写出第二条助手消息", async () => {
    const conversationId = await newConversation();
    const r = await startMessageRun(db, { conversationId, clientMessageId: "1", text: "a" });
    if (r.kind !== "started") return assert.fail();
    assert.ok(await completeRun(db, r.runId, "回答"));
    assert.equal(await completeRun(db, r.runId, "回答"), null);
    assert.equal(await count("SELECT count(*) n FROM messages WHERE run_id = $1 AND role = 'assistant'", [r.runId]), 1);
  });

  test("已完成的 run 不能再被标记为失败", async () => {
    const conversationId = await newConversation();
    const r = await startMessageRun(db, { conversationId, clientMessageId: "1", text: "a" });
    if (r.kind !== "started") return assert.fail();
    await completeRun(db, r.runId, "回答");
    assert.equal(await failRun(db, r.runId, "INTERNAL"), false);
    assert.equal((await q("SELECT status FROM runs WHERE id = $1", [r.runId])).rows[0]!.status, "completed");
  });

  test("数据库约束兜底：同一个 run 手工插第二条助手消息会被拒绝", async () => {
    const conversationId = await newConversation();
    const r = await startMessageRun(db, { conversationId, clientMessageId: "1", text: "a" });
    if (r.kind !== "started") return assert.fail();
    await completeRun(db, r.runId, "回答");
    await assert.rejects(q("INSERT INTO messages (conversation_id, role, content, run_id) VALUES ($1,'assistant','再来一条',$2)", [conversationId, r.runId]));
  });
});

describe("会话接口", () => {
  const call = (method: string, path: string, cookie?: string) =>
    app.request(`/api/v1${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: ORIGIN } });

  test("创建会话；列表只包含本人的", async () => {
    const created = await (await call("POST", "/conversations", studentCookie)).json();
    const other = await (await call("POST", "/conversations", otherCookie)).json();
    const mine = (await (await call("GET", "/conversations", studentCookie)).json()).items.map((c: { id: string }) => c.id);
    assert.ok(mine.includes(created.id));
    assert.ok(!mine.includes(other.id));
  });

  test("未登录 401；老师角色 403", async () => {
    assert.equal((await call("POST", "/conversations")).status, 401);
    assert.equal((await call("POST", "/conversations", teacherCookie)).status, 403);
  });

  test("读取消息：返回已存消息（按时间正序）和最近一次运行的状态", async () => {
    const conversationId = await newConversation();
    const r = await startMessageRun(db, { conversationId, clientMessageId: "1", text: "你好" });
    if (r.kind !== "started") return assert.fail();
    await completeRun(db, r.runId, "你好呀");

    const body = await (await call("GET", `/conversations/${conversationId}/messages`, studentCookie)).json();
    assert.deepEqual(body.items.map((m: { role: string; content: string }) => [m.role, m.content]), [["user", "你好"], ["assistant", "你好呀"]]);
    assert.equal(body.run.status, "completed");
  });

  test("读取消息时过期租约被回收：断线后重连看到的是失败，不是永远生成中", async () => {
    const conversationId = await newConversation();
    const r = await startMessageRun(db, { conversationId, clientMessageId: "1", text: "你好" });
    if (r.kind !== "started") return assert.fail();
    await expireLease(r.runId);
    const body = await (await call("GET", `/conversations/${conversationId}/messages`, studentCookie)).json();
    assert.deepEqual([body.run.status, body.run.errorCode], ["failed", "LEASE_EXPIRED"]);
  });

  test("别人的会话和不存在的会话一样：404", async () => {
    const conversationId = await newConversation(studentId);
    assert.equal((await call("GET", `/conversations/${conversationId}/messages`, otherCookie)).status, 404);
    assert.equal((await call("GET", `/conversations/00000000-0000-0000-0000-00000000dead/messages`, studentCookie)).status, 404);
  });

  test("Agent 通道不能读写会话（会话是用户与 BFF 之间的东西）", async () => {
    const conversationId = await newConversation(studentId);
    const token = signInternalContext({ actorId: studentId, role: "student", requestId: "r" }, "chat-test-secret");
    for (const [method, path] of [["GET", "/conversations"], ["POST", "/conversations"], ["GET", `/conversations/${conversationId}/messages`]] as const) {
      const res = await app.request(`/api/v1${path}`, { method, headers: { "X-Actor-Context": token } });
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  });
});

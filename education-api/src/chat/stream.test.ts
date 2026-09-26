// 20c：发消息/恢复的流式接口，以及 Agent 客户端。用假 Agent 驱动路由和监督器，数据库是真实临时库。
// 这里保护的是"运行的生命周期不绑在浏览器连接上"、去重、单 run 锁、租约、错误收口与身份传递。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "../app.js";
import { signInternalContext, verifyInternalContext } from "../auth/internalContext.js";
import { createSession } from "../auth/session.js";
import { DATABASE_URL } from "../db/config.js";
import { migrate } from "../db/migrate.js";
import { createDb, createPool } from "../db/pool.js";
import { dropTestDatabase } from "../testing/db.js";
import { createHttpAgentClient, type AgentClient, type AgentEvent, type AgentRequest, type AgentStart } from "./agentClient.js";
import { RUN_CONTEXT_TTL_SECONDS } from "./supervisor.js";
import { startMessageRun } from "./runs.js";

const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));
const dbName = `edu_test_${randomBytes(4).toString("hex")}`;
const withDb = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
};
const testUrl = withDb(dbName);
const ORIGIN = "http://localhost:5173";
const SECRET = "stream-test-secret";

let admin: pg.Client;
let pool: pg.Pool;
let db: ReturnType<typeof createDb>;
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

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`等待超时：${what}`);
}

// ---- 假 Agent ------------------------------------------------------------------------------

type Step = { type: string; payload: Record<string, unknown> } | { gate: Promise<void> };
const delta = (text: string): Step => ({ type: "message.delta", payload: { text } });
const completed = (text: string): Step => ({ type: "message.completed", payload: { text } });
const agentError = (code: string): Step => ({ type: "run.error", payload: { code, message: "boom" } });
const gateOf = () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return { gate, open };
};

class FakeAgent implements AgentClient {
  calls: AgentRequest[] = [];
  constructor(private readonly respond: (req: AgentRequest, callNo: number) => Promise<AgentStart> | AgentStart) {}
  start(req: AgentRequest) {
    this.calls.push(req);
    return Promise.resolve(this.respond(req, this.calls.length));
  }
}

/** 按脚本吐事件的假 Agent 流；runId/conversationId 取自请求带来的工作证，和真实 Agent 一致。 */
function scripted(...steps: Step[]) {
  return (req: AgentRequest): AgentStart => {
    const ctx = verifyInternalContext(req.token, SECRET)!;
    async function* gen(): AsyncGenerator<AgentEvent> {
      let n = 0;
      for (const step of steps) {
        if ("gate" in step) {
          await step.gate;
          continue;
        }
        n += 1;
        yield { eventId: String(n), conversationId: req.conversationId, runId: ctx.requestId, type: step.type, payload: step.payload };
      }
    }
    return { kind: "stream", events: gen() };
  };
}

function appWith(agent: AgentClient | undefined, heartbeatIntervalMs = 0) {
  return createApp(pool, { allowedOrigin: ORIGIN, internalAuthSecret: SECRET, agent, heartbeatIntervalMs });
}

// cookie/origin 传 null 表示不带；不能用 undefined——那会触发默认值。
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, cookie: string | null = studentCookie, origin: string | null = ORIGIN) =>
  app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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
  teacherId = await id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('t','x','老师','teacher') RETURNING id");
  studentId = await id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s','x','学员','student') RETURNING id");
  otherStudentId = await id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s2','x','学员2','student') RETURNING id");
  studentCookie = `edu_session=${(await createSession(db, studentId)).token}`;
  otherCookie = `edu_session=${(await createSession(db, otherStudentId)).token}`;
  teacherCookie = `edu_session=${(await createSession(db, teacherId)).token}`;
});

after(async () => {
  await pool.end();
  await dropTestDatabase(admin, dbName);
  await admin.end();
});

describe("发消息：正常流程", () => {
  test("事件按顺序转发；完成事件带上落库后的 messageId；用户消息与助手消息都已保存，run 完成", async () => {
    const agent = new FakeAgent(scripted(delta("你"), delta("好"), completed("你好")));
    const conversationId = await newConversation();
    const res = await post(appWith(agent), `/conversations/${conversationId}/messages`, { clientMessageId: "m1", text: "hi" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /text\/event-stream/);

    const events = sseEvents(await res.text());
    assert.deepEqual(events.map((e) => e.type), ["message.delta", "message.delta", "message.completed"]);
    const last = events.at(-1)!;
    assert.equal(last.payload.text, "你好");
    const saved = (await q("SELECT id, content, role FROM messages WHERE conversation_id = $1 ORDER BY created_at, id", [conversationId])).rows;
    assert.deepEqual(saved.map((m) => [m.role, m.content]), [["user", "hi"], ["assistant", "你好"]]);
    assert.equal(last.payload.messageId, saved[1]!.id, "浏览器拿到的 messageId 就是库里那条助手消息的 id");
    assert.equal((await q("SELECT status FROM runs WHERE conversation_id = $1", [conversationId])).rows[0]!.status, "completed");
  });

  test("传给 Agent 的工作证：身份是会话所有者、requestId 就是 runId、有效期覆盖一次运行；浏览器看到的 conversationId/runId 是我们自己的", async () => {
    const agent = new FakeAgent(scripted(completed("ok")));
    const conversationId = await newConversation();
    const res = await post(appWith(agent), `/conversations/${conversationId}/messages`, { clientMessageId: "m1", text: "hi" });
    const events = sseEvents(await res.text());

    const ctx = verifyInternalContext(agent.calls[0]!.token, SECRET);
    assert.equal(ctx?.actorId, studentId);
    assert.equal(ctx?.role, "student");
    const runId = (await q("SELECT id FROM runs WHERE conversation_id = $1", [conversationId])).rows[0]!.id;
    assert.equal(ctx?.requestId, runId);
    assert.equal(agent.calls[0]!.text, "hi");
    assert.ok(events.every((e) => e.runId === runId && e.conversationId === conversationId));
    // 有效期：比运行租约长（覆盖一次运行），但仍是短期凭证。
    const exp = JSON.parse(Buffer.from(agent.calls[0]!.token.split(".")[0]!, "base64url").toString()).exp as number;
    const ttl = exp - Math.floor(Date.now() / 1000);
    assert.ok(ttl > 90 && ttl <= RUN_CONTEXT_TTL_SECONDS, `ttl=${ttl}`);
  });

  test("Agent 发来契约之外的事件类型：丢弃，不转发给浏览器", async () => {
    const agent = new FakeAgent(scripted({ type: "internal.debug", payload: { secret: "x" } }, completed("ok")));
    const conversationId = await newConversation();
    const events = sseEvents(await (await post(appWith(agent), `/conversations/${conversationId}/messages`, { clientMessageId: "m1", text: "hi" })).text());
    assert.deepEqual(events.map((e) => e.type), ["message.completed"]);
  });
});

describe("不信任 Agent 的自我描述", () => {
  test("Agent 事件里的 runId/conversationId 被覆盖成我们自己的值：即使它填了别的会话或别的 run", async () => {
    const agent = new FakeAgent((req) => ({
      kind: "stream",
      events: (async function* () {
        yield { eventId: "1", conversationId: "别人的会话", runId: "别人的run", type: "message.delta", payload: { text: "a" } } satisfies AgentEvent;
        yield { eventId: "2", conversationId: "别人的会话", runId: "别人的run", type: "message.completed", payload: { text: "a" } } satisfies AgentEvent;
      })(),
    }));
    const conversationId = await newConversation();
    const events = sseEvents(await (await post(appWith(agent), `/conversations/${conversationId}/messages`, { clientMessageId: "o1", text: "hi" })).text());
    const runId = (await q("SELECT id FROM runs WHERE conversation_id = $1", [conversationId])).rows[0]!.id;
    assert.ok(events.length === 2 && events.every((e) => e.conversationId === conversationId && e.runId === runId));
  });
});

describe("重复消息与并发（AC-021）", () => {
  test("同一个 clientMessageId 重复提交：不再调用 Agent，回放原来的完成事件（同一个 messageId）", async () => {
    const agent = new FakeAgent(scripted(completed("回答")));
    const app = appWith(agent);
    const conversationId = await newConversation();
    const first = sseEvents(await (await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "dup", text: "hi" })).text());
    const again = await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "dup", text: "hi" });

    assert.equal(again.status, 200);
    const replay = sseEvents(await again.text());
    assert.deepEqual(replay.map((e) => e.type), ["message.completed"]);
    assert.equal(replay[0]!.payload.messageId, first.at(-1)!.payload.messageId);
    assert.equal(agent.calls.length, 1, "重复提交不会让 Agent 再跑一次");
    assert.equal(await count("SELECT count(*) n FROM messages WHERE conversation_id = $1", [conversationId]), 2);
  });

  test("会话正在生成时再发一条不同的消息：409 RUN_IN_PROGRESS，Agent 只被调用一次", async () => {
    const g = gateOf();
    const agent = new FakeAgent(scripted(delta("…"), { gate: g.gate }, completed("ok")));
    const app = appWith(agent);
    const conversationId = await newConversation();
    const first = await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "a", text: "1" });
    const second = await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "b", text: "2" });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, "RUN_IN_PROGRESS");
    assert.equal(agent.calls.length, 1);
    g.open();
    await first.text();
  });

  test("原消息仍在处理中时重复提交：也是 409，不重复调用 Agent", async () => {
    const g = gateOf();
    const agent = new FakeAgent(scripted({ gate: g.gate }, completed("ok")));
    const app = appWith(agent);
    const conversationId = await newConversation();
    const first = await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "a", text: "1" });
    const retry = await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "a", text: "1" });
    assert.equal(retry.status, 409);
    assert.equal(agent.calls.length, 1);
    g.open();
    await first.text();
  });

  test("原运行已失败：重复提交回放的是错误事件，且不暴露内部失败原因（LEASE_EXPIRED 等）", async () => {
    const agent = new FakeAgent(scripted(agentError("INTERNAL")));
    const app = appWith(agent);
    const conversationId = await newConversation();
    await (await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "f", text: "hi" })).text();
    await q("UPDATE runs SET error_code = 'LEASE_EXPIRED' WHERE conversation_id = $1", [conversationId]);
    const replay = sseEvents(await (await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "f", text: "hi" })).text());
    assert.equal(replay[0]!.type, "run.error");
    assert.equal(replay[0]!.payload.code, "INTERNAL");
  });
});

describe("断线后仍然跑完（AC-021 断线可查询完成消息）", () => {
  test("浏览器读到一半断开：Agent 那边照常跑完，助手消息落库，之后 GET 能查到完成的结果", async () => {
    const g = gateOf();
    const agent = new FakeAgent(scripted(delta("正在"), { gate: g.gate }, delta("回答"), completed("正在回答")));
    const app = appWith(agent);
    const conversationId = await newConversation();
    const res = await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "d1", text: "hi" });

    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /message\.delta/);
    await reader.cancel(); // 浏览器断开

    g.open(); // Agent 继续生成并完成
    await waitFor(async () => (await count("SELECT count(*) n FROM messages WHERE conversation_id = $1 AND role = 'assistant'", [conversationId])) === 1, "助手消息落库");

    const get = await app.request(`/api/v1/conversations/${conversationId}/messages`, { headers: { Cookie: studentCookie } });
    const body = await get.json();
    assert.deepEqual(body.items.map((m: { role: string; content: string }) => [m.role, m.content]), [["user", "hi"], ["assistant", "正在回答"]]);
    assert.equal(body.run.status, "completed");
  });
});

describe("失败的收口", () => {
  test("Agent 不可达：503 DEPENDENCY_UNAVAILABLE（不是 SSE），run 记为失败，用户消息保留，可用新的 clientMessageId 重试", async () => {
    let up = false;
    const agent = new FakeAgent((req, n) => {
      if (!up) throw new Error("connect ECONNREFUSED");
      return scripted(completed("恢复了"))(req);
    });
    const app = appWith(agent);
    const conversationId = await newConversation();

    const down = await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "u1", text: "hi" });
    assert.equal(down.status, 503);
    assert.equal((await down.json()).error.code, "DEPENDENCY_UNAVAILABLE");
    const run = (await q("SELECT status, error_code FROM runs WHERE conversation_id = $1", [conversationId])).rows[0];
    assert.deepEqual(run, { status: "failed", error_code: "DEPENDENCY_UNAVAILABLE" });
    assert.equal(await count("SELECT count(*) n FROM messages WHERE conversation_id = $1 AND role = 'user'", [conversationId]), 1);

    up = true;
    const retry = await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "u2", text: "hi" });
    assert.equal(retry.status, 200);
    await retry.text();
  });

  test("Agent 报告 run.error：转发给浏览器，run 记为失败并带上错误码；未知错误码被收成 INTERNAL", async () => {
    const agent = new FakeAgent(scripted(agentError("SOMETHING_ODD")));
    const conversationId = await newConversation();
    const events = sseEvents(await (await post(appWith(agent), `/conversations/${conversationId}/messages`, { clientMessageId: "e1", text: "hi" })).text());
    assert.equal(events[0]!.type, "run.error");
    assert.equal(events[0]!.payload.code, "INTERNAL");
    assert.equal((await q("SELECT status, error_code FROM runs WHERE conversation_id = $1", [conversationId])).rows[0]!.error_code, "INTERNAL");
    assert.equal(await count("SELECT count(*) n FROM messages WHERE conversation_id = $1 AND role = 'assistant'", [conversationId]), 0);
  });

  test("Agent 的流没有以完成/错误事件收尾就断了：给浏览器一个 run.error，run 记为失败，不悬着", async () => {
    const agent = new FakeAgent(scripted(delta("半句话")));
    const conversationId = await newConversation();
    const events = sseEvents(await (await post(appWith(agent), `/conversations/${conversationId}/messages`, { clientMessageId: "x1", text: "hi" })).text());
    assert.deepEqual(events.map((e) => e.type), ["message.delta", "run.error"]);
    assert.equal((await q("SELECT status FROM runs WHERE conversation_id = $1", [conversationId])).rows[0]!.status, "failed");
  });

  test("Agent 的流中途抛异常：同样收口为 run.error，且不把异常文本给浏览器", async () => {
    const agent = new FakeAgent((req) => ({
      kind: "stream",
      events: (async function* () {
        yield { eventId: "1", conversationId: req.conversationId, runId: "x", type: "message.delta", payload: { text: "a" } } satisfies AgentEvent;
        throw new Error("postgresql://edu:SECRET-PASSWORD@10.0.0.5/education");
      })(),
    }));
    const conversationId = await newConversation();
    const text = await (await post(appWith(agent), `/conversations/${conversationId}/messages`, { clientMessageId: "t1", text: "hi" })).text();
    assert.ok(!text.includes("SECRET-PASSWORD"));
    assert.equal(sseEvents(text).at(-1)!.type, "run.error");
  });

  test("迟到的结果被丢弃：租约过期后被新运行接管，旧运行之后才完成，不写助手消息，浏览器收到错误事件", async () => {
    const g = gateOf();
    const agent = new FakeAgent(scripted(delta("…"), { gate: g.gate }, completed("迟到的回答")));
    const app = appWith(agent);
    const conversationId = await newConversation();
    const res = await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "old", text: "hi" });
    const oldRun = (await q("SELECT id FROM runs WHERE conversation_id = $1", [conversationId])).rows[0]!.id;

    await q("UPDATE runs SET lease_until = now() - interval '1 second' WHERE id = $1", [oldRun]);
    assert.equal((await startMessageRun(db, { conversationId, clientMessageId: "new", text: "接管" })).kind, "started");

    g.open();
    const events = sseEvents(await res.text());
    assert.equal(events.at(-1)!.type, "run.error");
    assert.equal(await count("SELECT count(*) n FROM messages WHERE run_id = $1 AND role = 'assistant'", [oldRun]), 0);
    assert.equal((await q("SELECT status FROM runs WHERE id = $1", [oldRun])).rows[0]!.status, "failed");
  });

  test("迟到的结果被丢弃（第二道防线）：即使没有触发续租检查，完成时的条件 UPDATE 也拒绝写入", async () => {
    // 续租间隔调得很大，事件到来时不会去续租，于是"运行已被接管"只能由 completeRun 自己发现。
    const g = gateOf();
    const agent = new FakeAgent(scripted(delta("…"), { gate: g.gate }, completed("迟到的回答")));
    const app = appWith(agent, 3_600_000);
    const conversationId = await newConversation();
    const res = await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "old2", text: "hi" });
    const oldRun = (await q("SELECT id FROM runs WHERE conversation_id = $1", [conversationId])).rows[0]!.id;

    await q("UPDATE runs SET lease_until = now() - interval '1 second' WHERE id = $1", [oldRun]);
    assert.equal((await startMessageRun(db, { conversationId, clientMessageId: "new2", text: "接管" })).kind, "started");

    g.open();
    const events = sseEvents(await res.text());
    assert.equal(events.at(-1)!.type, "run.error");
    assert.equal(await count("SELECT count(*) n FROM messages WHERE run_id = $1 AND role = 'assistant'", [oldRun]), 0);
  });

  test("运行期间持续续租：收到事件时把租约延长到 90 秒", async () => {
    const g1 = gateOf();
    const g2 = gateOf();
    const agent = new FakeAgent(scripted(delta("a"), { gate: g1.gate }, delta("b"), { gate: g2.gate }, completed("ab")));
    const app = appWith(agent);
    const conversationId = await newConversation();
    const res = await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "h1", text: "hi" });
    const runId = (await q("SELECT id FROM runs WHERE conversation_id = $1", [conversationId])).rows[0]!.id;

    await q("UPDATE runs SET lease_until = now() + interval '1 second' WHERE id = $1", [runId]);
    g1.open(); // Agent 发出第二个事件 → 触发续租
    await waitFor(async () => (await count("SELECT count(*) n FROM runs WHERE id = $1 AND lease_until > now() + interval '80 seconds'", [runId])) === 1, "租约被续上");
    g2.open();
    await res.text();
  });
});

describe("确认后恢复", () => {
  test("恢复：不创建用户消息；Agent 收到 resume；回复作为助手消息落库", async () => {
    const agent = new FakeAgent((req) => scripted(completed("你的申请已提交，等待老师处理。"))(req));
    const app = appWith(agent);
    const conversationId = await newConversation();
    const res = await post(app, `/conversations/${conversationId}/resume`, undefined);
    assert.equal(res.status, 200);
    const events = sseEvents(await res.text());

    assert.equal(agent.calls[0]!.resume, true);
    assert.equal(agent.calls[0]!.text, undefined);
    assert.equal(events.at(-1)!.payload.text, "你的申请已提交，等待老师处理。");
    const msgs = (await q("SELECT role FROM messages WHERE conversation_id = $1", [conversationId])).rows;
    assert.deepEqual(msgs, [{ role: "assistant" }]);
    assert.equal((await q("SELECT kind, status FROM runs WHERE conversation_id = $1", [conversationId])).rows[0]!.kind, "resume");
  });

  test("Agent 说没有可恢复的确认（409）：接口返回 409 INVALID_STATE，运行记为失败并释放锁", async () => {
    const agent = new FakeAgent(() => ({ kind: "rejected", status: 409, code: "NOT_AWAITING_CONFIRMATION" }));
    const app = appWith(agent);
    const conversationId = await newConversation();
    const res = await post(app, `/conversations/${conversationId}/resume`, undefined);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "INVALID_STATE");
    assert.deepEqual((await q("SELECT status, error_code FROM runs WHERE conversation_id = $1", [conversationId])).rows[0], { status: "failed", error_code: "NOT_AWAITING_CONFIRMATION" });
    // 锁已释放：紧接着可以正常发消息。
    const ok = new FakeAgent(scripted(completed("ok")));
    assert.equal((await post(appWith(ok), `/conversations/${conversationId}/messages`, { clientMessageId: "n1", text: "hi" })).status, 200);
  });

  test("会话正在生成时恢复：409 RUN_IN_PROGRESS", async () => {
    const g = gateOf();
    const agent = new FakeAgent(scripted({ gate: g.gate }, completed("ok")));
    const app = appWith(agent);
    const conversationId = await newConversation();
    const first = await post(app, `/conversations/${conversationId}/messages`, { clientMessageId: "a", text: "1" });
    const res = await post(app, `/conversations/${conversationId}/resume`, undefined);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "RUN_IN_PROGRESS");
    g.open();
    await first.text();
  });
});

describe("权限与校验", () => {
  const agent = new FakeAgent(scripted(completed("ok")));
  const app = () => appWith(agent);

  test("别人的会话：404，Agent 不会被调用", async () => {
    const conversationId = await newConversation(studentId);
    const before = agent.calls.length;
    assert.equal((await post(app(), `/conversations/${conversationId}/messages`, { clientMessageId: "x", text: "hi" }, otherCookie)).status, 404);
    assert.equal((await post(app(), `/conversations/${conversationId}/resume`, undefined, otherCookie)).status, 404);
    assert.equal(agent.calls.length, before);
  });

  test("未登录 401；老师 403；缺 Origin 的跨站写 403", async () => {
    const conversationId = await newConversation();
    const body = { clientMessageId: "x", text: "hi" };
    assert.equal((await post(app(), `/conversations/${conversationId}/messages`, body, null)).status, 401);
    assert.equal((await post(app(), `/conversations/${conversationId}/messages`, body, teacherCookie)).status, 403);
    assert.equal((await post(app(), `/conversations/${conversationId}/messages`, body, studentCookie, null)).status, 403);
  });

  test("Agent 通道不能替用户发消息或触发恢复", async () => {
    const conversationId = await newConversation();
    const token = signInternalContext({ actorId: studentId, role: "student", requestId: "r" }, SECRET);
    for (const path of [`/conversations/${conversationId}/messages`, `/conversations/${conversationId}/resume`]) {
      const res = await app().request(`/api/v1${path}`, { method: "POST", headers: { "X-Actor-Context": token, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(res.status, 403, path);
    }
  });

  test("参数校验：缺 clientMessageId / text 为空 / 过长 → 422", async () => {
    const conversationId = await newConversation();
    for (const body of [{ text: "hi" }, { clientMessageId: "x" }, { clientMessageId: "x", text: "" }, { clientMessageId: "x", text: "a".repeat(4001) }, { clientMessageId: "x".repeat(101), text: "hi" }]) {
      assert.equal((await post(app(), `/conversations/${conversationId}/messages`, body)).status, 422, JSON.stringify(body).slice(0, 40));
    }
  });

  test("没有配置 Agent：503，而不是崩溃", async () => {
    const conversationId = await newConversation();
    const res = await post(appWith(undefined), `/conversations/${conversationId}/messages`, { clientMessageId: "x", text: "hi" });
    assert.equal(res.status, 503);
  });
});

describe("Agent 客户端（真实 HTTP + SSE 解析）", () => {
  let server: Server;
  let baseUrl: string;
  let seen: { headers: Record<string, unknown>; body: string } | null = null;
  const frames = (events: object[]) => events.map((e, i) => `id: ${i + 1}\nevent: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen = { headers: req.headers, body };
        if (req.url === "/internal/runs" && JSON.parse(body).resume) {
          res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: "NOT_AWAITING_CONFIRMATION" } }));
          return;
        }
        const payload = Buffer.from(
          frames([
            { eventId: "1", conversationId: "c", runId: "r", type: "message.delta", payload: { text: "你好，世界" } },
            { eventId: "2", conversationId: "c", runId: "r", type: "message.completed", payload: { text: "你好，世界" } },
          ]),
        );
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        // 故意把字节流切得很碎：切在一个汉字的中间、切在两个事件的分隔符中间。
        const cuts = [7, 8, 45, payload.indexOf("\n\n") + 1, payload.length - 3];
        let from = 0;
        for (const cut of cuts) {
          res.write(payload.subarray(from, cut));
          from = cut;
        }
        res.end(payload.subarray(from));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  test("请求带工作证头和正确的请求体；SSE 无论怎么被切碎都能完整解析（含被切断的汉字）", async () => {
    const start = await createHttpAgentClient(baseUrl).start({ token: "TOKEN-123", conversationId: "c", text: "hi", signal: new AbortController().signal });
    assert.equal(start.kind, "stream");
    if (start.kind !== "stream") return;
    const got: AgentEvent[] = [];
    for await (const e of start.events) got.push(e);
    assert.deepEqual(got.map((e) => e.type), ["message.delta", "message.completed"]);
    assert.equal(got[0]!.payload.text, "你好，世界");
    assert.equal(seen!.headers["x-actor-context"], "TOKEN-123");
    assert.deepEqual(JSON.parse(seen!.body), { conversationId: "c", text: "hi" });
  });

  test("Agent 在开流前拒绝：返回 rejected（含状态码与错误码），而不是抛异常或返回空流", async () => {
    const start = await createHttpAgentClient(baseUrl).start({ token: "T", conversationId: "c", resume: true, signal: new AbortController().signal });
    assert.deepEqual(start, { kind: "rejected", status: 409, code: "NOT_AWAITING_CONFIRMATION" });
    assert.deepEqual(JSON.parse(seen!.body), { conversationId: "c", resume: true });
  });

  test("Agent 不可达：抛异常（由监督器收口为 DEPENDENCY_UNAVAILABLE）", async () => {
    await assert.rejects(createHttpAgentClient("http://127.0.0.1:9").start({ token: "T", conversationId: "c", text: "x", signal: new AbortController().signal }));
  });
});

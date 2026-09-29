import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { StreamProtocolError } from "./events";
import { confirmDraft, openConversation, pollUntilSettled, requestHandoff, sendTurn } from "./session";
import { emptyChat, fromServer, type ChatState } from "./state";
import { CARD, apiError, collect, completed, delta, ev, events, fakeApi, fastClock, handoffStatus, run, server, tool } from "./testing";

const CONV = "c-1";
const finalOf = async (gen: AsyncIterable<ChatState>) => (await collect(gen)).at(-1)!;
const withCard = (): ChatState => ({ ...emptyChat(), pendingConfirmation: CARD });
const networkError = () => new TypeError("network down");

describe("发送消息", () => {
  test("正常：逐个事件更新状态，最终助手消息完整，clientMessageId 原样传给服务端", async () => {
    const { api, calls } = fakeApi({ send: async () => events([tool("getMyEnrollment", "started"), tool("getMyEnrollment", "succeeded"), delta("你"), delta("好"), completed("你好", "m-1")]) });
    const states = await collect(sendTurn(api, CONV, emptyChat(), "hi", "cm-1"));
    const last = states.at(-1)!;
    assert.deepEqual([last.phase, last.messages.map((m) => [m.id, m.content, m.state])], ["idle", [["cm-1", "hi", "done"], ["m-1", "你好", "done"]]]);
    assert.deepEqual(last.messages[1]!.tools, [{ tool: "getMyEnrollment", status: "succeeded" }]);
    assert.deepEqual(calls.sentBodies, [{ clientMessageId: "cm-1", text: "hi" }]);
    assert.equal(calls.messages, 0, "正常结束不需要查询");
  });

  test("确认卡事件到达后，待确认草稿出现在状态里", async () => {
    const { api } = fakeApi({ send: async () => events([ev("application.confirmation", CARD), completed("已起草")]) });
    assert.deepEqual((await finalOf(sendTurn(api, CONV, emptyChat(), "转班", "cm"))).pendingConfirmation, CARD);
  });

  test("重复提交：服务端只回放一个 completed，也能正确显示", async () => {
    const { api } = fakeApi({ send: async () => events([completed("上次的回答", "m-9")]) });
    const last = await finalOf(sendTurn(api, CONV, emptyChat(), "hi", "cm"));
    assert.equal(last.messages.at(-1)!.content, "上次的回答");
  });
});

describe("断线恢复（AC-021）", () => {
  test("流中途断开：进入重连阶段，反复查询直到运行结束，最终以服务端记录为准，不需要重发", async () => {
    const done = server({ items: [{ id: "u", role: "user", content: "hi" }, { id: "a", role: "assistant", content: "完整回答" }], run: run("completed") });
    const { api, calls } = fakeApi({
      send: async () => events([delta("半")], networkError()),
      messages: async (n) => (n < 3 ? server({ run: run("running") }) : done),
    });
    const states = await collect(sendTurn(api, CONV, emptyChat(), "hi", "cm", fastClock()));
    assert.ok(states.some((s) => s.phase === "reconnecting"));
    const last = states.at(-1)!;
    assert.deepEqual([last.phase, last.notice, last.messages.map((m) => m.content)], ["idle", null, ["hi", "完整回答"]]);
    assert.equal(calls.messages, 3);
    assert.equal(calls.send, 1, "没有重新发送");
  });

  test("流正常结束但没有收尾事件（服务端提前关闭连接）：同样走恢复", async () => {
    const { api, calls } = fakeApi({ send: async () => events([delta("半句")]), messages: async () => server({ items: [{ id: "a", role: "assistant", content: "完整" }], run: run("completed") }) });
    const last = await finalOf(sendTurn(api, CONV, emptyChat(), "hi", "cm", fastClock()));
    assert.deepEqual([calls.messages, last.messages.at(-1)!.content], [1, "完整"]);
  });

  test("查询到这次运行已失败：给出明确提示，消息以服务端为准", async () => {
    const { api } = fakeApi({ send: async () => events([], networkError()), messages: async () => server({ items: [{ id: "u", role: "user", content: "hi" }], run: run("failed", "LEASE_EXPIRED") }) });
    const last = await finalOf(sendTurn(api, CONV, emptyChat(), "hi", "cm", fastClock()));
    assert.match(last.notice!, /没有处理成功/);
    assert.equal(last.phase, "idle");
  });

  test("一直显示运行中：等到超时后停下并提示稍后刷新（不无限轮询）", async () => {
    const { api, calls } = fakeApi({ send: async () => events([], networkError()), messages: async () => server({ run: run("running") }) });
    const last = await finalOf(sendTurn(api, CONV, emptyChat(), "hi", "cm", fastClock(1000, 5000)));
    assert.match(last.notice!, /仍在处理中/);
    assert.ok(calls.messages >= 5 && calls.messages <= 7, `查询了 ${calls.messages} 次`);
  });

  test("查询本身也一直失败（网络没恢复）：提示无法连接，不抛错", async () => {
    const { api } = fakeApi({ send: async () => events([], networkError()), messages: async () => { throw networkError(); } });
    const last = await finalOf(sendTurn(api, CONV, emptyChat(), "hi", "cm", fastClock(1000, 3000)));
    assert.match(last.notice!, /无法连接/);
    assert.equal(last.phase, "idle");
  });

  test("查询时偶发失败会被容忍，后续成功即可", async () => {
    const { api } = fakeApi({
      send: async () => events([], networkError()),
      messages: async (n) => { if (n === 1) throw networkError(); return server({ items: [{ id: "a", role: "assistant", content: "好了" }], run: run("completed") }); },
    });
    const last = await finalOf(sendTurn(api, CONV, emptyChat(), "hi", "cm", fastClock()));
    assert.equal(last.messages.at(-1)!.content, "好了");
  });

  test("恢复后如果服务端带回了待确认草稿，界面能拿到（确认卡不因断线而丢）", async () => {
    const { api } = fakeApi({ send: async () => events([], networkError()), messages: async () => server({ items: [{ id: "a", role: "assistant", content: "已起草" }], run: run("completed"), pendingConfirmation: CARD }) });
    assert.deepEqual((await finalOf(sendTurn(api, CONV, emptyChat(), "转班", "cm", fastClock()))).pendingConfirmation, CARD);
  });
});

describe("开流之前就被拒绝", () => {
  for (const [status, code, pattern] of [[409, "RUN_IN_PROGRESS", /还在处理中/], [503, "DEPENDENCY_UNAVAILABLE", /暂时不可用/], [401, "UNAUTHORIZED", /登录已过期/], [422, "VALIDATION_ERROR", /格式/]] as const) {
    test(`${status} ${code}：那条占位助手消息标记为失败并给出提示，不做断线查询`, async () => {
      const { api, calls } = fakeApi({ send: async () => { throw apiError(status, code); } });
      const last = await finalOf(sendTurn(api, CONV, emptyChat(), "hi", "cm", fastClock()));
      assert.match(last.messages.at(-1)!.error!, pattern);
      assert.deepEqual([last.messages.at(-1)!.state, last.phase, calls.messages], ["error", "idle", 0]);
    });
  }

  test("服务返回不符合协议的数据：明确失败，不当作断线去重试", async () => {
    const { api, calls } = fakeApi({ send: async () => (async function* () { throw new StreamProtocolError("bad"); yield undefined as never; })() });
    const last = await finalOf(sendTurn(api, CONV, emptyChat(), "hi", "cm", fastClock()));
    assert.equal(last.messages.at(-1)!.state, "error");
    assert.equal(calls.messages, 0);
  });
});

describe("确认草稿后恢复", () => {
  test("先对业务 API 确认（带上确认卡的 id 与 revision），成功后才让 Agent 恢复；卡被清掉，回话进入消息", async () => {
    const order: string[] = [];
    const { api, calls } = fakeApi({ confirm: async () => { order.push("confirm"); }, resume: async () => { order.push("resume"); return events([delta("你的申请"), completed("你的申请已提交，等待老师处理。", "m-r")]); } });
    let confirmBody: unknown;
    api.confirmApplication = async (id, body) => { confirmBody = [id, body]; order.push("confirm"); };
    const last = await finalOf(confirmDraft(api, CONV, withCard()));
    assert.deepEqual(order, ["confirm", "resume"]);
    assert.deepEqual(confirmBody, ["app-1", { confirmationId: "conf-1", expectedRevision: 1 }]);
    assert.deepEqual([last.pendingConfirmation, last.messages.at(-1)!.content, last.phase], [null, "你的申请已提交，等待老师处理。", "idle"]);
    assert.equal(calls.resume, 1);
  });

  test("确认卡已失效（STALE_CONFIRMATION）：不恢复 Agent，以服务端为准重新加载，可能拿到新的确认卡", async () => {
    const fresh = { ...CARD, confirmationId: "conf-2", revision: 2 };
    const { api, calls } = fakeApi({ confirm: async () => { throw apiError(409, "STALE_CONFIRMATION"); }, messages: async () => server({ items: [{ id: "a", role: "assistant", content: "已起草" }], run: run("completed"), pendingConfirmation: fresh }) });
    const last = await finalOf(confirmDraft(api, CONV, withCard()));
    assert.deepEqual([last.pendingConfirmation, calls.resume, /已经失效/.test(last.notice!)], [fresh, 0, true]);
  });

  test("确认因网络原因没成功：保留确认卡、提示重试，不恢复 Agent", async () => {
    const { api, calls } = fakeApi({ confirm: async () => { throw networkError(); } });
    const last = await finalOf(confirmDraft(api, CONV, withCard()));
    assert.deepEqual([last.pendingConfirmation, calls.resume, typeof last.notice], [CARD, 0, "string"]);
  });

  test("确认已成功、但 Agent 那边没有可恢复的确认（409）：不算错误——申请已经提交了，只给提示", async () => {
    const { api } = fakeApi({ resume: async () => { throw apiError(409, "INVALID_STATE"); } });
    const last = await finalOf(confirmDraft(api, CONV, withCard(), fastClock()));
    assert.match(last.notice!, /已提交/);
    assert.equal(last.pendingConfirmation, null);
    assert.ok(last.messages.every((m) => m.state !== "error" && !(m.state === "streaming")), "不留下失败/悬着的占位消息");
  });

  test("确认成功后恢复的流中途断开：同样走断线恢复", async () => {
    const { api, calls } = fakeApi({ resume: async () => events([], networkError()), messages: async () => server({ items: [{ id: "a", role: "assistant", content: "你的申请已提交" }], run: run("completed") }) });
    const last = await finalOf(confirmDraft(api, CONV, withCard(), fastClock()));
    assert.deepEqual([calls.messages, last.messages.at(-1)!.content], [1, "你的申请已提交"]);
  });

  test("没有待确认草稿时什么都不做（不发任何请求）", async () => {
    const { api, calls } = fakeApi({});
    assert.deepEqual(await collect(confirmDraft(api, CONV, emptyChat())), []);
    assert.deepEqual([calls.confirm, calls.resume], [0, 0]);
  });
});

describe("打开会话", () => {
  test("没有运行中的：只查询一次，带出历史与待确认草稿", async () => {
    const { api, calls } = fakeApi({ messages: async () => server({ items: [{ id: "1", role: "user", content: "a" }], run: run("completed"), pendingConfirmation: CARD }) });
    const states = await collect(openConversation(api, CONV));
    assert.deepEqual([states.length, calls.messages, states[0]!.pendingConfirmation], [1, 1, CARD]);
  });

  test("刷新页面时这个会话还有运行在生成：先显示历史，再等它结束给出最终结果", async () => {
    const { api } = fakeApi({ messages: async (n) => (n < 3 ? server({ items: [{ id: "u", role: "user", content: "hi" }], run: run("running") }) : server({ items: [{ id: "u", role: "user", content: "hi" }, { id: "a", role: "assistant", content: "答案" }], run: run("completed") })) });
    const states = await collect(openConversation(api, CONV, fastClock()));
    assert.equal(states[0]!.messages.length, 1);
    assert.equal(states.at(-1)!.messages.at(-1)!.content, "答案");
  });
});

describe("轮询（pollUntilSettled）", () => {
  test("第一次就已结束：只查询一次，不等待", async () => {
    let sleeps = 0;
    const r = await pollUntilSettled(async () => server({ run: run("completed") }), { ...fastClock(), sleep: async () => { sleeps++; } });
    assert.deepEqual([r.kind, sleeps], ["settled", 0]);
  });

  test("从未有过运行（run 为 null）也算已结束", async () => {
    assert.equal((await pollUntilSettled(async () => server({ run: null }), fastClock())).kind, "settled");
  });
});

describe("fromServer 对齐", () => {
  test("重建的状态里没有任何'正在生成'的消息", () => {
    assert.ok(fromServer([{ id: "1", role: "assistant", content: "x" }], null, "bot").messages.every((m) => m.state === "done"));
  });
});

describe("排队/接管期间发消息（AC-012）", () => {
  test("响应只有一个 handoff.status：不会被当成断线，不去轮询；mode 更新、占位气泡消失", async () => {
    const { api, calls } = fakeApi({ send: async () => events([handoffStatus("queued")]) });
    const last = await finalOf(sendTurn(api, CONV, emptyChat(), "在吗", "cm", fastClock()));
    assert.deepEqual([last.phase, last.mode, last.messages.map((m) => m.role), calls.messages], ["idle", "queued", ["user"], 0]);
  });

  test("接管中同样：mode 变 human", async () => {
    const { api } = fakeApi({ send: async () => events([handoffStatus("human")]) });
    const last = await finalOf(sendTurn(api, CONV, emptyChat(), "还在吗", "cm"));
    assert.equal(last.mode, "human");
  });
});

describe("请求转人工", () => {
  test("成功后以服务端为准重新加载（拿到最新 mode）", async () => {
    const { api, calls } = fakeApi({
      handoff: async () => ({ id: "h-1", status: "queued" }),
      messages: async () => server({ items: [{ id: "u", role: "user", content: "hi" }], mode: "queued" }),
    });
    const last = await finalOf(requestHandoff(api, CONV, emptyChat()));
    assert.deepEqual([calls.handoff, calls.messages, last.mode, /已经为你转接/.test(last.notice!)], [1, 1, "queued", true]);
  });

  test("请求失败：给出提示，不改变 mode", async () => {
    const { api } = fakeApi({ handoff: async () => { throw apiError(409, "INVALID_STATE"); } });
    const last = await finalOf(requestHandoff(api, CONV, emptyChat()));
    assert.deepEqual([last.mode, typeof last.notice], ["bot", "string"]);
  });
});

describe("确认后恢复遇到接管中（HANDOFF_ACTIVE）", () => {
  test("不算错误：确认已经成功，只是机器人暂时不会自动回复", async () => {
    const { api } = fakeApi({ resume: async () => { throw apiError(409, "HANDOFF_ACTIVE"); } });
    const last = await finalOf(confirmDraft(api, CONV, withCard(), fastClock()));
    assert.match(last.notice!, /正由老师处理/);
    assert.equal(last.pendingConfirmation, null);
    assert.ok(last.messages.every((m) => m.state !== "error"), "不留下失败的占位消息");
  });
});

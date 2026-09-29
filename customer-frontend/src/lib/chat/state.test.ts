import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CARD, completed, delta, ev, handoffStatus, tool } from "./testing";
import { applyEvent, clearConfirmation, emptyChat, failTurn, fromServer, markDisconnected, startResume, startTurn, type ChatState } from "./state";

const play = (state: ChatState, ...events: Parameters<typeof applyEvent>[1][]) => events.reduce(applyEvent, state);
const last = (s: ChatState) => s.messages.at(-1)!;

describe("事件 → 状态", () => {
  test("发送：放入用户消息（id 就是 clientMessageId）和一条正在生成的助手消息", () => {
    const s = startTurn(emptyChat(), "cm-1", "我想转班");
    assert.deepEqual(s.messages.map((m) => [m.id, m.role, m.state]), [["cm-1", "user", "done"], ["pending-cm-1", "assistant", "streaming"]]);
    assert.equal(s.phase, "streaming");
  });

  test("delta 逐段追加；completed 以完整文本为准并换成真实 messageId", () => {
    const s = play(startTurn(emptyChat(), "cm", "hi"), delta("你"), delta("好"), completed("你好呀", "m-42"));
    assert.deepEqual([last(s).id, last(s).content, last(s).state, s.phase], ["m-42", "你好呀", "done", "idle"]);
  });

  test("completed 的文本与 delta 拼接结果不一致时，以 completed 为准（丢包/重复也能被纠正）", () => {
    const s = play(startTurn(emptyChat(), "cm", "hi"), delta("缺了"), completed("完整的回答"));
    assert.equal(last(s).content, "完整的回答");
  });

  test("工具状态：started 追加；succeeded/failed 更新最近一个同名且进行中的", () => {
    const s = play(startTurn(emptyChat(), "cm", "hi"), tool("a", "started"), tool("b", "started"), tool("a", "succeeded"), tool("a", "started"), tool("b", "failed"));
    assert.deepEqual(last(s).tools, [{ tool: "a", status: "succeeded" }, { tool: "b", status: "failed" }, { tool: "a", status: "started" }]);
  });

  test("确认卡事件：设置待确认草稿（不属于某条消息）", () => {
    const s = play(startTurn(emptyChat(), "cm", "转班"), ev("application.confirmation", CARD), completed("已起草"));
    assert.deepEqual(s.pendingConfirmation, CARD);
    assert.equal(clearConfirmation(s).pendingConfirmation, null);
  });

  test("run.error：助手消息标记为失败并保留已收到的文字", () => {
    const s = play(startTurn(emptyChat(), "cm", "hi"), delta("半句"), ev("run.error", { code: "INTERNAL", message: "服务暂时出错" }));
    assert.deepEqual([last(s).state, last(s).content, last(s).error, s.phase], ["error", "半句", "服务暂时出错", "idle"]);
  });

  test("重复提交时服务端只回放一个 completed：没有助手占位也能正确显示（自动新建）", () => {
    const s = play(emptyChat(), completed("上次的回答", "m-9"));
    assert.deepEqual(s.messages.map((m) => [m.role, m.content, m.id]), [["assistant", "上次的回答", "m-9"]]);
  });

  test("other 事件不改变状态", () => {
    const before = startTurn(emptyChat(), "cm", "hi");
    assert.equal(applyEvent(before, { ...delta("x"), type: "other", payload: {} } as never), before);
  });

  test("不原地修改：每次返回新对象，旧状态保持不变（React 依赖这一点）", () => {
    const a = startTurn(emptyChat(), "cm", "hi");
    const snapshot = JSON.stringify(a);
    const b = applyEvent(a, delta("x"));
    assert.notEqual(a, b);
    assert.equal(JSON.stringify(a), snapshot);
  });

  test("恢复：只放一条正在生成的助手消息，没有用户消息", () => {
    const s = startResume({ ...emptyChat(), pendingConfirmation: CARD });
    assert.deepEqual(s.messages.map((m) => [m.role, m.state]), [["assistant", "streaming"]]);
  });

  test("markDisconnected 进入重连阶段并给出提示；failTurn 只标记正在生成的那条", () => {
    const s = startTurn(emptyChat(), "cm", "hi");
    assert.deepEqual([markDisconnected(s).phase, typeof markDisconnected(s).notice], ["reconnecting", "string"]);
    const failed = failTurn(s, "上一条还在处理中");
    assert.deepEqual([failed.messages[0]!.state, failed.messages[1]!.state, failed.messages[1]!.error, failed.phase], ["done", "error", "上一条还在处理中", "idle"]);
  });

  test("以服务端为准重建：消息全部 done，带上待确认草稿与 mode", () => {
    const s = fromServer([{ id: "1", role: "user", content: "a" }, { id: "2", role: "assistant", content: "b" }], CARD, "queued", { notice: "提示" });
    assert.deepEqual([s.messages.length, s.pendingConfirmation, s.notice, s.phase, s.mode], [2, CARD, "提示", "idle", "queued"]);
  });

  test("handoff.status：更新 mode，清掉空的'正在生成'占位（这次发送不会有机器人回复）", () => {
    const s = play(startTurn(emptyChat(), "cm", "转人工"), handoffStatus("queued"));
    assert.deepEqual([s.mode, s.phase, s.messages.map((m) => m.role)], ["queued", "idle", ["user"]]);
  });

  test("Agent 自己判断转人工：handoff.status 先到，随后还有固定回复的 completed 跟着来——占位被清掉后自动新建一条", () => {
    const s = play(startTurn(emptyChat(), "cm", "转人工"), handoffStatus("queued"), completed("已经帮你转接老师"));
    assert.deepEqual([s.mode, last(s).role, last(s).content, last(s).state], ["queued", "assistant", "已经帮你转接老师", "done"]);
  });
});

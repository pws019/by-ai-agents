import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, type TimedText } from "./chunk.js";

const cue = (text: string, startMs: number, endMs: number): TimedText => ({ text, startMs, endMs });

test("短 cue 会被合并成一段，时间范围是第一条的开始到最后一条的结束", () => {
  const segments = chunk([cue("第一句", 0, 2000), cue("第二句", 2100, 4000), cue("第三句", 4100, 6000)]);
  assert.deepEqual(segments, [{ content: "第一句 第二句 第三句", startMs: 0, endMs: 6000 }]);
});

test("间隔超过阈值（2000ms）触发自然分段，不会被接在一起", () => {
  const segments = chunk([cue("前半段", 0, 2000), cue("后半段", 10_000, 12_000)]);
  assert.deepEqual(segments, [
    { content: "前半段", startMs: 0, endMs: 2000 },
    { content: "后半段", startMs: 10_000, endMs: 12_000 },
  ]);
});

test("累计长度达到目标字数（320）会触发分段，即使没有明显停顿", () => {
  const long = "字".repeat(200);
  const segments = chunk([cue(long, 0, 1000), cue(long, 1000, 2000), cue("再来一句", 2000, 3000)]);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]!.content, `${long} ${long}`);
  assert.equal(segments[1]!.content, "再来一句");
});

test("单个块本身超过目标长度：独立成一段，不会被再拆开", () => {
  const veryLong = "字".repeat(500);
  const segments = chunk([cue(veryLong, 0, 1000), cue("下一段", 1100, 2000)]);
  assert.deepEqual(segments, [
    { content: veryLong, startMs: 0, endMs: 1000 },
    { content: "下一段", startMs: 1100, endMs: 2000 },
  ]);
});

test("讲义（没有时间信息）：只按长度合并，没有时间轴的间隔判断", () => {
  const block = (text: string) => ({ text, startMs: null, endMs: null });
  const segments = chunk([block("第一段"), block("第二段")]);
  assert.deepEqual(segments, [{ content: "第一段 第二段", startMs: null, endMs: null }]);
});

test("空输入返回空数组", () => {
  assert.deepEqual(chunk([]), []);
});

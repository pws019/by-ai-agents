import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSrt } from "./srt.js";

test("解析基本的 SRT：序号 + 逗号毫秒时间轴 + 文本", () => {
  const srt = `1
00:00:01,000 --> 00:00:03,500
第一句话

2
00:00:03,800 --> 00:00:07,200
第二句话`;
  assert.deepEqual(parseSrt(srt), [
    { text: "第一句话", startMs: 1000, endMs: 3500 },
    { text: "第二句话", startMs: 3800, endMs: 7200 },
  ]);
});

test("多行文本合并成一句，中间用空格连接", () => {
  const srt = `1
00:00:01,000 --> 00:00:03,000
第一行
第二行`;
  assert.deepEqual(parseSrt(srt), [{ text: "第一行 第二行", startMs: 1000, endMs: 3000 }]);
});

test("时间戳换算：小时/分钟位不是 0 也要算对", () => {
  const srt = `1
01:02:03,456 --> 01:02:05,000
文本`;
  const expectedStart = ((1 * 60 + 2) * 60 + 3) * 1000 + 456;
  assert.equal(parseSrt(srt)[0]!.startMs, expectedStart);
});

test("跳过没有时间轴行或没有文本内容的块，不报错", () => {
  const srt = `只有序号，没有时间轴

1
00:00:01,000 --> 00:00:02,000
`;
  assert.deepEqual(parseSrt(srt), []);
});

test("空文件解析成空数组", () => {
  assert.deepEqual(parseSrt(""), []);
});

test("用 VTT 的点分隔毫秒喂给 SRT 解析器：这一块识别不出时间戳，被跳过（格式必须匹配，不能混用）", () => {
  const srt = `1
00:00:01.000 --> 00:00:03.000
文本`;
  assert.deepEqual(parseSrt(srt), []);
});

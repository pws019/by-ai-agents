import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVtt } from "./vtt.js";

test("解析基本的 VTT：WEBVTT header + 点分隔毫秒时间轴 + 文本", () => {
  const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.500
第一句话

2
00:00:03.800 --> 00:00:07.200
第二句话`;
  assert.deepEqual(parseVtt(vtt), [
    { text: "第一句话", startMs: 1000, endMs: 3500 },
    { text: "第二句话", startMs: 3800, endMs: 7200 },
  ]);
});

test("cue 时间轴行后面跟着 align/position 设置：只取时间戳部分，不把设置当成结束时间戳解析失败", () => {
  const vtt = `WEBVTT

00:00:03.000 --> 00:00:06.200 align:start position:0%
带设置的一条`;
  assert.deepEqual(parseVtt(vtt), [{ text: "带设置的一条", startMs: 3000, endMs: 6200 }]);
});

test("cue 没有序号也能解析（VTT 序号是可选的）", () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
没有序号`;
  assert.deepEqual(parseVtt(vtt), [{ text: "没有序号", startMs: 1000, endMs: 2000 }]);
});

test("用 SRT 的逗号分隔毫秒喂给 VTT 解析器：识别不出时间戳，被跳过", () => {
  const vtt = `WEBVTT

00:00:01,000 --> 00:00:02,000
文本`;
  assert.deepEqual(parseVtt(vtt), []);
});

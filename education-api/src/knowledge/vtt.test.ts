import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVtt } from "./vtt.js";

const EMPTY_META = { sourceUrl: null, sourceTitle: null, recordedAt: null };

test("解析基本的 VTT：WEBVTT header + 点分隔毫秒时间轴 + 文本", () => {
  const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.500
第一句话

2
00:00:03.800 --> 00:00:07.200
第二句话`;
  assert.deepEqual(parseVtt(vtt), {
    cues: [
      { text: "第一句话", startMs: 1000, endMs: 3500 },
      { text: "第二句话", startMs: 3800, endMs: 7200 },
    ],
    meta: EMPTY_META,
  });
});

test("cue 时间轴行后面跟着 align/position 设置：只取时间戳部分，不把设置当成结束时间戳解析失败", () => {
  const vtt = `WEBVTT

00:00:03.000 --> 00:00:06.200 align:start position:0%
带设置的一条`;
  assert.deepEqual(parseVtt(vtt).cues, [{ text: "带设置的一条", startMs: 3000, endMs: 6200 }]);
});

test("cue 没有序号也能解析（VTT 序号是可选的）", () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
没有序号`;
  assert.deepEqual(parseVtt(vtt).cues, [{ text: "没有序号", startMs: 1000, endMs: 2000 }]);
});

test("用 SRT 的逗号分隔毫秒喂给 VTT 解析器：识别不出时间戳，被跳过", () => {
  const vtt = `WEBVTT

00:00:01,000 --> 00:00:02,000
文本`;
  assert.deepEqual(parseVtt(vtt).cues, []);
});

test("NOTE 头部：来源/标题/chat_shared_at 被解析成结构化元数据（真实数据里的固定格式）", () => {
  const vtt = `WEBVTT

NOTE 来源：https://www.qianwen.com/record#share?share_id=abc123
NOTE 标题：AI开发与求职策略深度分享会
NOTE chat_shared_at=2026-07-26T17:11:00+08:00
NOTE chat_source_timezone=America/Los_Angeles

1
00:00:01.000 --> 00:00:36.000
第一段内容。`;
  const { cues, meta } = parseVtt(vtt);
  assert.deepEqual(cues, [{ text: "第一段内容。", startMs: 1000, endMs: 36000 }]);
  assert.equal(meta.sourceUrl, "https://www.qianwen.com/record#share?share_id=abc123");
  assert.equal(meta.sourceTitle, "AI开发与求职策略深度分享会");
  assert.equal(meta.recordedAt?.toISOString(), new Date("2026-07-26T17:11:00+08:00").toISOString());
});

test("没有 NOTE 头部：meta 全部为 null，不报错", () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
没有元数据`;
  assert.deepEqual(parseVtt(vtt).meta, EMPTY_META);
});

test("NOTE 格式不匹配固定前缀：忽略，不报错、不误解析", () => {
  const vtt = `WEBVTT

NOTE 这是一条普通注释，不是约定的三种前缀
NOTE chat_shared_at=不是合法的日期

00:00:01.000 --> 00:00:02.000
文本`;
  assert.deepEqual(parseVtt(vtt).meta, EMPTY_META);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown } from "./markdown.js";

test("按二级标题切段，标题文字保留在这一段开头", () => {
  const md = `# 文档标题（一级标题不切段）

## 第一节

第一节的内容。

## 第二节

第二节的内容。`;
  const blocks = parseMarkdown(md);
  assert.deepEqual(
    blocks.map((b) => b.text),
    ["# 文档标题（一级标题不切段）", "第一节", "第一节的内容。", "第二节", "第二节的内容。"],
  );
});

test("时间字段恒为 null：讲义没有时间轴，不能编造", () => {
  const blocks = parseMarkdown("## 一节\n\n内容");
  assert.ok(blocks.every((b) => b.startMs === null && b.endMs === null));
});

test("没有标题：按空行切段落", () => {
  const md = `第一段。

第二段。`;
  assert.deepEqual(parseMarkdown(md).map((b) => b.text), ["第一段。", "第二段。"]);
});

test("三级标题也切段，四级不切（只按约定的二三级）", () => {
  const md = `### 三级标题

内容一

#### 四级标题也会被当作正文的一部分

内容二`;
  const blocks = parseMarkdown(md);
  assert.deepEqual(
    blocks.map((b) => b.text),
    ["三级标题", "内容一", "#### 四级标题也会被当作正文的一部分", "内容二"],
  );
});

test("空文档返回空数组", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("   \n\n  "), []);
});

test("段落内部的换行被压成空格（分片按段落为单位，不保留内部换行）", () => {
  const md = "第一行\n第二行";
  assert.deepEqual(parseMarkdown(md), [{ text: "第一行 第二行", startMs: null, endMs: null }]);
});

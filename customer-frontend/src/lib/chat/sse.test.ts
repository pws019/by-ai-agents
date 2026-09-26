import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { StreamProtocolError } from "./events";
import { readEvents } from "./sse";
import { collect, completed, delta, ev, sseText, streamOf } from "./testing";

const encode = (s: string) => new TextEncoder().encode(s);

describe("SSE 解析", () => {
  const events = [delta("你好，"), delta("世界🙂"), completed("你好，世界🙂")];
  const bytes = encode(sseText(events));

  test("完整的流：按顺序解析出所有事件", async () => {
    const got = await collect(readEvents(streamOf(bytes, [])));
    assert.deepEqual(got.map((e) => e.type), ["message.delta", "message.delta", "message.completed"]);
  });

  test("在每一个字节位置切断都能得到同样的结果（含切在汉字/emoji/换行中间）", async () => {
    const expected = await collect(readEvents(streamOf(bytes, [])));
    for (let cut = 1; cut < bytes.length; cut++) {
      const got = await collect(readEvents(streamOf(bytes, [cut])));
      assert.deepEqual(got, expected, `在 ${cut} 处切断`);
    }
  });

  test("切成很多碎块（每 3 个字节一块）", async () => {
    const cuts = Array.from({ length: Math.floor(bytes.length / 3) }, (_, i) => (i + 1) * 3);
    const expected = await collect(readEvents(streamOf(bytes, [])));
    assert.deepEqual(await collect(readEvents(streamOf(bytes, cuts))), expected);
  });

  test("兼容 \\r\\n 换行（每个事件都以 \\r\\n\\r\\n 结尾）、注释行、没有 data 的块", async () => {
    const crlf = (e: unknown) => `id: 1\r\nevent: x\r\ndata: ${JSON.stringify(e)}\r\n\r\n`;
    const text = `: keep-alive\n\n${crlf(delta("甲"))}${crlf(delta("乙"))}id: 3\n\n`;
    const got = await collect(readEvents(streamOf(encode(text), [])));
    assert.deepEqual(got.map((e) => (e.type === "message.delta" ? e.payload.text : "?")), ["甲", "乙"]);
  });

  test("流在一个事件写到一半时断掉：不完整的事件被丢弃，不产生半个事件也不抛错", async () => {
    const half = bytes.slice(0, bytes.length - 20);
    const got = await collect(readEvents(streamOf(half, [])));
    assert.ok(got.length < events.length);
  });

  test("契约之外的事件类型 / 载荷不合法：抛 StreamProtocolError（不是静默忽略）", async () => {
    await assert.rejects(collect(readEvents(streamOf(encode(sseText([{ ...delta("a"), type: "made.up" }])), []))), StreamProtocolError);
    await assert.rejects(collect(readEvents(streamOf(encode(sseText([{ ...delta("a"), payload: { text: 1 } }])), []))), StreamProtocolError);
    await assert.rejects(collect(readEvents(streamOf(encode(sseText([{ type: "message.delta" }])), []))), StreamProtocolError);
  });

  test("契约里有、界面暂不展示的类型归为 other，不当作错误", async () => {
    const got = await collect(readEvents(streamOf(encode(sseText([ev("message.delta", { text: "x" }), { ...delta("x"), type: "citation", payload: { sourceId: "s" } }])), [])));
    assert.equal(got[1]!.type, "other");
  });

  test("调用方提前停止读取：释放底层连接（reader.cancel）", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(encode(sseText([delta("a")]))); },
      cancel() { cancelled = true; },
    });
    for await (const _ of readEvents(body)) break;
    assert.equal(cancelled, true);
  });
});

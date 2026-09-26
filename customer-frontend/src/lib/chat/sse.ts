// 解析 fetch 返回的 SSE 字节流。事件之间以空行分隔，一个事件里取 data 行的 JSON。
// 网络字节块的边界可以落在任何位置，包括一个汉字的中间、\r\n 的中间——所以要缓冲后再切，并用 stream 模式解码。
import { parseStreamEvent, type StreamEvent } from "./events";

export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = parseBlock(block);
        if (event) yield event;
      }
    }
  } finally {
    // 调用方提前停止读取（比如用户离开页面）时，释放到服务端的连接。
    await reader.cancel().catch(() => {});
  }
}

function parseBlock(block: string): StreamEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:")) // 以 ":" 开头的注释行、id:/event: 行都不是数据
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  return parseStreamEvent(JSON.parse(data));
}

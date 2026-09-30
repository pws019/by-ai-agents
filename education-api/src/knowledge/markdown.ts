// 讲义（Markdown）没有时间轴，切段不能编造时间：这里只按标题/空行把文本切成候选块，
// startMs/endMs 恒为 null；真正"合并到目标长度"的工作和字幕共用 chunk.ts 里的同一个函数。
export interface Block {
  text: string;
  startMs: null;
  endMs: null;
}

export function parseMarkdown(text: string): Block[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const sections = splitByHeading(normalized);
  const blocks: Block[] = [];
  for (const section of sections) {
    for (const paragraph of section.split(/\n\s*\n+/)) {
      const flat = paragraph.replace(/\s+/g, " ").trim();
      if (flat) blocks.push({ text: flat, startMs: null, endMs: null });
    }
  }
  return blocks;
}

/** 按二级/三级标题分段；标题本身保留在这一段的开头，帮检索时保留"这段在讲什么"的上下文。 */
function splitByHeading(text: string): string[] {
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{2,3}\s+/.test(line)) {
      if (current.length > 0) sections.push(current.join("\n"));
      current = [line.replace(/^#{2,3}\s+/, "")];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections.length > 0 ? sections : [text];
}

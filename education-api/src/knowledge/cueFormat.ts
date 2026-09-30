// SRT 和 VTT 共用的"cue 块"结构：整份文件按空行分成一个个块，每块含一行时间轴
// （start --> end）和后面几行文本。两种格式的差异只在时间戳的毫秒分隔符（SRT 用逗号，
// VTT 用点）和 VTT 文件开头多一个 WEBVTT header——这些差异交给各自的调用方处理，
// 这里只管拆块、抽时间轴行、把时间戳字符串变成毫秒数（由调用方提供怎么解析一个时间戳）。
export interface Cue {
  text: string;
  startMs: number;
  endMs: number;
}

export function parseCueBlocks(body: string, parseTimestamp: (raw: string) => number | null): Cue[] {
  const blocks = body.replace(/\r\n/g, "\n").trim().split(/\n\s*\n+/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    const timeLineIndex = lines.findIndex((l) => l.includes("-->"));
    if (timeLineIndex === -1) continue; // 没有时间轴行的块（比如纯序号、空块）直接跳过

    const [rawStart, rawEndAndRest] = lines[timeLineIndex]!.split("-->");
    const startMs = parseTimestamp((rawStart ?? "").trim());
    // VTT 的时间轴行结尾可能还跟着 cue 设置（align:start position:0% 之类），只取第一个词当结束时间戳。
    const endMs = parseTimestamp((rawEndAndRest ?? "").trim().split(/\s+/)[0] ?? "");
    const content = lines.slice(timeLineIndex + 1).join(" ").replace(/\s+/g, " ").trim();
    if (startMs === null || endMs === null || !content) continue;

    cues.push({ text: content, startMs, endMs });
  }
  return cues;
}

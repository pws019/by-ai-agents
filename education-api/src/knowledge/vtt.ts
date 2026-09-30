import { parseCueBlocks, type Cue } from "./cueFormat.js";

export type { Cue };

// VTT 时间戳：00:00:01.000（毫秒用点分隔，跟 SRT 唯一的格式差异）。
const VTT_TIME = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

function parseTimestamp(raw: string): number | null {
  const m = raw.match(VTT_TIME);
  if (!m) return null;
  const [, h, min, s, ms] = m;
  return ((Number(h) * 60 + Number(min)) * 60 + Number(s)) * 1000 + Number(ms);
}

export function parseVtt(text: string): Cue[] {
  // 文件开头的 WEBVTT header（可能带一行说明文字）不是 cue，去掉再按 cue 块解析。
  const withoutHeader = text.replace(/\r\n/g, "\n").replace(/^WEBVTT[^\n]*\n?/, "");
  return parseCueBlocks(withoutHeader, parseTimestamp);
}

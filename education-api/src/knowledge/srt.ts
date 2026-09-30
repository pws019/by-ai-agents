import { parseCueBlocks, type Cue } from "./cueFormat.js";

export type { Cue };

// SRT 时间戳：00:00:01,000（毫秒用逗号分隔）。
const SRT_TIME = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/;

function parseTimestamp(raw: string): number | null {
  const m = raw.match(SRT_TIME);
  if (!m) return null;
  const [, h, min, s, ms] = m;
  return ((Number(h) * 60 + Number(min)) * 60 + Number(s)) * 1000 + Number(ms);
}

export function parseSrt(text: string): Cue[] {
  return parseCueBlocks(text, parseTimestamp);
}

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

export interface VttMeta {
  sourceUrl: string | null;
  sourceTitle: string | null;
  recordedAt: Date | null;
}

const EMPTY_META: VttMeta = { sourceUrl: null, sourceTitle: null, recordedAt: null };

// 真实数据里（AI 分享会录屏导出）VTT 头部会用 NOTE 注释带来源信息，固定是这三种前缀：
//   NOTE 来源：<分享链接>
//   NOTE 标题：<原始标题>
//   NOTE chat_shared_at=<ISO 时间，带时区偏移>
// 这是约定俗成的用法，不是 WebVTT 规范本身定义的字段——只认这三个固定前缀，格式不匹配或
// 压根没有 NOTE 时全部为 null，不报错：这是"能提取就提取"的附加信息，不是必须有的数据。
const SOURCE_URL = /^NOTE\s*来源[：:]\s*(.+)$/;
const SOURCE_TITLE = /^NOTE\s*标题[：:]\s*(.+)$/;
const RECORDED_AT = /^NOTE\s*chat_shared_at=(.+)$/;

function parseMeta(body: string): VttMeta {
  const meta = { ...EMPTY_META };
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    const url = line.match(SOURCE_URL);
    if (url) { meta.sourceUrl = url[1]!.trim(); continue; }
    const title = line.match(SOURCE_TITLE);
    if (title) { meta.sourceTitle = title[1]!.trim(); continue; }
    const at = line.match(RECORDED_AT);
    if (at) {
      const parsed = new Date(at[1]!.trim());
      if (!Number.isNaN(parsed.getTime())) meta.recordedAt = parsed;
    }
  }
  return meta;
}

export function parseVtt(text: string): { cues: Cue[]; meta: VttMeta } {
  // 文件开头的 WEBVTT header（可能带一行说明文字）不是 cue，去掉再按 cue 块解析。
  const withoutHeader = text.replace(/\r\n/g, "\n").replace(/^WEBVTT[^\n]*\n?/, "");
  return { cues: parseCueBlocks(withoutHeader, parseTimestamp), meta: parseMeta(withoutHeader) };
}

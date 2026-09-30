// 字幕的原始 cue（一两句话、几秒钟）太碎，直接当检索片段查出来的引用没有上下文；
// 讲义按标题/段落切出来的候选块也有大有小。这里是两边共用的合并算法：把连续的块接起来，
// 直到达到目标长度，或者（只有字幕才有时间信息时）遇到明显的停顿——两条 cue 间隔太久，
// 当作一个自然分段点，不该被强行接在一起。
//
// 单个块本身超过目标长度：不会被再往下拆——拆开就是硬切断句子，这里选择让它独立成一段，
// 宁可这一段长一点，也不做"按字数强行截断"这种会破坏语义的事。
export interface TimedText {
  text: string;
  startMs: number | null;
  endMs: number | null;
}

export interface Segment {
  content: string;
  startMs: number | null;
  endMs: number | null;
}

const TARGET_CHARS = 320;
const GAP_MS = 2000;

export function chunk(items: TimedText[]): Segment[] {
  const segments: Segment[] = [];
  let buf: TimedText[] = [];
  let prevEnd: number | null = null;

  const flush = () => {
    if (buf.length === 0) return;
    segments.push({ content: buf.map((b) => b.text).join(" "), startMs: buf[0]!.startMs, endMs: buf[buf.length - 1]!.endMs });
    buf = [];
  };

  for (const item of items) {
    const bufChars = buf.reduce((n, b) => n + b.text.length, 0);
    const gapTooBig = prevEnd !== null && item.startMs !== null && item.startMs - prevEnd > GAP_MS;
    if (buf.length > 0 && (gapTooBig || bufChars >= TARGET_CHARS)) flush();
    buf.push(item);
    prevEnd = item.endMs;
  }
  flush();
  return segments;
}

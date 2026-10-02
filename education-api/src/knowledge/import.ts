// 导入一份字幕/讲义（T-25）：解析、分片、整个事务写库。
// "更新资料"在这里是重新导入一整份、生成新 version，不是原地编辑某个 segment——跟
// course_versions/policies 是同一个惯例（改动=新版本，不是 UPDATE）；AC-016 要的也是
// "旧片段不可检索"而不是物理删除，撤回标记留给 T-26 的索引任务做，这里不碰。
import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/pool.js";
import { knowledgeDocuments, knowledgeSegments } from "../db/schema.js";
import { chunk, type Segment } from "./chunk.js";
import { parseMarkdown } from "./markdown.js";
import { parseSrt } from "./srt.js";
import { parseVtt, type VttMeta } from "./vtt.js";

export type KnowledgeKind = "srt" | "vtt" | "markdown";

export type ImportResult =
  | { kind: "imported"; documentId: string; version: number; segmentCount: number }
  // 跟这节课当前最新版本的原始文件内容完全一样：不产生新 version，直接返回那一版。
  // 这是导入这一步顺手做的"防误操作重复上传"，判断的是"内容根本没变要不要建新记录"——
  // 不是 T-26 索引层"内容变了要不要重新生成向量"那件事，两者依据都是 hash，但用途不同。
  | { kind: "unchanged"; documentId: string; version: number };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const EMPTY_META: VttMeta = { sourceUrl: null, sourceTitle: null, recordedAt: null };

// 只有 VTT 可能带 NOTE 头部信息；SRT/Markdown 没有这类头部，meta 恒为空。
function parseContent(kind: KnowledgeKind, rawContent: string): { segments: Segment[]; meta: VttMeta } {
  if (kind === "srt") return { segments: chunk(parseSrt(rawContent)), meta: EMPTY_META };
  if (kind === "vtt") {
    const { cues, meta } = parseVtt(rawContent);
    return { segments: chunk(cues), meta };
  }
  return { segments: chunk(parseMarkdown(rawContent)), meta: EMPTY_META };
}

/**
 * 失败重跑不会产生重复数据：document 行和它所有的 segment 行在同一个事务里提交，
 * 半路失败整体回滚，不会留下"建了一半"的 version；重跑时重新查一次"当前最新 version"，
 * 拿到的是下一个干净的号，不会跟失败的那次冲突或重复。
 */
export async function importKnowledgeDocument(
  db: Db,
  args: { lessonId: string; kind: KnowledgeKind; sourceName: string; rawContent: string; visibility?: "public" | "private" },
): Promise<ImportResult> {
  const sourceHash = sha256(args.rawContent);

  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ id: knowledgeDocuments.id, version: knowledgeDocuments.version, sourceHash: knowledgeDocuments.sourceHash })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.lessonId, args.lessonId))
      .orderBy(desc(knowledgeDocuments.version))
      .limit(1);

    if (latest && latest.sourceHash === sourceHash) {
      return { kind: "unchanged", documentId: latest.id, version: latest.version } as const;
    }

    const { segments, meta } = parseContent(args.kind, args.rawContent);
    const version = (latest?.version ?? 0) + 1;

    const [document] = await tx
      .insert(knowledgeDocuments)
      .values({
        lessonId: args.lessonId, kind: args.kind, sourceName: args.sourceName, sourceHash, version,
        sourceUrl: meta.sourceUrl, sourceTitle: meta.sourceTitle, recordedAt: meta.recordedAt,
        ...(args.visibility ? { visibility: args.visibility } : {}),
      })
      .returning();

    if (segments.length > 0) {
      await tx.insert(knowledgeSegments).values(
        segments.map((s, position) => ({
          documentId: document!.id,
          position,
          content: s.content,
          contentHash: sha256(s.content),
          startMs: s.startMs,
          endMs: s.endMs,
        })),
      );
    }

    return { kind: "imported", documentId: document!.id, version, segmentCount: segments.length } as const;
  });
}

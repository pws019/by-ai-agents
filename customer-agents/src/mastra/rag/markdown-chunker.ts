import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

// 一个 chunk 是 RAG 的最小检索单元。
// 我们不是把整篇 Markdown 一次性塞进向量库，而是按“场景”切成多个 chunk。
export type KnowledgeChunk = {
  id: string;
  content: string;
  source: string;
  title: string;
  chunkIndex: number;
};

/**
 * 生成稳定 id。
 *
 * 入库脚本可能会重复执行。稳定 id 能让 Qdrant upsert 覆盖旧点，
 * 而不是每次都插入一批重复数据。
 */
function slugHash(text: string) {
  const hash = createHash("sha256").update(text).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

/**
 * 按二级标题切块。
 *
 * 当前维修文档格式是：
 * # 冰箱维修知识
 * ## 场景：xxx
 * **可能原因**：
 * **排查与维修步骤**：
 *
 * 所以每个“## 场景”天然就是一个完整语义块，很适合直接作为 RAG chunk。
 */
function splitByScenario(markdown: string) {
  const matches = [...markdown.matchAll(/^## 场景：.+$/gm)];
  if (matches.length === 0) return [markdown.trim()].filter(Boolean);

  return matches
    .map((match, index) => {
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? markdown.length;
      return markdown.slice(start, end).trim();
    })
    .filter(Boolean);
}

/**
 * 读取一个 Markdown 文件，并转换成多个 KnowledgeChunk。
 *
 * source/title/chunkIndex 会进入 Qdrant payload，
 * 方便检索命中后告诉 Agent：答案依据来自哪个文件、哪个场景。
 */
export async function loadMarkdownChunks(filePath: string) {
  const markdown = await readFile(filePath, "utf8");
  const source = path.basename(filePath);
  const sections = splitByScenario(markdown);

  return sections.map<KnowledgeChunk>((content, index) => {
    const title = content.match(/^##\s+(.+)$/m)?.[1] ?? source;
    return {
      id: `${slugHash(`${source}:${index}:${title}`)}`,
      content,
      source,
      title,
      chunkIndex: index,
    };
  });
}

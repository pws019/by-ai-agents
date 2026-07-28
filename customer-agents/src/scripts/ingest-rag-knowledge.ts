import { readdir } from "node:fs/promises";
import path from "node:path";

import { embedDocuments } from "../mastra/rag/embedding-client";
import { ragConfig } from "../mastra/rag/config";
import { loadMarkdownChunks } from "../mastra/rag/markdown-chunker";
import { ensureKnowledgeIndex, knowledgeVectorStore } from "../mastra/rag/vector-store";

// 默认从仓库根目录的 rag-knowledge 读取 Markdown。
// 因为脚本通常在 customer-agents 下运行，所以这里用 ../rag-knowledge。
const knowledgeDir = process.env.RAG_KNOWLEDGE_DIR ?? path.resolve(process.cwd(), "../rag-knowledge");
const batchSize = Number(process.env.RAG_INGEST_BATCH_SIZE ?? "8");

async function main() {
  // 1. 找到所有待入库的 Markdown 文件。
  const files = (await readdir(knowledgeDir))
    .filter((file) => file.endsWith(".md"))
    .map((file) => path.join(knowledgeDir, file));

  if (files.length === 0) {
    throw new Error(`No markdown files found in ${knowledgeDir}`);
  }

  // 2. 把 Markdown 按“## 场景”切成 chunk。
  //    例如三份文档各 6 个场景，就会得到 18 个 chunk。
  const chunks = (await Promise.all(files.map(loadMarkdownChunks))).flat();

  // 3. 确保 Qdrant 里有目标 collection，没有就创建。
  await ensureKnowledgeIndex();

  // 4. 分批向量化并写入 Qdrant。
  //    分批是为了避免一次请求 embedding 服务塞太多文本。
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);

    // 4.1 文本 -> 向量。vectors[index] 和 batch[index] 一一对应。
    const vectors = await embedDocuments(batch.map((chunk) => chunk.content));

    // 4.2 向量 + 原文 metadata -> Qdrant points。
    await knowledgeVectorStore.upsert({
      indexName: ragConfig.qdrantCollection,
      ids: batch.map((chunk) => chunk.id),
      vectors,
      metadata: batch.map((chunk) => ({
        text: chunk.content,
        content: chunk.content,
        source: chunk.source,
        title: chunk.title,
        chunkIndex: chunk.chunkIndex,
      })),
    });

    console.log(`Indexed ${Math.min(start + batch.length, chunks.length)}/${chunks.length} chunks`);
  }

  // 5. 入库完成。之后 knowledgeRagTool 就可以对这个 collection 做相似度搜索。
  console.log(
    `RAG ingest complete: ${chunks.length} chunks -> Qdrant collection "${ragConfig.qdrantCollection}"`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

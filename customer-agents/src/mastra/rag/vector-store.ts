import { QdrantVector } from "@mastra/qdrant";

import { ragConfig } from "./config";

class KnowledgeQdrantVector extends QdrantVector {
  async query(params: Parameters<QdrantVector["query"]>[0]) {
    const results = await super.query(params);
    return results.filter((result) => result.score >= ragConfig.scoreThreshold);
  }
}

export const knowledgeVectorStore = new KnowledgeQdrantVector({
  id: "knowledge-vector",
  url: ragConfig.qdrantUrl,
  apiKey: process.env.QDRANT_API_KEY || undefined,
});

export async function ensureKnowledgeIndex() {
  const indexes = await knowledgeVectorStore.listIndexes();
  if (indexes.includes(ragConfig.qdrantCollection)) return;

  await knowledgeVectorStore.createIndex({
    indexName: ragConfig.qdrantCollection,
    dimension: ragConfig.vectorSize,
    metric: "cosine",
  });
}

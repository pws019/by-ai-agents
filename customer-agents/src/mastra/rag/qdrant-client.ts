import { ragConfig } from "./config";

// payload 是跟向量一起存进 Qdrant 的原文信息。
// 检索时 Qdrant 返回向量相似度，同时把这些字段带回来给 LLM 作为依据。
export type KnowledgePayload = {
  content: string;
  source: string;
  title: string;
  chunkIndex: number;
};

// 对外暴露的检索结果结构：分数 + 原文 payload。
export type SearchResult = {
  id: string | number;
  score: number;
  payload: KnowledgePayload;
};

type QdrantSearchResponse = {
  result: Array<{
    id: string | number;
    score: number;
    payload?: KnowledgePayload;
  }>;
};

function qdrantUrl(path: string) {
  return `${ragConfig.qdrantUrl.replace(/\/$/, "")}${path}`;
}

/**
 * Qdrant HTTP 请求小封装。
 *
 * 项目没有引入 qdrant-js SDK，直接用 HTTP API，
 * 好处是依赖少、协议透明；坏处是需要自己维护请求/响应结构。
 */
async function qdrantFetch(path: string, init?: RequestInit) {
  const response = await fetch(qdrantUrl(path), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Qdrant request failed: ${response.status} ${await response.text()}`);
  }

  return response;
}

/**
 * 确保 collection 存在。
 *
 * Qdrant collection 类似数据库里的表。创建时必须指定向量维度和距离算法。
 * 注意：向量维度必须和 embedding 模型输出一致，比如 Qwen3-Embedding-0.6B 默认 1024 维。
 */
export async function ensureCollection() {
  const collection = encodeURIComponent(ragConfig.qdrantCollection);
  const exists = await fetch(qdrantUrl(`/collections/${collection}`));

  if (exists.ok) return;

  await qdrantFetch(`/collections/${collection}`, {
    method: "PUT",
    body: JSON.stringify({
      vectors: {
        size: ragConfig.vectorSize,
        distance: "Cosine",
      },
    }),
  });
}

/**
 * 写入或覆盖知识点。
 *
 * 每个 point = id + vector + payload。
 * - vector 用于相似度搜索
 * - payload 用于把原文片段、来源、标题还给 Agent/LLM
 */
export async function upsertKnowledgePoints(
  points: Array<{ id: string; vector: number[]; payload: KnowledgePayload }>,
) {
  const collection = encodeURIComponent(ragConfig.qdrantCollection);
  await qdrantFetch(`/collections/${collection}/points?wait=true`, {
    method: "PUT",
    body: JSON.stringify({ points }),
  });
}

/**
 * 根据 query 向量搜索知识库。
 *
 * with_payload=true 表示不仅要相似度分数，还要把原文 content/source/title 带回来。
 */
export async function searchKnowledge(vector: number[], limit = ragConfig.topK) {
  const collection = encodeURIComponent(ragConfig.qdrantCollection);
  const response = await qdrantFetch(`/collections/${collection}/points/search`, {
    method: "POST",
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      score_threshold: ragConfig.scoreThreshold,
    }),
  });

  const body = (await response.json()) as QdrantSearchResponse;
  return body.result
    .filter((item): item is SearchResult => Boolean(item.payload))
    .map((item) => ({
      id: item.id,
      score: item.score,
      payload: item.payload,
    }));
}

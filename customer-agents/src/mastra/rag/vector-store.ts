import { MastraVector } from "@mastra/core/vector";
import type {
  CreateIndexParams,
  DeleteIndexParams,
  DeleteVectorParams,
  DeleteVectorsParams,
  DescribeIndexParams,
  IndexStats,
  QueryResult,
  QueryVectorParams,
  UpdateVectorParams,
  UpsertVectorParams,
} from "@mastra/core/vector";

import { ragConfig } from "./config";

type QdrantCollectionsResponse = {
  result?: {
    collections?: Array<{ name: string }>;
  };
};

type QdrantSearchResponse = {
  result?: Array<{
    id: string | number;
    score: number;
    payload?: Record<string, unknown>;
    vector?: number[];
  }>;
};

type QdrantCollectionResponse = {
  result?: {
    vectors_count?: number;
    points_count?: number;
    config?: {
      params?: {
        vectors?:
          | {
              size?: number;
              distance?: string;
            }
          | Record<string, { size?: number; distance?: string }>;
      };
    };
  };
};

const DISTANCE_TO_QDRANT = {
  cosine: "Cosine",
  euclidean: "Euclid",
  dotproduct: "Dot",
} as const;

const DISTANCE_FROM_QDRANT = {
  Cosine: "cosine",
  Euclid: "euclidean",
  Dot: "dotproduct",
} as const;

function qdrantUrl(path: string) {
  return `${ragConfig.qdrantUrl.replace(/\/$/, "")}${path}`;
}

async function qdrantFetch(path: string, init?: RequestInit) {
  const response = await fetch(qdrantUrl(path), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(process.env.QDRANT_API_KEY ? { "api-key": process.env.QDRANT_API_KEY } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Qdrant request failed: ${response.status} ${await response.text()}`);
  }

  return response;
}

class KnowledgeQdrantVector extends MastraVector {
  constructor() {
    super({ id: "knowledge-vector" });
  }

  async listIndexes(): Promise<string[]> {
    const response = await qdrantFetch("/collections");
    const body = (await response.json()) as QdrantCollectionsResponse;
    return body.result?.collections?.map((collection) => collection.name) ?? [];
  }

  async createIndex({ indexName, dimension, metric = "cosine" }: CreateIndexParams): Promise<void> {
    await qdrantFetch(`/collections/${encodeURIComponent(indexName)}`, {
      method: "PUT",
      body: JSON.stringify({
        vectors: {
          size: dimension,
          distance: DISTANCE_TO_QDRANT[metric],
        },
      }),
    });
  }

  async upsert({ indexName, vectors, metadata = [], ids }: UpsertVectorParams): Promise<string[]> {
    const pointIds = ids ?? vectors.map((_, index) => crypto.randomUUID());

    await qdrantFetch(`/collections/${encodeURIComponent(indexName)}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({
        points: vectors.map((vector, index) => ({
          id: pointIds[index],
          vector,
          payload: metadata[index] ?? {},
        })),
      }),
    });

    return pointIds;
  }

  async query({
    indexName,
    queryVector,
    topK = ragConfig.topK,
    includeVector = false,
  }: QueryVectorParams): Promise<QueryResult[]> {
    if (!queryVector) {
      throw new Error("queryVector is required for Qdrant vector search");
    }

    const response = await qdrantFetch(`/collections/${encodeURIComponent(indexName)}/points/search`, {
      method: "POST",
      body: JSON.stringify({
        vector: queryVector,
        limit: topK,
        with_payload: true,
        with_vector: includeVector,
        score_threshold: ragConfig.scoreThreshold,
      }),
    });

    const body = (await response.json()) as QdrantSearchResponse;
    return (body.result ?? []).map((item) => ({
      id: String(item.id),
      score: item.score,
      metadata: item.payload ?? {},
      vector: item.vector,
      document: typeof item.payload?.text === "string" ? item.payload.text : undefined,
    }));
  }

  async describeIndex({ indexName }: DescribeIndexParams): Promise<IndexStats> {
    const response = await qdrantFetch(`/collections/${encodeURIComponent(indexName)}`);
    const body = (await response.json()) as QdrantCollectionResponse;
    const vectorsConfig = body.result?.config?.params?.vectors;
    const vectorParams =
      vectorsConfig && "size" in vectorsConfig
        ? vectorsConfig
        : Object.values(vectorsConfig ?? {})[0];
    const distance = vectorParams?.distance;

    return {
      dimension: vectorParams?.size ?? ragConfig.vectorSize,
      count: body.result?.points_count ?? body.result?.vectors_count ?? 0,
      metric:
        distance && distance in DISTANCE_FROM_QDRANT
          ? DISTANCE_FROM_QDRANT[distance as keyof typeof DISTANCE_FROM_QDRANT]
          : "cosine",
    };
  }

  async deleteIndex({ indexName }: DeleteIndexParams): Promise<void> {
    await qdrantFetch(`/collections/${encodeURIComponent(indexName)}`, { method: "DELETE" });
  }

  async updateVector(_params: UpdateVectorParams): Promise<void> {
    throw new Error("updateVector is not implemented for KnowledgeQdrantVector");
  }

  async deleteVector({ indexName, id }: DeleteVectorParams): Promise<void> {
    await qdrantFetch(`/collections/${encodeURIComponent(indexName)}/points/delete?wait=true`, {
      method: "POST",
      body: JSON.stringify({ points: [id] }),
    });
  }

  async deleteVectors({ indexName, ids }: DeleteVectorsParams): Promise<void> {
    if (!ids) {
      throw new Error("deleteVectors currently supports ids only");
    }

    await qdrantFetch(`/collections/${encodeURIComponent(indexName)}/points/delete?wait=true`, {
      method: "POST",
      body: JSON.stringify({ points: ids }),
    });
  }
}

export const knowledgeVectorStore = new KnowledgeQdrantVector();

export async function ensureKnowledgeIndex() {
  const indexes = await knowledgeVectorStore.listIndexes();
  if (indexes.includes(ragConfig.qdrantCollection)) return;

  await knowledgeVectorStore.createIndex({
    indexName: ragConfig.qdrantCollection,
    dimension: ragConfig.vectorSize,
    metric: "cosine",
  });
}

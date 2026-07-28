import type { MastraSupportedEmbeddingModel } from "@mastra/core/vector";

import { ragConfig } from "./config";

type OpenAIEmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
  usage?: { total_tokens?: number; prompt_tokens?: number };
};

/**
 * Mastra RAG 工具消费的是 EmbeddingModel 抽象，而不是裸 HTTP 函数。
 * 这里把本地 OpenAI-compatible /v1/embeddings 服务包成一个 v3 embedding model，
 * 让入库脚本和 createVectorQueryTool 复用同一套模型接口。
 */
function createLocalEmbeddingModel(instruction: string): MastraSupportedEmbeddingModel<string> {
  return {
    specificationVersion: "v3",
    provider: "yd-local-embedding",
    modelId: ragConfig.embeddingModel,
    maxEmbeddingsPerCall: undefined,
    supportsParallelCalls: true,
    async doEmbed({ values, abortSignal, headers }) {
      const input = values.map((value) => `${instruction}\n${value}`);
      const body = await requestOpenAICompatibleEmbeddings(input, abortSignal, headers);

      return {
        embeddings: body.data.map((item) => item.embedding),
        usage:
          body.usage?.total_tokens || body.usage?.prompt_tokens
            ? { tokens: body.usage.total_tokens ?? body.usage.prompt_tokens ?? 0 }
            : undefined,
        warnings: [],
        response: { body },
      };
    },
  };
}

async function requestOpenAICompatibleEmbeddings(
  input: string[],
  abortSignal?: AbortSignal,
  headers?: Record<string, string>,
) {
  const response = await fetch(`${ragConfig.embeddingBaseUrl.replace(/\/$/, "")}/v1/embeddings`, {
    method: "POST",
    signal: abortSignal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ragConfig.embeddingApiKey}`,
      ...(headers ?? {}),
    },
    body: JSON.stringify({
      model: ragConfig.embeddingModel,
      input,
    }),
  });

  if (!response.ok) {
    throw new Error(`Embedding request failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as OpenAIEmbeddingResponse;
}

export const documentEmbeddingModel = createLocalEmbeddingModel(ragConfig.documentInstruction);
export const queryEmbeddingModel = createLocalEmbeddingModel(ragConfig.queryInstruction);

// 入库时使用：把 Markdown chunk 转成“文档向量”。
export async function embedDocuments(texts: string[]) {
  const { embeddings } = await documentEmbeddingModel.doEmbed({ values: texts });
  return embeddings;
}

// 查询时使用：把用户问题转成“查询向量”。
export async function embedQuery(text: string) {
  const { embeddings } = await queryEmbeddingModel.doEmbed({ values: [text] });
  return embeddings[0];
}

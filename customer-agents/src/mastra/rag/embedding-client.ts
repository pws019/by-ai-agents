import { ragConfig } from "./config";

type OpenAIEmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
};

/**
 * 给 embedding 输入加任务说明。
 *
 * 直觉上，embedding 模型不是在“回答问题”，而是在把文本压成向量。
 * instruction 会告诉它：这段文本应该被表示成“用于维修知识检索”的向量。
 */
function withInstruction(text: string, instruction: string) {
  return `${instruction}\n${text}`;
}

/**
 * 调用 Text Embeddings Inference 风格接口。
 *
 * 这类服务通常暴露 POST /embed，输入是 { inputs: string[] }，
 * 输出可能直接是 number[][]，也可能包在 { embeddings } 里。
 */
async function embedWithTei(texts: string[]) {
  const response = await fetch(`${ragConfig.embeddingBaseUrl.replace(/\/$/, "")}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: texts }),
  });

  if (!response.ok) {
    throw new Error(`TEI embedding request failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as number[][] | { embeddings?: number[][] };
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.embeddings)) return body.embeddings;
  throw new Error("TEI embedding response did not contain embeddings");
}

/**
 * 调用 OpenAI-compatible embeddings 接口。
 *
 * 如果你后续把 Qwen embedding 包成 /v1/embeddings，
 * 或者换成其他兼容 OpenAI 协议的向量服务，就走这个分支。
 */
async function embedWithOpenAICompatible(texts: string[]) {
  const response = await fetch(`${ragConfig.embeddingBaseUrl.replace(/\/$/, "")}/v1/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ragConfig.embeddingApiKey}`,
    },
    body: JSON.stringify({
      model: ragConfig.embeddingModel,
      input: texts,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI-compatible embedding request failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as OpenAIEmbeddingResponse;
  return body.data.map((item) => item.embedding);
}

/**
 * 根据配置选择实际 embedding provider。
 * 上层代码不关心具体协议，只要拿到 number[] 向量即可。
 */
async function embed(texts: string[]) {
  if (ragConfig.embeddingProvider === "openai-compatible") {
    return embedWithOpenAICompatible(texts);
  }

  return embedWithTei(texts);
}

// 入库时使用：把 Markdown chunk 转成“文档向量”。
export async function embedDocuments(texts: string[]) {
  return embed(texts.map((text) => withInstruction(text, ragConfig.documentInstruction)));
}

// 查询时使用：把用户问题转成“查询向量”。
export async function embedQuery(text: string) {
  const [embedding] = await embed([withInstruction(text, ragConfig.queryInstruction)]);
  return embedding;
}

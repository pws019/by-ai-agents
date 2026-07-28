import { createTool } from "@mastra/core/tools";
import { MastraAgentRelevanceScorer, rerankWithScorer } from "@mastra/rag";
import { z } from "zod";

import { localChatModel } from "../models/local-models";
import { ragConfig } from "../rag/config";
import { embedQuery } from "../rag/embedding-client";
import { knowledgeVectorStore } from "../rag/vector-store";

const knowledgeReranker = new MastraAgentRelevanceScorer(
  "knowledge-reranker",
  localChatModel as unknown as ConstructorParameters<typeof MastraAgentRelevanceScorer>[1],
);

const retrievedKnowledgeSchema = z.object({
  text: z.string().describe("检索命中的知识片段正文"),
  source: z.string().describe("知识来源文件或文档标识，没有来源时为空字符串"),
  title: z.string().describe("知识片段标题，没有标题时为空字符串"),
  chunkIndex: z.number().describe("知识片段序号，没有序号时为 -1"),
  score: z.number().describe("向量召回或重排后的相关性分数"),
});

function toRetrievedKnowledge(result: {
  score?: number;
  metadata?: Record<string, unknown>;
  document?: string;
}) {
  const metadata = result.metadata ?? {};
  const text =
    typeof metadata.text === "string"
      ? metadata.text
      : typeof metadata.content === "string"
        ? metadata.content
        : result.document ?? "";

  return {
    text,
    source: typeof metadata.source === "string" ? metadata.source : "",
    title: typeof metadata.title === "string" ? metadata.title : "",
    chunkIndex: typeof metadata.chunkIndex === "number" ? metadata.chunkIndex : -1,
    score: result.score ?? 0,
  };
}

export const knowledgeRagTool = createTool({
  id: "knowledge-rag-tool",
  description:
    "检索商品说明、使用方法、保养方式、售后政策、退换货流程、质保等非实时知识。只用于非实时知识，" +
    `不要用于实时订单、物流、库存、价格、退款进度等查询。调用时 queryText 使用用户原问题，topK 使用 ${
      ragConfig.topK * ragConfig.rerankCandidateMultiplier
    } 以便先召回候选，再由 rerank 精排。`,
  inputSchema: z.object({
    queryText: z.string().describe("用户原始问题，用于生成查询向量"),
    topK: z.number().describe("先召回的候选数量"),
  }),
  outputSchema: z.object({
    relevantContext: z.array(retrievedKnowledgeSchema).describe("可直接用于回答用户的知识片段"),
    sources: z.array(retrievedKnowledgeSchema).describe("检索来源及相关性分数"),
  }),
  execute: async ({ queryText, topK }) => {
    const candidateTopK = topK;
    const queryVector = await embedQuery(queryText);
    const results = await knowledgeVectorStore.query({
      indexName: ragConfig.qdrantCollection,
      queryVector,
      topK: candidateTopK,
      includeVector: false,
    });

    const rerankedResults = await rerankWithScorer({
      results,
      query: queryText,
      scorer: knowledgeReranker,
      options: {
        topK: ragConfig.topK,
        queryEmbedding: queryVector,
        weights: {
          semantic: 0.5,
          vector: 0.3,
          position: 0.2,
        },
      },
    });

    const relevantContext = rerankedResults.map(({ result, score }) =>
      toRetrievedKnowledge({ ...result, score }),
    );

    return {
      relevantContext,
      sources: relevantContext,
    };
  },
});

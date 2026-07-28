import { createVectorQueryTool, MastraAgentRelevanceScorer } from "@mastra/rag";

import { localChatModel } from "../models/local-models";
import { ragConfig } from "../rag/config";
import { queryEmbeddingModel } from "../rag/embedding-client";
import { knowledgeVectorStore } from "../rag/vector-store";

const knowledgeReranker = new MastraAgentRelevanceScorer(
  "knowledge-reranker",
  localChatModel as unknown as ConstructorParameters<typeof MastraAgentRelevanceScorer>[1],
);

/**
 * Agent 可调用的 RAG 工具。
 *
 * 运行时链路：
 * 用户问“冰箱冷藏室积水怎么办”
 * -> Agent 判断这是知识类问题，调用 knowledgeRagTool
 * -> Mastra Vector Query Tool 把 queryText 转成向量
 * -> 用向量去 Qdrant 搜相似维修场景
 * -> 用本地 LLM rerank 后把 relevantContext/sources 还给 Agent
 * -> Agent 再基于这些依据组织客服回复
 */
export const knowledgeRagTool = createVectorQueryTool({
  id: "knowledge-rag-tool",
  description:
    "检索商品说明、使用方法、保养方式、售后政策、退换货流程、质保等非实时知识。只用于非实时知识，" +
    `不要用于实时订单、物流、库存、价格、退款进度等查询。调用时 queryText 使用用户原问题，topK 使用 ${
      ragConfig.topK * ragConfig.rerankCandidateMultiplier
    } 以便先召回候选，再由 rerank 精排。`,
  vectorStore: knowledgeVectorStore,
  indexName: ragConfig.qdrantCollection,
  model: queryEmbeddingModel,
  reranker: {
    model: knowledgeReranker,
    options: {
      topK: ragConfig.topK,
      weights: {
        semantic: 0.5,
        vector: 0.3,
        position: 0.2,
      },
    },
  },
});

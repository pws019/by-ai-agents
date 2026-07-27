import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { embedQuery } from "../rag/embedding-client";
import { searchKnowledge } from "../rag/qdrant-client";

/**
 * Agent 可调用的 RAG 工具。
 *
 * 运行时链路：
 * 用户问“冰箱冷藏室积水怎么办”
 * -> Agent 判断这是知识类问题，调用 knowledgeRagTool
 * -> 工具把 query 转成向量
 * -> 用向量去 Qdrant 搜相似维修场景
 * -> 把命中的 content/source 还给 Agent
 * -> Agent 再基于这些依据组织客服回复
 */
export const knowledgeRagTool = createTool({
  id: "knowledge-rag-tool",
  description:
    "检索商品说明、使用方法、保养方式、售后政策、退换货流程、质保等非实时知识。只用于非实时知识，" +
    "不要用于实时订单、物流、库存、价格、退款进度等查询。",
  inputSchema: z.object({
    query: z.string().describe("用户想了解的知识类问题，例如商品参数、保养方式、售后政策等"),
  }),
  outputSchema: z.object({
    hasResults: z.boolean().describe("知识库是否命中相关内容"),
    relevantContext: z
      .array(
        z.object({
          content: z.string(),
          source: z.string(),
        }),
      )
      .describe("命中的知识片段和来源，未命中时为空数组"),
    note: z.string().describe("附加说明，例如未接入知识库的提示"),
  }),
  execute: async ({ query }) => {
    try {
      // 1. 用户问题 -> 查询向量。
      const vector = await embedQuery(query);

      // 2. 查询向量 -> Qdrant 相似度搜索。
      const results = await searchKnowledge(vector);

      // 3. 把 Qdrant payload 整理成 tool output，交给 Agent/LLM 使用。
      return {
        hasResults: results.length > 0,
        relevantContext: results.map((result) => ({
          content: result.payload.content,
          source: `${result.payload.source}#${result.payload.title}`,
        })),
        note:
          results.length > 0
            ? `命中 ${results.length} 条维修知识片段。`
            : "知识库未命中相关维修知识片段。",
      };
    } catch (error) {
      // 工具失败时也不能编造知识；明确告诉 Agent 检索失败，让它按 system prompt 处理。
      const message = error instanceof Error ? error.message : String(error);
      return {
        hasResults: false,
        relevantContext: [],
        note: `知识库检索失败：${message}`,
      };
    }
  },
});

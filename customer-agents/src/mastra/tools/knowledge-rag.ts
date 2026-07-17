import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * 知识库检索工具（占位实现）。
 *
 * 知识库（商品说明/使用方法/保养方式/售后政策/退换货流程/质保等）暂未接入，这里先留空，
 * 始终返回“未命中”，让 agent 按 instructions 里第 6 条的规则处理：说明暂未查到准确依据，
 * 并建议转人工或补充商品/订单信息。不要在这里编造检索结果。
 *
 * 后续接入真实知识库时，只需要替换 execute 内部实现，inputSchema/outputSchema 保持不变即可，
 * agent 和 instructions 都不需要跟着改。
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
  execute: async () => {
    // TODO(Phase 4): 接入真实知识库检索后替换这里的实现。
    return {
      hasResults: false,
      relevantContext: [],
      note: "知识库尚未接入，本次检索始终返回未命中。",
    };
  },
});

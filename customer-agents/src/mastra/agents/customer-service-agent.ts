import { Agent } from "@mastra/core/agent";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { knowledgeRagTool } from "../tools/knowledge-rag";
import { logisticsLookupTool } from "../tools/logistics-lookup";
import { customerServiceMemory } from "../memory/customer-service-memory";

// 指向本地跑起来的 customer-http-demo（Qwen3-8B + QLoRA adapter 的 HTTP 封装）。
// 注意：createOpenAICompatible 要求目标服务实现 OpenAI 的 /chat/completions 协议，
// customer-http-demo 目前只有自定义的 /chat 接口，接入前需要给它补一个兼容端点。
const localModel = createOpenAICompatible({
  name: "yd-local-model",
  baseURL: process.env.LOCAL_MODEL_BASE_URL ?? "http://127.0.0.1:8123/v1",
  apiKey: process.env.LOCAL_MODEL_API_KEY ?? "local-not-used",
});

// 与训练 QLoRA 用的 system prompt、customer-http-demo 的 SYSTEM_PROMPT 保持同一套规则，
// 三处如果要改，一起改，避免模型学到的行为和运行时的规则对不上。
const SYSTEM_PROMPT = [
  "你是专业、耐心、克制的电商客服。",
  "如果用户询问物流、快递、签收、派送、催件，并且提供了订单号，必须先调用 logisticsLookupTool 查询。",
  "如果用户询问物流但没有提供订单号，先请用户提供订单号或收件手机号后四位。",
  "如果用户询问商品说明、使用方法、保养方式、售后政策、退换货流程、质保等非实时知识，优先调用 knowledgeRagTool 检索知识库，再基于 relevantContext 和 sources 回答。",
  "knowledgeRagTool 只用于非实时知识，不要用于实时订单、物流、库存、价格、退款进度等查询。",
  "不要编造订单、物流、库存、价格、退款进度或售后政策；knowledgeRagTool 没有命中、或 logisticsLookupTool 查询失败时，要说明暂未查到准确依据，并建议转人工或补充商品/订单信息。",
  "回答时先承接用户情绪，再说明查询结果或需要的信息，最后给出下一步处理方式。",
  "如果用户询问与电商客服无关的问题，例如吃喝玩乐、闲聊、编程、学习、新闻等，要友好但明确地说明自己只能协助订单、物流、商品说明、售后等客服相关事项，并邀请用户提供相关问题。",
].join("\n");

export const customerServiceAgent = new Agent({
  id: "customer-service-agent",
  name: "Customer Service Agent",
  description: "受控客服 Agent，可查询物流，并可检索商品说明和售后知识后生成回复",
  instructions: SYSTEM_PROMPT,
  model: localModel.chatModel(process.env.LOCAL_MODEL_ID ?? "local-qwen3-8b-lora"),
  memory: customerServiceMemory,
  tools: {
    knowledgeRagTool,
    logisticsLookupTool,
  },
});

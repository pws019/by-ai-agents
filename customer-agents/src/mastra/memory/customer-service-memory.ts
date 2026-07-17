import { Memory } from "@mastra/memory";

/**
 * 客服 Agent 的会话记忆：保留最近若干轮对话，让多轮追问（比如追加订单号、反复催促）
 * 能被正确承接，而不是每轮都当作全新对话处理。
 */
export const customerServiceMemory = new Memory({
  options: {
    lastMessages: 20,
  },
});

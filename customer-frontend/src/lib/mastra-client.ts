import { MastraClient } from "@mastra/client-js";

import { MASTRA_BASE_URL } from "./constants";

// 单例：整个前端只用这一个 client 实例跟 customer-agents 的 mastra dev 交互。
export const mastraClient = new MastraClient({
  baseUrl: MASTRA_BASE_URL,
});

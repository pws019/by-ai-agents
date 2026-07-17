mastra主应用，调用其他应用服务的

依赖本地的http-demo作为模型服务
![alt text](image.png)

## 实现说明

- `src/mastra/agents/customer-service-agent.ts`：客服 Agent，system prompt 与 QLoRA 训练、
  `customer-http-demo` 保持同一套规则，通过 `createOpenAICompatible` 接到本地的
  `customer-http-demo`。
- `src/mastra/tools/knowledge-rag.ts`：RAG 工具，暂时留空，始终返回未命中 + 明确提示。
- `src/mastra/tools/logistics-lookup.ts`：物流查询工具，真实实现，通过 HTTP 调用
  `customer-logistics-api`（尚未实现，先约定了 `GET /orders/{orderId}/logistics` 契约）。
- `src/mastra/memory/customer-service-memory.ts`：会话记忆，保留最近 20 轮。
- `src/mastra/index.ts`：注册 Mastra 实例（agent + LibSQL 本地存储）。

## 运行

依赖 `customer-http-demo` 已经在 `http://127.0.0.1:8123` 跑起来（提供 `/v1/chat/completions`
兼容接口）。

```bash
cd customer-agents
npm install

# 直接跑一个端到端测试脚本（走 Mastra 实例 + 本地存储，不需要 mastra dev）
npx tsx src/scripts/test-agent.ts

# 或者用 Mastra 自带的开发服务器/Studio
npx mastra dev
```

已端到端验证：物流未提供订单号（引导给订单号）、离题问题（礼貌拒答）两类场景，Agent 通过
OpenAI 兼容接口正确调用到本地模型并拿到符合模板的回复。
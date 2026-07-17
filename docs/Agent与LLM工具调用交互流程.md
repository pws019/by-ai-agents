# Agent - LLM - HTTP 工具调用交互流程

记录 `customer-agents`（Mastra）→ `customer-http-demo`（Qwen3-8B + LoRA 的模型服务）→
`customer-logistics-api`（mock 订单/物流接口）这三者之间，一次"用户问物流"的完整交互过程。
核心结论先说：**LLM 从不直接发起对业务 API 的 HTTP 请求，它只负责"决策要不要调用工具/调用
参数是什么"和"根据工具结果怎么组织话术"这两件事；真正发起业务 API 请求的是 Agent 运行时
（Mastra 的 TypeScript 代码）**。

## 一句话流程图

```text
用户: "我的快递到哪了？订单号OD202607170099。"

┌─────────────┐   ①HTTP: messages + tools schema    ┌──────────────────┐
│   Agent     │ ───────────────────────────────────> │ customer-http-demo│
│  (Mastra)   │                                       │ (Qwen3-8B + LoRA)  │
│             │ <─────────────────────────────────── │                    │
│             │   模型吐出 <tool_call>{...}</tool_call>│                    │
│             │   被解析成 tool_calls，finish_reason:  │                    │
│             │   "tool_calls"（不是最终答案）         │                    │
└──────┬──────┘                                       └──────────────────┘
       │
       │ ②HTTP: 真正调用工具（Agent 自己的代码，不经过 LLM）
       ▼
┌──────────────────┐
│customer-logistics │  返回真实（mock）数据，或 404 / 网络错误
│      -api         │
└──────┬────────────┘
       │
       │ 工具结果作为新一轮 "tool" 消息，拼回对话
       ▼
┌─────────────┐   ③HTTP: messages（含工具结果） + tools schema
│   Agent     │ ───────────────────────────────────> customer-http-demo
│  (Mastra)   │ <─────────────────────────────────── 
│             │   这次模型基于工具结果生成自然语言回复，
│             │   finish_reason: "stop"（真正的最终答案）
└──────┬──────┘
       │
       ▼
   返回给用户
```

## 分步说明

### 第①次 HTTP：Agent 问模型"该怎么办"

- 谁发起：Agent（Mastra 运行时）
- 打给谁：`customer-http-demo` 的 `POST /v1/chat/completions`
- 带了什么：`messages`（system + 用户消息）+ `tools`（`logisticsLookupTool` 的 JSON Schema 定义）
- 模型做了什么：`customer-http-demo` 把 `tools` 透传给
  `tokenizer.apply_chat_template(messages, tools=tools, ...)`，Qwen3 的模板会在 prompt 里
  注入工具定义。模型如果判断需要调用工具，会在生成的文本里吐出：
  ```text
  <tool_call>
  {"name": "logisticsLookupTool", "arguments": {"orderId": "OD202607170099"}}
  </tool_call>
  ```
- `customer-http-demo` 把这段文本解析（`model.py` 里的 `parse_tool_calls`），转换成标准
  OpenAI 格式的 `tool_calls` 字段返回给 Agent，`finish_reason` 标记为 `"tool_calls"`
  （明确告诉调用方："这不是最终答案，是个工具调用请求"）。
- **这一步 LLM 没有、也不会去访问 `customer-logistics-api`。它只是在文本里"建议"该调用
  哪个工具、传什么参数，本质上是一次结构化的文本生成。**

### 第②次 HTTP：Agent 真正执行工具

- 谁发起：Agent（Mastra 运行时的 TypeScript 代码，`customer-agents/src/mastra/tools/
  logistics-lookup.ts` 里 `execute()` 函数里的 `fetch()`）
- 打给谁：`customer-logistics-api` 的 `GET /orders/{orderId}/logistics`
- **这一步完全不经过 LLM**，就是普通的 Node.js HTTP 请求。Mastra 看到第①步返回的
  `tool_calls` 里有 `logisticsLookupTool`，就去查找 Agent 上注册的同名工具（`tools:
  { logisticsLookupTool }`），拿第①步解析出的参数（`{ orderId: "OD202607170099" }`）
  调用它的 `execute()`。
- 成功：返回真实的物流数据（mock 服务里预置的 in_transit/delivered/exception 等场景）。
- 失败（订单不存在、物流记录缺失、请求超时/网络错误）：`execute()` **不抛异常**，而是
  返回一个结构化的失败结果，例如：
  ```json
  { "found": false, "message": "未查询到订单号 OD_NOT_EXIST_9999 对应的物流信息，请确认订单号是否正确。" }
  ```
  这一点很关键——工具执行失败不是"扔回给 Agent 当异常处理"，而是**作为正常的工具返回值**
  进入下一步。

### 第③次 HTTP：Agent 把工具结果交给模型组织话术

- 谁发起：Agent（Mastra 运行时）
- 打给谁：`customer-http-demo` 的 `POST /v1/chat/completions`（同一个接口，第二次调用）
- 带了什么：更新后的 `messages`（在原来的基础上，追加了一条工具结果消息，内容就是第②步
  拿到的 `{ found, status, lastLocation, ... }` 或者 `{ found: false, message: "..." }`）
- 模型做了什么：这次模型不再需要调用工具（工具结果已经在上下文里了），而是根据 system
  prompt 里"回答时先承接用户情绪，再说明查询结果...不要编造...查询失败时说明暂未查到准确
  依据，建议转人工"这些规则，把工具结果组织成一句自然语言回复。`finish_reason` 是
  `"stop"`，代表这才是真正返回给用户的最终答案。

## 实测结果对照

| 场景 | 工具结果 | 最终回复 |
|---|---|---|
| 订单号 `OD202607170099`（mock 数据里是运输中） | `found: true, status: "in_transit", lastLocation: "上海转运中心", courier: "顺丰速运"...` | "目前物流状态为【运输中】，最新的物流节点是上海转运中心...承运商是顺丰速运..."（真实数据组织出的话，不是编的） |
| 订单号 `OD_NOT_EXIST_9999`（不存在） | `found: false, message: "未查询到订单号...请确认订单号是否正确。"` | "理解您的疑惑，但未查询到订单号 OD_NOT_EXIST_9999 对应的物流信息，请确认订单号是否正确。"（如实转述失败原因，没有编造物流状态） |
| "帮我推荐一部电影"（离题） | 没有工具调用 | 直接礼貌拒答，`toolCalls: []` |

## 涉及的文件

| 文件 | 角色 |
|---|---|
| `customer-agents/src/mastra/agents/customer-service-agent.ts` | Agent 定义：system prompt + 注册的 tools + 指向 customer-http-demo 的 model |
| `customer-agents/src/mastra/tools/logistics-lookup.ts` | 工具的 `execute()`，真正发起对 customer-logistics-api 的 HTTP 请求，失败时返回结构化结果而不是抛异常 |
| `customer-http-demo/model.py` | `_build_inputs` 把 tools 透传给 `apply_chat_template`；`parse_tool_calls` 解析模型输出的 `<tool_call>` |
| `customer-http-demo/main.py` | `/v1/chat/completions`：把解析出的 tool_calls 转成 OpenAI 标准响应格式 |
| `customer-http-demo/config.py` | 兜底 `SYSTEM_PROMPT`，措辞必须和生产环境保持一致的祈使句式，否则模型不会主动调用工具 |
| `customer-logistics-api/src/routes/orders.ts` | mock 订单/物流数据接口，返回真实数据或 404 |

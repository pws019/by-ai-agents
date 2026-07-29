# customer-frontend

客服 Agent 对话前端，playground 风格：左侧会话列表 + 右侧聊天窗口。通过 `@mastra/client-js`
跟 `customer-agents` 交互，设计依据见 `PRD.md`，任务拆分见 `todo.md`。

## 启动前置条件

必须先把 `customer-agents` 的 `mastra dev` 跑起来（默认监听 `http://localhost:4111`），
这个前端不会自己起 Agent 服务，只是个客户端。

```bash
# 仓库根目录
npm run dev   # turbo 会把 customer-agents 和 customer-frontend 一起拉起来
```

或者只单独跑这个前端：

```bash
npm install --workspace=customer-frontend
npm run dev --workspace=customer-frontend
```

默认跑在 `http://localhost:5173`。

## 配置

如果 `mastra dev` 不是跑在默认地址，建一个 `.env.local`：

```
VITE_MASTRA_BASE_URL=http://localhost:4111
```

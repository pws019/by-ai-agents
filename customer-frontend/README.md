# customer-frontend

教育服务学员端前端：左侧会话列表 + 右侧聊天窗口，另有"我的学习""我的申请"和老师工作台。
通过 `education-api` 的普通 HTTP / SSE 接口工作（走 vite 的 `/api` 代理，与页面同源，session cookie 自动带上）；
**浏览器不直连 Agent**。规格见 `specs/education-service-agent/`，接口契约见 `contracts/education/`。

> 早期版本是对接 `customer-agents`（Mastra）的电商客服 Demo，设计文档见 `PRD.md`、`todo.md`（仅作历史保留）。
> T-21 起前端已不再依赖 `@mastra/client-js`，旧的 Mastra 后端可以单独运行，但这个前端不再连它。

## 启动

需要先有：数据服务（`npm run edu:infra`）、`education-api`（8400）、`education-agent`（8500）。
这些服务的密钥和地址通过环境变量配置，见 `infra/education/.env.example`；启动前在终端加载：

```bash
set -a; source infra/education/.env; set +a
npm run dev          # 仓库根目录：turbo 拉起 education-agent + education-api
npm run dev --workspace=customer-frontend   # 前端，默认 http://localhost:5173
```

`EDUCATION_MODE=mock`（默认）时 Agent 用确定性的开发用假模型，只能证明界面和编排可用，不代表真实模型的效果。
开发库在拉取新迁移后要执行一次：`npm run migrate --workspace=education-api`。

## 结构

- `src/lib/chat/`：聊天的全部逻辑，纯 TypeScript、不依赖 React：SSE 解析（`sse.ts`）、契约事件类型与校验（`events.ts`）、
  事件→界面状态（`state.ts`）、发送/断线恢复/确认后恢复（`session.ts`）、真实网络实现（`api.ts`）。
- `src/hooks/useChat.ts`：把上面的流程接进 React；`src/components/chat/`：聊天界面。
- 断线后不需要重发：服务端会把这次运行跑完并落库，前端轮询到结果后以服务端记录为准。

## 测试

```bash
npm test --workspace=customer-frontend    # lib/chat 的单元测试（Node 自带测试运行器 + tsx）
npm run typecheck --workspace=customer-frontend
```

界面本身目前没有自动化测试，是在真实浏览器里手工验证的（见 `specs/education-service-agent/progress.md` T-21）。

# customer-frontend 任务拆分

技术栈：React + react-router + TypeScript + Vite，通过 `@mastra/client-js` 跟 `customer-agents`
（`mastra dev`，默认 http://localhost:4111）交互。加入 npm workspaces，`turbo run dev` 统一启动。

"会话"对应 Mastra 的 **Memory Thread** 概念（`customer-agents` 已经配置了 `@mastra/memory`），
不是自己另起一套会话存储 —— 增删改查会话 = 对 Memory Thread 做 CRUD。

---

## 0. 待确认的设计决策（开工前先定，避免返工）

- [x] **resourceId 怎么来**：**已定案** —— 不用 IP（同一网络出口下所有人会被合并成一个"用户"，
      NAT/运营商共享 IP 场景下问题尤其严重，且 IP 会中途变化导致会话丢失关联）。改用
      **浏览器生成匿名 UUID + 存第一方 Cookie**（不用 localStorage，Cookie 能设过期时间、
      后端也能读到）。这个 UUID 就是 `resourceId`。`resourceId` 字段设计成不透明字符串，
      不要跟"匿名"概念写死绑定 —— 以后接真登录系统时，可以在用户登录那一刻把匿名 resourceId
      名下的历史会话过户给真实账号 id，不用大改。
      - 待实现：`src/lib/anonymous-id.ts`，首次访问时生成 UUID 并写 Cookie，之后每次读 Cookie
      - Cookie 过期时间待定（比如 1 年），先用一个合理默认值，不是本阶段的重点
- [x] **agentId 确认**：写死 `customer-service-agent`（`src/lib/constants.ts`），未做多 agent 选择器
- [x] **CORS 检查**：实测过（`curl -X OPTIONS` + `Origin: http://localhost:5173`），`mastra dev`
      默认 `access-control-allow-origin: *`，不需要改 `customer-agents` 任何配置

---

## 1. 项目脚手架

- [x] `customer-frontend/` 下手动搭了 Vite + React + TypeScript 骨架（React 19 / Vite 8 /
      Tailwind v4，未用 `create vite` 脚手架命令，直接写的配置文件）
- [x] 装 `react-router`（v8，data router 模式：`createBrowserRouter` + `RouterProvider`，
      从 `react-router` 一个包导入，v8 已经把 `react-router-dom` 合并掉了）
- [x] 装 `@mastra/client-js`
- [x] `package.json` 补齐脚本：`dev`(vite) / `build`(tsc -b && vite build) / `typecheck`(tsc -b --noEmit)
- [x] 根目录 `package.json` 的 `workspaces` 数组里加了 `"customer-frontend"`
- [x] 根目录 `turbo.json` 现有 task 定义直接生效，未额外改动
- [x] `npm install` + `turbo run dev` 验证过，6 个包（含新的 `customer-frontend`）全部正常启动，
      端口不冲突（vite 5173 / mastra 4111）

## 2. Mastra 客户端接入基础

- [x] `src/lib/mastra-client.ts`：`MastraClient` 单例，`baseUrl` 读 `VITE_MASTRA_BASE_URL`，
      默认 `http://localhost:4111`
- [x] 连通性验证：写了个独立 node 脚本直接调 `@mastra/client-js`（不经过浏览器）跑通了
      "建会话→发消息→列表→拉历史→改名→删除"全流程，过程中修正了一个实现错误——见下方"实现中发现的问题"

## 3. 整体布局 —— playground 式两栏结构

明确要求：**左侧会话列表常驻，右侧聊天窗口，切换会话不整页跳转**（类似 ChatGPT / Mastra
Playground 那种布局），不是"列表页"和"详情页"两个独立页面来回跳。

- [x] react-router **layout route** 实现完了：`AppLayout` + `<Outlet />`，index 路由渲染
      "待创建"态，`/sessions/:threadId` 渲染已有会话，切换只换右侧内容
- [x] **懒创建**：`useChat.ts` 里实现，"新建会话"按钮就是 `<Link to="/">`，真正的
      `createMemoryThread` 调用延后到 `sendMessage` 内部第一次发送时才触发
- [x] `<SessionSidebar />` 增删改查：`useSessions.ts` + `SessionListItem.tsx`
      （列表 / hover 显示重命名+删除按钮 / 高亮当前会话 / loading·空状态·错误提示）

## 4. 会话内对话（右侧 ChatPanel）

- [x] `ChatPanel.tsx` 按 `threadId` 有无区分两态；已有会话态用 `thread.listMessages()` 拉历史
- [x] 发送消息：`useChat.ts` 统一处理，待创建态先 `createMemoryThread` 再 `stream()`，
      成功后回调 `onThreadCreated` 触发路由跳转
      - 已经改成 `stream()`（打字机效果 + tool-call 中间状态），不再是 `generate()`，见下面两条
- [x] 会话标题：首条消息截断前 24 字当标题（`SESSION_TITLE_MAX_LENGTH`），自动摘要**未做**
- [x] loading 态（`sending` 禁用输入+发送按钮，`TypingIndicator` 动画）、失败错误提示
      - "thread 建了但 stream 失败"这个边界情况用 `pendingThreadId` 处理了：建 thread 成功后
        立刻回调通知路由（哪怕后续 stream 失败），重试时复用已建的 id，不会重复创建
- [x] 打字机效果：切到 `agent.stream()` + `processDataStream()`，`text-delta` 事件逐段追加到
      同一条助手消息，不再是等全部生成完才一次性展示
- [x] 展示 agent 的 tool call 中间状态（"正在查询知识库…" / "正在查询物流…"）：监听 `tool-call`
      事件，按 `toolName` 映射成具体文案（`TOOL_STATUS_LABELS`，见 `lib/constants.ts`），第一段
      `text-delta` 到达时收起，交由真实的回复气泡接管——不再是笼统的"正在处理…"
- [x] **工具调用持久化展示（`ToolCallCard`）**：不只是转瞬即逝的 loading 提示，而是像 Mastra
      Playground 一样挂在消息气泡上的可展开小卡片（工具名/状态图标/参数/结果），对话结束后还留在
      聊天记录里，重新打开历史会话也能看到。`ChatMessage` 加了 `toolCalls` 字段，实时流里按
      `tool-call`→`tool-result`/`tool-error` 更新卡片状态（`running`→`done`/`error`），历史消息
      从 `listMessages()` 返回的 `content.parts` 里的 `tool-invocation` part 还原（`normalize.ts`
      的 `extractToolCalls`）。历史消息统一按 `done` 展示——存储层面无法干净区分调用是否成功
      （见下方"实现中发现的问题"）

## 5. 收尾

- [x] 基础样式：照着 `ui/contextual_flow/DESIGN.md` 的设计 token 用 Tailwind v4 的 `@theme`
      实现了（颜色/间距/圆角/字号跟设计稿一一对应）
- [x] `customer-frontend/README.md` 写好了
- [x] 跟根目录 `npm run setup` 脚本对齐：加了 `npm install --workspace=customer-frontend`
      （`customer-qdrant` 没有依赖，本来就不需要 install，不是遗漏）

---

## 实现中发现的问题（供后续参考）

- `mastraClient.listMemoryThreads()` 返回的不是裸数组，是 `{ threads, total, page, perPage, hasMore }`，
  一开始按数组假设写的代码不会报错但会静默显示空列表——写了个独立 node 脚本直接调 SDK 验证返回结构，
  发现后修正了 `useSessions.ts`
- `thread.update()` 的 `title`/`metadata`/`resourceId` 三个字段在当前装的 SDK 版本里都是必填
  （官方文档写的是都可选，可能是文档滞后于实际类型定义），`renameSession` 里补了 `metadata: {}`
  和 `resourceId`
- **懒创建流程的竞态 bug**（实测复现：待创建态发第一条消息，界面上什么都不显示）——原来的实现是
  `createMemoryThread()` 一成功就立刻 `navigate()` 跳转，但这时候 `generate()` 还没跑完；路由一跳，
  `ChatPanel` 被整个卸载重挂载，新实例挂载时去拉 `thread.listMessages()`，后端这时候还没来得及把
  这轮消息存进新 thread，拉到的是空历史，而旧实例（乐观显示了用户消息的那个）已经被卸载，它后续
  的 `setMessages` 更新不到任何人在看的界面上。修复：把 `onThreadCreated()` 跳转的时机挪到
  `generate()` 完整拿到回复、消息已经落进本地状态之后，见 `useChat.ts`
- **侧边栏不会自动同步新会话**（实测反馈：新建会话后侧边栏要等整页刷新才显示）——
  `SessionSidebar` 和 `ChatPanel` 原本各自独立调用 `useSessions()`，互不相通；`SessionSidebar`
  按设计是常驻不重新挂载的组件，只在 `AppLayout` 首次挂载时拉过一次列表，之后 `ChatPanel` 那边
  新建了会话，没有任何机制通知它。修复：把 `useSessions()` 提升到 `SessionsContext`
  （`AppLayout` 里 `<SessionsProvider>` 包一层），`SessionSidebar` 和 `ChatPanel` 共用同一份状态，
  `ChatPanel` 在 `onThreadCreated` 里主动调 `refresh()` 通知侧边栏
- **流式事件字段**：`chunk.type === 'tool-call'` 对应 `chunk.payload.toolName` / `payload.args`，
  `'text-delta'` 对应 `chunk.payload.text`——这个是照装的这版 SDK 自带文档
  （`node_modules/@mastra/client-js/dist/docs/references/reference-client-js-agents.md`）
  写的，并且用独立脚本对着真实后端分别测过 `knowledgeRagTool` 和 `logisticsLookupTool`
  两种工具名，两个都精确匹配上了，不是纯猜的
- 验证流式功能时遇到过一次 `mastra dev` 进程直接崩溃退出（起流式请求时，本地模型服务
  `customer-http-demo` 没提前启动，上游连不上）——重新干净起一遍环境后没再复现，先记一笔，
  如果以后还遇到"流式请求把 mastra dev 拖崩"的情况，从这个角度排查
- **`tool-result` / `tool-error` 的完整 payload 结构**（实测样本）：
  `tool-result.payload = { toolCallId, toolName, args, result }`，`result` 就是工具
  `execute()` 的原始返回值（比如 knowledgeRagTool 是 `{relevantContext, sources}`）；
  `tool-error.payload = { toolCallId, toolName, args, error }`，`error` 是嵌套结构
  （`error.cause.message` / `error.details.errorMessage` 常见），封装成了
  `normalize.ts` 里的 `extractToolErrorMessage()`
- **历史消息里工具调用成功/失败无法干净区分**：`listMessages()` 返回的
  `content.parts` 里，`tool-invocation` part 不管当时调用是成功还是失败，`state` 字段
  都是固定的 `"result"`，失败时 `result` 字段直接是错误信息字符串（比如
  `"fetch failed"`）——存储层面没有单独的"失败"状态。所以 `extractToolCalls()` 里
  历史消息统一按 `status: "done"` 处理，只有当前这次实时流式对话才能准确展示
  `running`/`error` 这些中间态

## 明确不做（避免范围蔓延）

- 不做登录/鉴权系统（resourceId 用浏览器生成的匿名 UUID + Cookie 顶上，见第 0 节）
- 不做多 agent 切换，就针对 `customer-service-agent`
- 不做消息编辑/重新生成这类高级会话操作，只做增删改查 + 基础问答

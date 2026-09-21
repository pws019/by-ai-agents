# 进度记录

更新：2026-09-20。当前里程碑：**M0（基线、契约与开发环境）**。

## 1. 任务状态与验证证据

| 任务 | 状态 | 验证证据 |
|---|---|---|
| T-01 基线盘点 | 完成 | 见 §2，全部结论来自本次命令输出 |
| T-02 契约 | 完成 | `cd contracts/education && npm test`：`redocly lint` 有效（0 error，8 warning 为 tag-description 等文档性提示）；`validate.mjs` 16 项 PASS：8 条事件正例通过、4 条反例被拒（tool.status 泄露参数、replay.card 带播放地址、未知事件类型、completed 缺 messageId）、3 条 4xx 错误样例（AC-005 STALE_CONFIRMATION、AC-022 INVALID_STATE、AC-008 REVISION_CONFLICT）符合 ErrorResponse |
| T-03 数据服务 | 完成 | `docker compose --env-file .env -f compose.yaml up -d --wait` 三服务 healthy；写入后 `down`（不带 -v）→ `up`，容器 StartedAt 改变而 Postgres 表/Neo4j 节点/Qdrant collection 数据保留（探针数据已清理）；宿主直连 5433/6335/7474 成功；`.env` 被 .gitignore，未入库 |
| T-04 LangGraph spike | 完成 | `cd education-agent && uv run pytest -q`：3 passed。核心用例真实起 uvicorn 子进程，interrupt 后 `kill -9`，重启后同一 task id `GET` 仍停在 confirm 且中断在，`resume` 后 outcome=executed；`spike_log` 顺序为 draft、confirm:enter、confirm:enter、confirm:resumed、finalize（draft 不重跑，confirm 节点从头重跑）。另：对已结束任务 resume→409，未知任务→404；checkpoint 表只在 `agent_checkpoint` schema（public 无）。版本：Python 3.13.13、langgraph 1.2.11、langgraph-checkpoint-postgres 3.1.2、fastapi 0.141.1、psycopg 3.3.6、uvicorn 0.53.0（`uv.lock` 锁定）。mock：无模型，工具为固定函数 |
| T-05 workspace 脚本 | 未开始 | — |

## 2. T-01 基线盘点

### 2.1 git 状态
- 分支 main，工作区仅 `specs/` 未跟踪（本规格目录）。无用户未提交的业务代码改动。
- 全部改动限定在新增目录，不修改 legacy 模块。

### 2.2 现有模块与运行方式（legacy 基线）

| 模块 | 技术 | 运行 | 处理 |
|---|---|---|---|
| customer-agents | Mastra（@mastra/core 1.51、memory、qdrant、rag）；`mastra.db` 已被 .gitignore | `mastra dev`，默认 4111 | **保留**作基线，不再扩展 |
| customer-frontend | React 19 + Vite + `@mastra/client-js` | `vite` | **复用 UI**；5 个文件直接依赖 `mastraClient`：`lib/mastra-client.ts`、`hooks/useChat.ts`、`hooks/useSessions.ts`、`components/chat/ChatPanel.tsx`、`lib/constants.ts`(AGENT_ID/BASE_URL)。T-21 替换为 HTTP/SSE 适配 |
| customer-logistics-api | Hono + @hono/node-server，`tsx watch` | 端口 8200 | **保留**；作为 Hono 写法参考，教育 API 新建 `education-api/` |
| customer-http-demo | Python/uvicorn 本地推理 | 端口 8123，需 venv | 保留（真实模型模式可复用） |
| customer-embedding-demo | Python 嵌入服务 | 需 venv | **复用**作 Embedding 服务 |
| customer-qdrant | 启动脚本；`docker-compose.qdrant.yml` 用 6333/6334，`latest` 镜像 | `node scripts/dev.mjs` | 复用 Qdrant；教育 Compose 自带固定版本 |
| customer-service-qlora | LLaMA-Factory 配置、mock 预测 | 云训练 | 保留，T-36 新增 `education/` |
| rag-knowledge / data | 电商维修知识、SFT 数据 | — | 保留；教育数据放 `data/education/` |

根 `package.json` workspaces 为 6 个 legacy 包；`npm run dev` = `turbo run dev` 会同时拉起全部 legacy 服务（含大模型）——T-05 必须改为显式区分。

### 2.3 环境事实
- Docker 29.5 可用，当前无运行容器。
- **宿主 5432 已被本机 Postgres 占用** → 教育 Compose 的 Postgres 映射到 5433，避免冲突。
- 系统 `python3` 为 3.9.6；已装 `uv`、python3.10/3.13/3.14 → education-agent 用 uv + 3.13（T-04 时按 LangGraph 锁定版本要求最终确认）。
- Node v26.3.0，npm 11.16。
- 无 AGENTS.md、`.codex/`；README.md 存在。

### 2.4 迁移/保留清单
- **保留不动**：所有 legacy 目录、`docs/`、`data/*` 现有文件。
- **新增**：`contracts/education/`、`infra/education/`、`education-api/`、`education-agent/`、`data/education/`、`evals/education/`。
- **待替换（后续任务）**：前端对 Mastra SDK 的依赖（T-21）；`npm run dev` 默认行为（T-05）。
- **规格与现状不一致**：`design.md §1` 写"没有 .codex/CODEX.md"，与现状一致；无需修正。规格文件名实际为 `CLAUDE-HANDOFF.md`（大写），文档内引用均为该名，无影响。

## 3. 设计决定与规格变更
| 日期 | 决定 | 理由 |
|---|---|---|
| 2026-09-20 | 教育 Compose 的 Postgres 用宿主端口 5433 | 宿主 5432 已占用 |
| 2026-09-20 | 教育 Qdrant 映射宿主 6335（容器内 6333） | legacy customer-qdrant 使用 6333/6334，避免两套同时运行时冲突 |
| 2026-09-20 | Compose 镜像固定版本：postgres 17.6-alpine、neo4j 5.26.10-community、qdrant v1.15.5 | 规格要求锁依赖；legacy 用 `latest` 不可复现 |
| 2026-09-20 | checkpoint 与业务表同一 Postgres 实例、不同 schema（`app`、`agent_checkpoint`） | 符合 design §3；初始化 SQL 在 `infra/education/postgres-init/` |
| 2026-09-20 | openapi lint 关闭 operation-summary 与 operation-4xx-response | operationId 已是稳定标识；不为凑规则虚构 4xx |
| 2026-09-20 | contracts/education 暂为独立 npm 包（未入根 workspaces） | T-05 统一决定 workspace 接入；契约校验与业务包解耦 |

### 已踩坑（T-03，记录供 L-00/L-07 复盘）
- Neo4j 镜像把所有 `NEO4J_*` 环境变量当配置解析；给容器加 `NEO4J_PASSWORD` 会因未知设置启动失败。healthcheck 需要的密码用非 `NEO4J_` 前缀名。
- 第一次"重启验证"因 zsh 未拆词 `$C` 命令根本没执行；读回数据不构成证据，已用容器 StartedAt 变化重做。教训：验证要有"发生过"的证据。
- `lsof` 显示 5433 由 `ssh` 监听是 Colima 端口转发，非冲突。

### T-04 设计决定与踩坑
| 决定 | 理由 |
|---|---|
| checkpointer 用 `AsyncPostgresSaver` + `AsyncConnectionPool`，连接参数 `options=-c search_path=agent_checkpoint` | 库无 schema 参数，表建在 search_path 首个 schema；换成"给每个表加前缀"更脆弱 |
| 连接参数需 `autocommit=True, prepare_threshold=0, row_factory=dict_row` | 沿用库自带 `from_conn_string` 的设置；自建连接池时必须自己带上 |
| 依赖用 uv + `uv.lock`，Python 3.13.13 | 3.13 满足 langgraph 要求，运行正常 |
| spike 用固定函数作"工具"，无模型 | T-04 只验证持久化与恢复，模型接入在 T-18 |
| `spike_log` 表临时放在 `agent_checkpoint` | 仅 spike 观测用，M3 前删除 |

### 已知局限
- 校验只覆盖契约自身一致性与样例；尚无从 openapi 生成 TS/Python 类型（T-06+ 引入时补），当前消费方需手工对照。
- mock/real 目前只有 `.env.example` 中的 `EDUCATION_MODE` 占位，尚无代码消费。

## 4. 学习表

| L 编号 | 对应 T/AC 实现状态 | 学习状态 | 学习者证据 | 待解决问题/下次练习 |
|---|---|---|---|---|
| L-00 | T-04 已实现 | 练习中（讲明白部分基本通过，独立练习进行中） | 题1通过：答出重跑会重复创建、写操作须幂等；已补 Idempotency-Key/写入放 interrupt 之后。题2大体对，已纠正：HTTP 断开不等于任务失败；checkpoint 存图执行状态而非业务事实源。读代码后三问：①按 thread_id 查 checkpoint、search_path 只选 schema（通过）；②内存存储重启后丢状态（通过，补：重启后 GET 会 404、多 worker 也会失败）；③初答"从中断节点开始跑"，讲明白全文回答后纠正三处：①async 漏了阻塞调用卡事件循环，"服务边界"应答职责边界；②"工具"混入了 LangGraph，应为模型提议、后端执行的函数；③"请求抵达后断开不影响"过于绝对，异步框架下协程可能被取消，是否可恢复取决于状态是否落库（未实测，练习中验证）。此前已纠正为"已完成节点不重跑、被中断节点从第一行整体重跑，interrupt 第二次直接返回 resume 值" | — |
| L-01 | 待实施 | 未开始 | — | — |
| L-02 | 待实施 | 未开始 | — | — |
| L-03 | 待实施 | 未开始 | — | — |
| L-04 | 待实施 | 未开始 | — | — |
| L-05 | 待实施 | 未开始 | — | — |
| L-06 | 待实施 | 未开始 | — | — |
| L-07 | 待实施 | 未开始 | — | — |
| L-08 | 待实施 | 未开始 | — | — |

### 理解检查题（M0 · T-02，已完成）
1. `POST /applications/{id}/confirm` 为什么必须带 `confirmationId` 和 `expectedRevision`？只带 `applicationId` 会出什么问题？（对应 AC-005）
2. `replay.card` 事件为什么不带播放地址，而是让前端再调 `/replays/{segmentId}/access`？

状态：
- 第 1 题：通过（含补答）。学习者答出"用户同意的版本与最终执行版本可能不一致"，并指出 confirmationId 是服务端下发的一次性凭证、只有 expectedRevision 则任何人可构造确认。已纠正：修改草稿是同一 applicationId 的 revision+1 而非新建申请；已补充：confirmationId 还绑定 payloadHash/过期，防"用户没看过就被确认"（AC-017 提示注入）。补答：旧卡 409 时前端透出错误并重新获取最新状态；已补充边界：必须让用户重新查看并主动确认，不可自动确认新卡。
- 第 2 题：通过。学习者答出转班撤销权益后的越权风险，以及地址被复制转发的泄露风险。已补充：事件会被持久化，故授权须推迟到点击时；仅点击时检查不足以防转发，还需短期地址或受控播放路由（T-28 时比较两种做法）。
L-00 独立练习在 T-04 后开始。

### 申请状态机讲解记录（M0 后补充，属 M2/L-02 预习，不计入 L-02 独立通过）
- 学员答对：拒绝方案回 submitted 且不执行；退费批准后不能说"已到账"。
- 首次答偏：并发撤回/批准误以为靠 confirmationId；讲解后复述正确（靠 expectedRevision + 当前状态 + 事务锁，恰好一个成功、另一个 409）。
- 待 L-02 独立练习：复现并发审批并预测结果，定位保护机制。图与笔记在 idea-field「教育学员服务 Agent 学习讨论」。

## 5. 用时与下次入口
- 实现用时：M0 进行中；M0 完成后按实测重估排期。学习用时：尚无。
- 下次入口：T-05（workspace 启动脚本，区分 legacy/education 模式），完成后 M0 收尾与重估。L-00 独立练习待做。

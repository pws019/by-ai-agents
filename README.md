# by-ai-agents

电商智能客服 Demo：Qwen3-8B QLoRA 微调 + Mastra Agent + Qwen3 embedding RAG +
mock 订单/物流接口，用 [Turborepo](https://turborepo.com/) 管理运行时子项目。

## 子项目

| 目录 | 技术栈 | 作用 |
|---|---|---|
| `customer-agents` | TypeScript / Mastra | 客服 Agent，负责决策工具调用、组织回复 |
| `customer-embedding-demo` | Python / FastAPI + sentence-transformers | Qwen3-Embedding-0.6B 向量服务，提供 `/embed` |
| `customer-http-demo` | Python / FastAPI + transformers + peft | Qwen3-8B + LoRA 的 HTTP 服务，提供 OpenAI 兼容的 `/v1/chat/completions` |
| `customer-qdrant` | Node.js + Docker Compose | Qdrant 向量数据库生命周期包装，随 `npm run dev` 启停 |
| `customer-logistics-api` | TypeScript / Hono | mock 订单/物流查询接口，给 `logisticsLookupTool` 用 |

`customer-service-qlora` 是训练这个模型用的 LLaMA-Factory 配置和产物，不属于运行时服务，
不在 Turborepo 的 workspace 里。

## 首次使用

```bash
npm run setup
```

依次做这几件事：
1. `npm install --workspace=customer-agents`
2. `customer-embedding-demo` 创建/更新 Python venv 并 `pip install -r requirements.txt`
3. `customer-http-demo` 创建/更新 Python venv 并 `pip install -r requirements.txt`
4. `npm install --workspace=customer-logistics-api`
5. 临时启动 Qdrant 和 embedding 服务，把 `rag-knowledge/*.md` 入库，完成后关闭临时服务

注意：两个 Python 服务默认需要本机有 `python3.11`（可用 `PYTHON_BIN` 环境变量指定别的
解释器路径）。

`customer-embedding-demo` 默认使用仓库里的本地模型目录
`customer-service-qlora/_local_infer/models/Qwen3-Embedding-0.6B`。如果要换成其他目录，
用 `EMBEDDING_MODEL_PATH` 覆盖。

`customer-http-demo` 需要提前把 Qwen3-8B 基座模型和训练好的 LoRA adapter 放到
`customer-http-demo/config.py` 里配置的默认路径（或用环境变量 `BASE_MODEL_PATH` /
`ADAPTER_PATH` 覆盖）。

## 日常开发

```bash
npm run dev
```

用 `turbo run dev` 同时拉起运行时服务（Mastra Studio `:4111`、Qdrant `:6333`、
customer-embedding-demo `:8080`、customer-http-demo `:8123`、customer-logistics-api `:8200`），
日志按服务分别打前缀。**Ctrl+C 会把服务一起停掉**
（这是 turbo 对 persistent 任务的内置行为，不需要自己写脚本去 kill 三个进程）。

`customer-qdrant` 会在 dev 启动时执行 `docker compose -f docker-compose.qdrant.yml up -d`，
并在收到 Ctrl+C / SIGTERM 时执行 `docker compose -f docker-compose.qdrant.yml down`。

## RAG 入库

`npm run setup` 会自动执行一次入库。后续如果只改了 `rag-knowledge/*.md`，可以在服务已启动时
单独重建知识库：

```bash
npm run rag:ingest
```

入库完成后，`customer-agents` 的 `knowledgeRagTool` 会把用户问题发送到
`customer-embedding-demo` 转成向量，再去 Qdrant 检索维修知识片段。

## 为什么这么分工

- Turborepo 本身不负责装依赖，`npm install`/`pip install` 该谁的活还是谁的活；
  Turborepo 只负责编排"跑什么脚本、并发跑、统一生命周期管理"这件事，`setup`
  是普通的 npm script 顺序执行三步安装，`dev` 才是真正用 turbo 编排的地方。
- `customer-embedding-demo` 和 `customer-http-demo` 都是 Python 项目，但各自有一个只有
  `scripts` 字段、没有真实 npm 依赖的 `package.json`，纯粹是为了让它们能作为 npm
  workspace 成员被 turbo 统一编排 `dev` 生命周期，实际依赖还是走 `requirements.txt` + venv。

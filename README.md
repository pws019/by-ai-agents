# by-ai-agents

电商智能客服 Demo：Qwen3-8B QLoRA 微调 + Mastra Agent + mock 订单/物流接口，用
[Turborepo](https://turborepo.com/) 管理三个子项目。

## 子项目

| 目录 | 技术栈 | 作用 |
|---|---|---|
| `customer-agents` | TypeScript / Mastra | 客服 Agent，负责决策工具调用、组织回复 |
| `customer-http-demo` | Python / FastAPI + transformers + peft | Qwen3-8B + LoRA 的 HTTP 服务，提供 OpenAI 兼容的 `/v1/chat/completions` |
| `customer-logistics-api` | TypeScript / Hono | mock 订单/物流查询接口，给 `logisticsLookupTool` 用 |

`customer-service-qlora` 是训练这个模型用的 LLaMA-Factory 配置和产物，不属于运行时服务，
不在 Turborepo 的 workspace 里。

## 首次使用

```bash
npm run setup
```

依次做这几件事：
1. `npm install --workspace=customer-agents`
2. `customer-http-demo` 创建/更新 Python venv 并 `pip install -r requirements.txt`
3. `npm install --workspace=customer-logistics-api`

注意：`customer-http-demo` 需要本机有 `python3.11`（可用 `PYTHON_BIN` 环境变量指定别的
解释器路径），并且需要提前把 Qwen3-8B 基座模型和训练好的 LoRA adapter 放到
`customer-http-demo/config.py` 里配置的默认路径（或用环境变量 `BASE_MODEL_PATH` /
`ADAPTER_PATH` 覆盖）。

## 日常开发

```bash
npm run dev
```

用 `turbo run dev` 同时拉起三个服务（Mastra Studio `:4111`、customer-http-demo `:8123`、
customer-logistics-api `:8200`），日志按服务分别打前缀。**Ctrl+C 会把三个服务一起停掉**
（这是 turbo 对 persistent 任务的内置行为，不需要自己写脚本去 kill 三个进程）。

## 为什么这么分工

- Turborepo 本身不负责装依赖，`npm install`/`pip install` 该谁的活还是谁的活；
  Turborepo 只负责编排"跑什么脚本、并发跑、统一生命周期管理"这件事，`setup`
  是普通的 npm script 顺序执行三步安装，`dev` 才是真正用 turbo 编排的地方。
- `customer-http-demo` 是 Python 项目，但给它加了一个只有 `scripts` 字段、没有真实
  npm 依赖的 `package.json`，纯粹是为了让它能作为 npm workspace 成员被 turbo 统一编排
  `dev` 生命周期，实际依赖还是走 `requirements.txt` + venv。

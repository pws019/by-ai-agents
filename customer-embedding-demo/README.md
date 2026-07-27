# customer-embedding-demo

本服务是一个本地 Qwen3 embedding Demo，负责把文本转换成向量，供 RAG 入库和检索使用。

默认模型：

```text
Qwen/Qwen3-Embedding-0.6B
```

默认端口：

```text
http://127.0.0.1:8080
```

## 它在项目里的位置

```text
rag-knowledge/*.md
  -> customer-agents/src/scripts/ingest-rag-knowledge.ts
  -> customer-embedding-demo /embed
  -> Qdrant

用户问题
  -> customer-agents knowledgeRagTool
  -> customer-embedding-demo /embed
  -> Qdrant search
  -> Agent 基于检索结果回答
```

## 安装

```bash
npm run setup --workspace=customer-embedding-demo
```

第一次启动时，如果本地缓存没有模型，`sentence-transformers` 会下载模型。

生产或云主机部署建议提前下载模型，并配置：

```bash
export EMBEDDING_MODEL_PATH=/models/Qwen3-Embedding-0.6B
```

## 启动

```bash
npm run dev --workspace=customer-embedding-demo
```

健康检查：

```bash
curl http://127.0.0.1:8080/health
```

TEI 风格 embedding 接口：

```bash
curl http://127.0.0.1:8080/embed \
  -H "Content-Type: application/json" \
  -d '{"inputs":["冰箱冷藏室积水怎么办？"]}'
```

OpenAI-compatible 接口：

```bash
curl http://127.0.0.1:8080/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen3-Embedding-0.6B","input":["冰箱冷藏室积水怎么办？"]}'
```

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `EMBEDDING_MODEL_PATH` | `Qwen/Qwen3-Embedding-0.6B` | 模型名或本地模型目录 |
| `EMBEDDING_MODEL_ID` | `Qwen/Qwen3-Embedding-0.6B` | OpenAI-compatible 响应里的模型名 |
| `EMBEDDING_DEVICE` | 自动选择 | 可设为 `cuda`、`mps`、`cpu` |
| `EMBEDDING_PORT` | `8080` | 服务端口 |
| `EMBEDDING_MAX_LENGTH` | `8192` | 最大输入长度 |
| `EMBEDDING_NORMALIZE` | `true` | 是否归一化向量 |


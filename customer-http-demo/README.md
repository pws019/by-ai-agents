使用fast-api+pytorch进行qlora接口封装

大概逻辑
![alt text](image.png)
![alt text](image-1.png)

## 实现说明

已按上面的思路实现（基座模型 + LoRA adapter，用 transformers + peft 加载，FastAPI 包一层
`/health` + `/chat` 接口）。默认路径指向本项目里已经下载/训练好的产物：

- `BASE_MODEL_PATH` 默认：`customer-service-qlora/_local_infer/models/Qwen3-8B`
- `ADAPTER_PATH` 默认：`customer-service-qlora/saves/qwen3-8b-qlora-sft-v1-bf16`

都可以用同名环境变量覆盖。设备自动探测（cuda > mps > cpu），本机 Apple Silicon 会用 mps。

## 运行

```bash
cd customer-http-demo
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

uvicorn main:app --host 127.0.0.1 --port 8123
```

## 接口

```bash
# 健康检查
curl http://127.0.0.1:8123/health

# 自定义对话接口
curl -X POST http://127.0.0.1:8123/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "我的快递到哪了？"}'

# OpenAI Chat Completions 兼容接口（给 customer-agents / Mastra 用）
curl -X POST http://127.0.0.1:8123/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "local-qwen3-8b-lora", "messages": [{"role": "user", "content": "我的快递到哪了？"}], "stream": false}'
```

`ChatRequest` 字段：`message`（必填）、`system`（可选，覆盖默认 system prompt）、
`max_new_tokens`、`temperature`（默认 0，贪婪解码）、`top_p`。`ChatResponse` 返回 `reply` 和 `model_id`。

`/v1/chat/completions` 字段名严格照抄 OpenAI 协议（`messages`/`max_tokens`/`temperature`/
`top_p`/`stream`），支持非流式（一次性 JSON）和流式（SSE，`data: {...}\n\n` 格式，用
`TextIteratorStreamer` 做真正的逐 token 流式输出，不是攒完整句再假装流式）。

**为什么默认 temperature 是 0**：这版模型训练时故意让同一类问题的回复收敛成统一模板，
用带随机采样的 temperature（比如默认的 0.7）偶尔会采样到低概率的乱码 token（实测出现过
中文场景里蹦出一个俄文词），跟"话术收敛"的训练目标是矛盾的。默认贪婪解码（temperature=0）
消除了这个风险，调用方仍然可以显式传更高的 temperature 主动要随机性。

已本地验证过 B（物流未提供订单号）、D（库存/价格/退款进度）、E（离题拒答）三类场景，
覆盖 `/chat`、`/v1/chat/completions` 非流式、流式，以及通过 `customer-agents`（Mastra agent）
端到端调用，回复都符合训练时的模板化话术。
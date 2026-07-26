# ☎️ 电商客服 AI 系统架构设计文档

> 版本：1.0 | 日期：2026-05-31

---

## 一、项目概述

本项目是一套面向电商场景的**本地化智能客服 AI 系统**，以双 RTX 4090 GPU 为算力底座，融合大模型 QLoRA 微调、RAG 知识库检索（含 Rerank）与实时 API 工具调用，构建出一个专业、克制、可控的客服智能体。系统全程本地部署，无云服务依赖，数据不出内网。

### 核心能力矩阵

| 能力 | 实现方式 | 状态 |
|------|---------|------|
| 客服语气与格式控制 | QLoRA 微调 + System Prompt | 已上线 |
| 商品说明 / 售后政策检索 | RAG + Rerank | 已上线 |
| 物流实时查询 | Tool Call → Logistics API | 已上线 |
| 拒答与安全边界 | 双层 Prompt + 微调数据 | 已上线 |
| 多轮对话记忆 | Mastra Agent 上下文管理 | 规划中 |
| 退款 / 库存实时查询 | 扩展 Tool Call | 规划中 |

---

## 二、硬件平台与算力规划

### 2.1 当前硬件配置

```
CPU  : AMD Ryzen 9 7950X — 16 核 32 线程
GPU  : NVIDIA RTX 4090 × 2 — 单卡 24GB GDDR6X，合计 48GB 显存
RAM  : 32GB DDR5
CUDA : 12.x
OS   : Windows 11 Pro
```

### 2.2 双 4090 显存分配策略

双卡合计 48GB 显存是本系统算力规划的核心优势。根据模型规格，有两种使用模式：

#### 模式 A：单卡推理 + 单卡备用（当前默认）

```
GPU 0 (24GB)                          GPU 1 (24GB)
┌────────────────────────────┐         ┌────────────────────────────┐
│  Qwen3-8B (4-bit NF4)      │         │  Qwen3-Embedding-0.6B      │
│  ~8–10 GB                  │         │  ~1.2 GB                   │
│                            │         │                            │
│  LoRA Adapter              │         │  预留 / 扩展用途            │
│  ~0.3 GB                   │         │  (未来可跑 Reranker 模型)   │
│                            │         │                            │
│  KV Cache + 激活值          │         │                            │
│  ~4–6 GB                   │         │                            │
│                            │         │                            │
│  可用余量：~8 GB            │         │  可用余量：~23 GB           │
└────────────────────────────┘         └────────────────────────────┘
```

#### 模式 B：双卡张量并行（升级 14B/32B 时启用）

```
GPU 0 (24GB)                          GPU 1 (24GB)
┌────────────────────────────┐         ┌────────────────────────────┐
│  Qwen3-14B (4-bit NF4)     │   NVLink / PCIe                      │
│  层 0–19（前半段）          │◄────────►│  层 20–39（后半段）        │
│  ~12 GB                    │         │  ~12 GB                    │
│                            │         │                            │
│  LoRA Adapter（前半段）     │         │  LoRA Adapter（后半段）    │
│  KV Cache 分片              │         │  KV Cache 分片             │
└────────────────────────────┘         └────────────────────────────┘

启用命令（vLLM）:
  CUDA_VISIBLE_DEVICES=0,1 vllm serve Qwen3-14B \
    --tensor-parallel-size 2 \
    --quantization bitsandbytes \
    --load-format bitsandbytes

启用命令（LLaMA-Factory 推理）:
  --device_map auto   # 自动跨卡分层
```

### 2.3 各模型规格与显存占用对照

| 模型 | 精度 | 量化 | 单卡显存 | 双卡方案 | 推荐场景 |
|------|------|------|---------|---------|---------|
| Qwen3-4B | BF16 | NF4 | ~4 GB | 无需双卡 | 快速验证 |
| Qwen3-8B | BF16 | NF4 | ~8–10 GB | 单卡即可 | **当前生产** |
| Qwen3-14B | BF16 | NF4 | ~14–16 GB | 单卡即可 | 下一阶段升级 |
| Qwen3-32B | BF16 | NF4 | ~20–22 GB | 单卡勉强 | 谨慎评估 |
| Qwen3-72B | BF16 | NF4 | ~42 GB | **必须双卡** | 未来规划 |
| Embedding-0.6B | FP16 | 无 | ~1.2 GB | — | 当前生产 |

---

## 三、4-Bit NF4 量化技术详解

### 3.1 量化原理

4-bit NF4（NormalFloat 4）是 QLoRA 论文提出的专为正态分布权重设计的量化格式，相比普通 INT4 在语言模型权重分布上有更低的量化误差。

```
原始权重 (BF16, 2 bytes/param)
         │
         ▼
┌─────────────────────────────────────────┐
│  NF4 量化流程                            │
│                                         │
│  1. 按 block_size=64 分块               │
│  2. 计算每块的绝对最大值作为缩放因子     │
│  3. 将权重归一化到 [-1, 1]              │
│  4. 映射到 16 个 NF4 码字（4 bits）     │
│  5. 缩放因子以 FP8 存储（双重量化）     │
└─────────────────────────────────────────┘
         │
         ▼
量化权重 (NF4, 0.5 bytes/param)
显存节省：约 75%

计算时反量化回 BF16 执行前向传播（compute_dtype=bfloat16）
```

### 3.2 QLoRA 配置参数

```python
# BitsAndBytesConfig（量化配置）
bnb_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",          # NormalFloat4，比 fp4 精度更高
    bnb_4bit_compute_dtype=torch.bfloat16,  # 计算时反量化到 BF16
    bnb_4bit_use_double_quant=True,     # 双重量化：对缩放因子再量化，额外节省 ~0.4 GB
)

# LoRA 配置
lora_config = LoraConfig(
    r=16,                               # 秩：越大表达能力越强，显存占用越多
    lora_alpha=32,                      # 缩放系数，通常为 r 的 2 倍
    lora_dropout=0.05,
    bias="none",
    task_type="CAUSAL_LM",
    target_modules=[                    # 注入 LoRA 的模块
        "q_proj", "k_proj",            # Attention Query/Key
        "v_proj", "o_proj",            # Attention Value/Output
        "gate_proj", "up_proj",        # FFN Gate/Up
        "down_proj"                    # FFN Down
    ]
)
```

### 3.3 QLoRA 训练参数（Qwen3-8B 双卡优化版）

```yaml
# LLaMA-Factory 训练配置
model_name_or_path: D:/models/modelscope/Qwen/Qwen3-8B
finetuning_type: lora
quantization_bit: 4
quantization_type: nf4
double_quantization: true
compute_dtype: bfloat16

# 双卡训练（DeepSpeed ZeRO-2 或 DDP）
deepspeed: examples/deepspeed/ds_z2_config.json
# 或直接 device_map: auto 自动分配

lora_rank: 16
lora_alpha: 32
lora_dropout: 0.05
lora_target: q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj

# 训练超参
max_seq_length: 2048
per_device_train_batch_size: 2   # 双卡时每卡 2，等效 batch=4
gradient_accumulation_steps: 8  # 等效全局 batch=32
learning_rate: 2.0e-4
num_train_epochs: 3
warmup_ratio: 0.03
lr_scheduler_type: cosine
bf16: true

# 保存策略
save_strategy: steps
save_steps: 100
eval_strategy: steps
eval_steps: 100
output_dir: saves/qwen3-8b/customer-service/lora/mock-sft
```

### 3.4 参数量对比

| | 基座模型 | QLoRA 训练时 | 推理时 |
|---|---|---|---|
| 总参数量 | 8B | 8B + ~20M LoRA | 8B (frozen) + 20M |
| 可训练参数 | — | ~20M（仅 LoRA） | — |
| 显存占用 | 16 GB (BF16) | ~12 GB (NF4) | ~10 GB (NF4) |
| 显存节省 | — | ~62% | ~37% |

---

## 四、系统整体架构

### 4.1 架构全景图

```
                        ┌─────────────────────────────────┐
                        │         用户 / 前端接入           │
                        │    HTTP POST /agent/stream        │
                        └────────────────┬────────────────┘
                                         │
                        ┌────────────────▼────────────────┐
                        │     Mastra Agent Service          │
                        │      Node.js + TypeScript         │
                        │      http://127.0.0.1:4111        │
                        │                                   │
                        │  ┌─────────────────────────────┐ │
                        │  │  customer-service-agent      │ │
                        │  │  ├─ 意图识别                 │ │
                        │  │  ├─ 工具路由决策             │ │
                        │  │  ├─ 多轮上下文管理           │ │
                        │  │  └─ 回复组织                 │ │
                        │  └──────────┬──────────────────┘ │
                        └────────────┬┴──────────┬─────────┘
                                     │           │
              ┌──────────────────────┘           └────────────────────────┐
              │  Tool: knowledgeRagTool                Tool: logisticsLookupTool
              │                                                            │
 ┌────────────▼────────────────────────────┐      ┌────────────────────────▼────┐
 │         RAG Pipeline                    │      │  Logistics Mock API          │
 │                                         │      │  Fastify + TypeScript        │
 │  1. embedMany(queryText)                │      │  http://127.0.0.1:7001       │
 │     → POST /v1/embeddings               │      │                              │
 │                                         │      │  GET /orders/:id/logistics   │
 │  2. Qdrant.query(topK=topK×5)           │      │  ├─ YD202605300001 运输中    │
 │     余弦相似度召回候选集                 │      │  ├─ YD202605300002 异常      │
 │                                         │      │  └─ YD202605300003 已签收    │
 │  3. rerank(candidates, queryText)       │      └─────────────────────────────┘
 │     语义 0.5 + 向量 0.3 + 位置 0.2     │
 │                                         │
 │  4. 返回 topK 精排结果                  │
 └────────────┬────────────────────────────┘
              │ /v1/embeddings
              │ /v1/chat/completions
 ┌────────────▼────────────────────────────────────────────────────────────────┐
 │                    Local Model Service（FastAPI + Python）                   │
 │                           http://127.0.0.1:8000                             │
 │                                                                              │
 │   GPU 0 (24GB)                              GPU 1 (24GB)                    │
 │  ┌──────────────────────────┐              ┌──────────────────────────┐     │
 │  │  Qwen3-8B (NF4, ~10 GB) │              │  Qwen3-Embedding-0.6B    │     │
 │  │  + LoRA Adapter          │              │  (~1.2 GB)               │     │
 │  │                          │              │                          │     │
 │  │  /v1/chat/completions    │              │  /v1/embeddings          │     │
 │  │  /chat (简化接口)        │              │  mean_pool + L2 norm     │     │
 │  └──────────────────────────┘              └──────────────────────────┘     │
 │                                                                              │
 │   双层 System Prompt │ 工具路由逻辑 │ 工具结果处理 │ OpenAI 兼容协议         │
 └────────────┬────────────────────────────────────────────────────────────────┘
              │
 ┌────────────▼────────────────────────────┐
 │         Qdrant Vector Database           │
 │         http://127.0.0.1:6333            │
 │                                          │
 │  Index: yd_knowledge                     │
 │  Metric: cosine  Dim: 768               │
 │                                          │
 │  8 份知识库文档（已切分为向量块）          │
 │  ├─ 显示器选购与规格                      │
 │  ├─ 显示器故障排查                        │
 │  ├─ 冰箱选购与使用                        │
 │  ├─ 冰箱故障排查                          │
 │  ├─ 电商售后政策                          │
 │  ├─ 配送安装签收                          │
 │  ├─ 产品保养与安全                        │
 │  └─ 客服话术与规范                        │
 └──────────────────────────────────────────┘
```

### 4.2 四层架构设计理念

```
┌──────────────────────────────────────────────────────────────────┐
│  层 1：业务规则层                                                  │
│  载体：System Prompt + LoRA Adapter                               │
│  职责：客服身份、语气风格、回复格式、拒答边界                       │
│  特点：离线训练，推理零额外成本                                    │
├──────────────────────────────────────────────────────────────────┤
│  层 2：智能感知层                                                  │
│  载体：Mastra Agent + 工具注册                                    │
│  职责：意图识别、工具路由、多轮上下文                              │
│  特点：无状态工具调用，逻辑可测试                                  │
├──────────────────────────────────────────────────────────────────┤
│  层 3：知识与数据层                                                │
│  载体：Qdrant 向量库 + Logistics Mock API                         │
│  职责：事实知识检索、实时状态查询                                  │
│  特点：数据与模型解耦，知识可独立更新                              │
├──────────────────────────────────────────────────────────────────┤
│  层 4：推理执行层                                                  │
│  载体：Qwen3-8B (NF4) + LoRA + FastAPI                           │
│  职责：语言理解、文本生成、嵌入计算                               │
│  特点：双 4090 本地运行，延迟可控，数据不出内网                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 五、RAG 管道详解

### 5.1 知识摄取流程（离线）

```
rag-knowledge/*.md
        │
        ▼
MDocument.fromMarkdown()          ← @mastra/rag
        │
        ▼
.chunk({                          ← 文档切分
  strategy: "markdown",
  maxSize: 800,                   ← 每块最多 800 字符
  overlap: 120,                   ← 相邻块重叠 120 字符
  stripWhitespace: true
})
        │
        ▼
embedMany(chunks)                 ← POST /v1/embeddings
  → Qwen3-Embedding-0.6B
  → 768 维向量
        │
        ▼
QdrantVector.upsert({
  indexName: "yd_knowledge",
  vectors: embeddings,
  metadata: {
    text,          ← 原始文本
    source,        ← 来源文件路径
    title,         ← 文档标题
    domain,        ← 领域（monitor / refrigerator / after_sales / ...）
    file
  }
})
```

### 5.2 在线检索流程（含 Rerank）

```typescript
// knowledge.ts — execute 函数核心逻辑

// Step 1: 查询向量化
const { embeddings } = await embedMany({
  model: knowledgeEmbeddingModel,   // Qwen3-Embedding-0.6B
  values: [queryText]               // 用户问题
});
// → embeddings[0]: number[768]

// Step 2: 向量召回（放大 5 倍）
const candidates = await knowledgeVectorStore.query({
  indexName: "yd_knowledge",
  queryVector: embeddings[0],
  topK: topK * 5,                   // 默认 topK=4，此处召回 20 条
  includeVector: false
});
// → candidates: Array<{ id, score, metadata }>，按 cosine 排序

// Step 3: Rerank 精排
const results = await rerank(candidates, queryText, knowledgeEmbeddingModel, {
  topK,                             // 精选回 4 条
  weights: {
    semantic: 0.5,                  // query 与 chunk 的语义相似度（主导）
    vector:   0.3,                  // Qdrant 的 cosine 分数
    position: 0.2                   // 原始排名位置（靠前轻微加分）
  }
});
// → results: 重排后的 top-4，score 为综合得分
```

### 5.3 Rerank 得分计算原理

```
综合得分 = semantic_score × 0.5
         + vector_score   × 0.3
         + position_score × 0.2

其中：
  semantic_score = cosine_sim(embed(queryText), embed(chunk.text))
                   使用同一 embedding 模型重新计算
  vector_score   = Qdrant 返回的原始 cosine 相似度
  position_score = 1 - (rank / total_candidates)
                   第 1 名 = 1.0，第 20 名 ≈ 0.05
```

**Rerank 解决的核心问题**：当多个知识块的向量相似度相近时（如"退换货流程"与"质保规则"对于"用了一个月有质量问题能换吗"的查询），Rerank 通过语义精排将真正相关的块推到首位。

### 5.4 知识库文档清单

| 文件 | 领域标签 | 主要内容 |
|------|---------|---------|
| monitor-selection-and-specs.md | monitor | 尺寸、分辨率、刷新率、接口、HDR |
| monitor-troubleshooting.md | monitor | 无信号、坏点、清洁、驱动问题 |
| refrigerator-selection-and-use.md | refrigerator | 容量、风冷直冷、安装、首次通电静置 |
| refrigerator-troubleshooting.md | refrigerator | 不制冷、除霜、除味、噪音、漏电 |
| ecommerce-after-sales-policy.md | after_sales | 七天无理由、质量问题、DOA、运费归属 |
| delivery-installation-and-signoff.md | delivery | 签收规范、验货、安装流程 |
| product-care-and-safety.md | safety | 清洁、用电安全、长期存储 |
| customer-service-response-playbook.md | playbook | 回复结构、话术规范、拒答边界 |

---

## 六、微调数据与训练流程

### 6.1 训练数据结构

```json
{
  "messages": [
    {
      "role": "system",
      "content": "你是专业、耐心、克制的电商客服。回答要先安抚，再确认问题，再给出可执行步骤。不能编造订单、库存、物流信息。"
    },
    {
      "role": "user",
      "content": "我的快递怎么还没到？"
    },
    {
      "role": "assistant",
      "content": "您好，我理解您着急收货的心情。为了帮您准确查询物流进度，请您提供订单号或收件手机号后四位。我查询到具体物流节点后，会告诉您当前状态和预计处理方式。"
    }
  ]
}
```

### 6.2 数据覆盖场景

| 类别 | 典型问题 | 训练目标 |
|------|---------|---------|
| 物流咨询 | 快递没到 / 物流不更新 / 签收异常 | 主动索要订单号，不编造状态 |
| 退款问题 | 退款未到账 / 只退了部分 | 说明平台时效，不承诺具体时间 |
| 退换货 | 七天无理由 / 拆封能退吗 | 引导提供凭证，按政策说明 |
| 质量问题 | 一个月后坏了 / 到货即损坏 | 区分 DOA 与质保，给出申请路径 |
| 商品咨询 | 显示器规格 / 冰箱用法 | 从知识库引用，不猜测参数 |
| 发票问题 | 能开专票吗 / 抬头写错了 | 说明申请流程和限制 |
| 拒答边界 | 非客服话题 / 要求编造信息 | 友好拒绝，明确能力边界 |

### 6.3 双卡训练加速方案

```
方案一：DeepSpeed ZeRO-2（推荐）
  ds_z2_config.json
  - 优化器状态分片到双卡
  - 梯度聚合后更新
  - 显存节省约 40%，通信开销小
  - 命令：deepspeed --num_gpus=2 train.py

方案二：PyTorch DDP（简单）
  - 每卡完整模型副本
  - 梯度 all-reduce 同步
  - 适合 batch size 小的场景
  - 命令：torchrun --nproc_per_node=2 train.py

方案三：device_map=auto（懒人方案）
  - Transformers 自动跨卡分层
  - 适合模型超出单卡显存时
  - 不支持标准 DDP，只用于推理
```

### 6.4 当前 LoRA Checkpoint 清单

| 路径 | 基座 | 用途 |
|------|------|------|
| saves/qwen3-8b/customer-service/lora/mock-sft | Qwen3-8B | **当前生产用** |
| saves/qwen3-8b/customer-service/lora/sft | Qwen3-8B | 备选 |
| saves/qwen3-4b/customer-service/lora/smoke | Qwen3-4B | 演示验证用 |

---

## 七、服务层详解

### 7.1 Local Model Service（FastAPI）

**核心端点：**

```
POST /v1/chat/completions   ← OpenAI 兼容，Mastra Agent 调用
POST /v1/embeddings         ← 供 RAG 工具生成查询向量
POST /chat                  ← 简化接口，前端 / 脚本直接调用
GET  /v1/models             ← 模型列表
GET  /health                ← 健康检查（含 CUDA 状态、模型加载状态）
```

**双层 System Prompt 架构：**

```
服务端兜底（Python 层）
└─ 角色定义、拒答规则、不编造实时信息

Agent 端指令（TypeScript 层，更细化）
└─ 工具调用时机、回复结构、情绪安抚要求
```

两层互为补充：Agent 层优先生效，服务端层兜底防止 Agent 漏传指令时退化。

**工具路由三层决策：**

```
1. 正则快速匹配（最快，毫秒级）
   └─ 订单号 + 物流关键词 → logisticsLookupTool
   └─ 商品/售后关键词 → knowledgeRagTool

2. Base Model 推理判断（最准，~200ms）
   └─ 无 LoRA 的基座模型扮演"路由器"
   └─ 输出 JSON：{ needTool, toolName, toolArgs }

3. 二次 Fallback（兜底）
   └─ 如果推理结果为空或格式错误，重走正则
```

### 7.2 Mastra Agent Service（Node.js）

**Agent 定义摘要：**

```typescript
const customerServiceAgent = new Agent({
  id: "customer-service-agent",
  model: localModel.chatModel("local-qwen3-8b-lora"),
  tools: {
    knowledgeRagTool,       // RAG 检索（含 Rerank）
    logisticsLookupTool     // 物流查询
  },
  instructions: [
    // 工具调用时机
    // 回复格式要求：承接 → 确认 → 处理 → 下一步
    // 拒答规则
  ]
});
```

**标准回复结构（通过微调强化）：**

```
第一句：承接情绪或确认问题
  "您好，我理解您现在比较着急。"

第二句：说明需要的信息 / 查询结果
  "我已为您查到：订单 ... 由顺丰承运，当前状态为..."

第三句：明确下一步处理方式
  "预计 ... 前送达，如超时未更新我再帮您催查。"

第四句（视情况）：转人工条件
  "如需人工处理，我可以帮您转接。"
```

### 7.3 Logistics Mock API（Fastify）

```typescript
// 三条测试订单，覆盖核心状态
YD202605300001 → in_transit    // 正常运输中
YD202605300002 → exception     // 地址异常
YD202605300003 → delivered     // 已签收
```

返回结构包含：`orderId`、`trackingNo`、`carrier`、`status`、`latestNode`、`estimatedDelivery`、`receiverMaskedPhone`、`timeline[]`

---

## 八、请求完整链路追踪

### 链路 A：物流查询

```
用户："我的订单 YD202605300001 快递怎么还没到？"
   │
   ▼
Mastra Agent 接收
   │ 检测到订单号 + 物流关键词
   ▼
调用 logisticsLookupTool({ orderId: "YD202605300001" })
   │
   ▼
HTTP GET http://127.0.0.1:7001/orders/YD202605300001/logistics
   │
   ▼ 返回：{ status: "in_transit", latestNode: "上海分拨中心", ... }
   │
   ▼
POST http://127.0.0.1:8000/v1/chat/completions
  messages: [system, user原文, tool结果]
   │
   ▼ Qwen3-8B + LoRA 生成回复
   │
   ▼
"您好，我已查到：订单 YD202605300001 由顺丰承运，
 当前在上海分拨中心，预计 2026-06-01 18:00 前送达..."
```

### 链路 B：知识库检索

```
用户："冰箱买回来要静置多久？"
   │
   ▼
Mastra Agent 接收
   │ 检测到商品类关键词
   ▼
调用 knowledgeRagTool({ queryText: "冰箱买回来要静置多久？", topK: 4 })
   │
   ├─ embedMany → POST /v1/embeddings → 768 维向量
   │
   ├─ Qdrant.query(topK=20) → 余弦召回 20 个候选块
   │
   └─ rerank(20条, queryText) → 语义精排 → 返回 top-4
          semantic:0.5  vector:0.3  position:0.2
   │
   ▼ relevantContext[0].text: "新买的冰箱到货后应静置 2-4 小时..."
   │
   ▼
POST http://127.0.0.1:8000/v1/chat/completions
  messages: [system, user原文, RAG检索结果]
   │
   ▼
"您好，新买的冰箱到货后需要静置 2-4 小时，
 如运输中有倾斜可延长至 4-6 小时，之后再通电..."
```

---

## 九、服务编排与启动

### 9.1 服务依赖顺序

```
Qdrant (6333)
    ↓
Local Model Service (8000)
    ↓
Logistics Mock API (7001)
    ↓
Mastra Agent (4111)
```

### 9.2 启动方式

```powershell
# 一键启动所有服务
cd yd-ai-cs
.\start-all.ps1

# 单独启动 Qdrant
.\start-qdrant.ps1

# 知识库重新摄取（数据更新时执行）
cd mastra-agent
npm run ingest:knowledge
```

### 9.3 健康检查

```powershell
curl http://127.0.0.1:6333/healthz     # Qdrant
curl http://127.0.0.1:8000/health      # Local Model Service
curl http://127.0.0.1:7001/health      # Logistics API
```

### 9.4 日志位置

```
yd-ai-cs/.runtime/
├─ qdrant.out.log / qdrant.err.log
├─ local-model-service.out.log / .err.log
├─ logistics-mock-api.out.log / .err.log
└─ mastra-agent.out.log / .err.log
```

---

## 十、技术选型总结

| 组件 | 选型 | 核心理由 |
|------|------|---------|
| 基座模型 | Qwen3-8B-Instruct | 中文理解强，8B 在单张 4090 上 NF4 量化后显存充裕 |
| 量化方案 | 4-bit NF4 + 双重量化 | 相比 BF16 节省 75% 显存，精度损失极小 |
| 微调框架 | LLaMA-Factory + QLoRA | 双卡训练支持完善，配置简单 |
| Agent 框架 | Mastra | TypeScript 生态，工具注册与调用语法简洁 |
| 向量库 | Qdrant | 性能稳定，支持 metadata 过滤，本地二进制易部署 |
| 嵌入模型 | Qwen3-Embedding-0.6B | 轻量（1.2 GB），768 维，与主模型同源语义空间 |
| Rerank | @mastra/rag 内置 | 复用 embedding 模型，零额外模型下载，开箱即用 |
| 推理服务 | FastAPI + OpenAI 兼容协议 | Mastra 的 openai-compatible provider 直接对接 |
| 物流服务 | Fastify + TypeScript | 轻量高性能，Mock 数据覆盖三种典型物流状态 |

---

## 十一、演进路线图

### 第一阶段（当前）：单卡验证 ✅

- Qwen3-8B + NF4，单张 4090
- RAG（含 Rerank）+ 物流 Tool Call
- 微调数据 ~500-1000 条
- 本地 Mock 数据闭环

### 第二阶段：提质扩容

- 升级至 Qwen3-14B，仍单卡，NF4 约 16 GB
- 扩充微调数据至 5000-10000 条
- 接入真实订单 / 退款状态 API
- 知识库扩充：更多品类、更多场景

### 第三阶段：双卡大模型

- 启用 Qwen3-32B，双卡张量并行
- 引入独立 cross-encoder Reranker（BAAI/bge-reranker-v2-m3，部署在 GPU 1）
- 混合搜索（向量 + BM25 关键词）
- 多轮记忆与对话历史管理

### 第四阶段：生产化

- Docker 容器化 + docker-compose 一键启动
- Web 聊天前端 + 人工接管按钮
- A/B 评测框架 + 用户反馈闭环
- 监控告警（推理延迟、工具调用失败率、RAG 召回质量）

---

## 附录：核心文件索引

| 文件 | 作用 |
|------|------|
| [yd-ai-cs/mastra-agent/src/mastra/rag/knowledge.ts](yd-ai-cs/mastra-agent/src/mastra/rag/knowledge.ts) | RAG 工具核心实现（含 Rerank） |
| [yd-ai-cs/mastra-agent/src/mastra/agents/customer-service-agent.ts](yd-ai-cs/mastra-agent/src/mastra/agents/customer-service-agent.ts) | Agent 定义与指令 |
| [yd-ai-cs/mastra-agent/src/mastra/tools/logistics-lookup.ts](yd-ai-cs/mastra-agent/src/mastra/tools/logistics-lookup.ts) | 物流查询工具 |
| [yd-ai-cs/mastra-agent/src/scripts/ingest-knowledge.ts](yd-ai-cs/mastra-agent/src/scripts/ingest-knowledge.ts) | 知识库摄取脚本 |
| [yd-ai-cs/logistics-mock-api/src/server.ts](yd-ai-cs/logistics-mock-api/src/server.ts) | 物流 Mock API 服务 |
| LLaMA-Factory/saves/qwen3-8b/.../mock-sft | 当前生产用 LoRA Adapter |
| yd-ai-cs/rag-knowledge/*.md | 8 份知识库源文档 |
| yd-ai-cs/start-all.ps1 | 一键启动脚本 |

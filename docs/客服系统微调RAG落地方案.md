# 客服系统微调 + 量化 + RAG 落地方案

生成时间：2026-05-30

## 1. 当前电脑配置结论

已验证配置：

```text
CPU: AMD Ryzen 9 7950X 16-Core Processor
GPU: NVIDIA GeForce RTX 4090
显存: 24GB
NVIDIA Driver: 596.36
CUDA Driver Capability: CUDA 13.2
当前可用内存: 约 13GB
```

既有记录中的配置：

```text
RAM: 32GB
Disk: C / D 盘空间充足
```

当前软件状态：

```text
python: 当前 PATH 未发现
pip: 当前 PATH 未发现
conda: 当前 PATH 未发现
git: 当前 PATH 未发现
nvcc: 当前 PATH 未发现
ollama: 当前 PATH 未发现
```

结论：

```text
硬件适合本地 QLoRA 微调。
软件环境需要先安装或加入 PATH。
```

## 2. 推荐模式选择

第一阶段推荐：

```text
基座模型: Qwen3-8B-Instruct
训练方式: QLoRA
量化方式: 4bit NF4
训练目标: 客服语气、回复结构、流程判断、拒答边界
知识来源: RAG 知识库
实时数据: API / 工具调用
部署方式: 本地推理服务 + HTTP API
```

第二阶段推荐：

```text
基座模型: Qwen3-14B-Instruct
训练方式: QLoRA
使用场景: 第一版客服流程跑通后，追求更强理解和更稳输出
```

暂不建议：

```text
一开始训练 24B / 27B / 32B dense 模型。
```

原因：

```text
RTX 4090 24GB 跑 8B QLoRA 很舒服。
14B QLoRA 可行，但环境和数据没跑通前不建议直接上。
32B dense 在本机显存和内存上会很吃紧，调试成本高。
```

## 3. 系统架构

```text
用户问题
  -> 前端客服窗口
  -> 后端 API
  -> 意图判断
  -> RAG 检索产品 / FAQ / 售后政策 / 话术知识
  -> 必要时调用订单 / 库存 / 物流 / 退款 API
  -> Qwen Instruct + QLoRA Adapter 生成回复
  -> 返回前端
```

分工：

```text
Prompt: 身份、规则、边界
QLoRA: 固化客服语气、格式、处理流程
RAG: 产品知识、政策、FAQ、文档事实
API: 订单、物流、库存、退款等实时信息
```

核心原则：

```text
LoRA 管“怎么答”
RAG 管“答什么事实”
API 管“实时状态”
Prompt 管“规则边界”
```

## 4. 微调数据设计

训练数据不要塞大量产品知识，主要训练“客服风格与流程”。

建议 JSONL 格式：

```json
{"messages":[{"role":"system","content":"你是专业、耐心、克制的电商客服。回答要先安抚，再确认问题，再给出可执行步骤。不能编造订单、库存、物流信息。"},{"role":"user","content":"我的快递怎么还没到？"},{"role":"assistant","content":"您好，我理解您着急收货的心情。为了帮您准确查询物流进度，请您提供订单号或收件手机号后四位。我查询到具体物流节点后，会告诉您当前状态和预计处理方式。"}]}
```

数据类别：

```text
售前咨询: 产品介绍、规格对比、适用场景
售后咨询: 退换货、维修、保修、发票
订单问题: 催发货、改地址、物流异常
退款问题: 退款进度、退款失败、部分退款
投诉安抚: 情绪安抚、升级人工、补偿边界
拒答边界: 没有依据不乱答，涉及隐私先验证身份
RAG 引用: 根据检索资料回答，不知道就说明需核实
```

第一批数据规模：

```text
最低可跑通: 100 - 300 条
初版可用: 1000 - 3000 条
更稳定: 5000 - 10000 条
```

## 5. 训练参数建议

Qwen3-8B-Instruct + QLoRA 建议：

```text
load_in_4bit: true
bnb_4bit_quant_type: nf4
bnb_4bit_compute_dtype: bfloat16
lora_r: 16
lora_alpha: 32
lora_dropout: 0.05
target_modules: q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj
max_seq_length: 2048 或 4096
batch_size_per_device: 1
gradient_accumulation_steps: 8 或 16
learning_rate: 2e-4
epochs: 2 - 3
warmup_ratio: 0.03
lr_scheduler: cosine
save_strategy: steps
```

如果显存压力大：

```text
max_seq_length 降到 2048
batch_size_per_device 保持 1
开启 gradient_checkpointing
减少同时运行的浏览器、游戏、视频软件
```

## 6. RAG 知识库设计

推荐第一版使用：

```text
向量库: Chroma 或 FAISS
Embedding: bge-m3 或 bge-large-zh-v1.5
文档切分: 300 - 800 中文字一块
重叠: 50 - 100 字
召回数量: top_k = 3 - 5
重排: 第二阶段再加 reranker
```

知识库内容：

```text
产品说明书
FAQ
售后政策
退换货规则
物流说明
发票规则
客服禁语
人工升级标准
```

RAG 回答规则：

```text
只根据检索到的资料回答事实。
资料没有写的，不要编造。
涉及订单、库存、物流、退款进度时，必须调用业务 API 或提示用户提供信息。
回答中可以给出简短依据，但不要暴露内部向量检索细节。
```

## 7. 客服语气规范

目标语气：

```text
专业
耐心
简洁
有安抚
不油腻
不夸大承诺
不给无依据结论
```

推荐回复结构：

```text
1. 先承接情绪或确认问题
2. 再说明需要的信息或当前依据
3. 给出明确处理步骤
4. 告知下一步结果或人工升级条件
```

示例：

```text
您好，我理解您现在比较着急。为了帮您准确处理，我需要先确认一下订单信息。
请您提供订单号或收件手机号后四位，我查询后会告诉您当前状态以及下一步处理方式。
```

## 8. 开发阶段安排

第 1 步：安装基础环境

```text
安装 Git
安装 Miniconda 或 Python 3.10/3.11
安装 PyTorch CUDA 版本
安装 transformers / datasets / peft / trl / bitsandbytes / accelerate
```

第 2 步：跑通最小训练

```text
准备 20 条客服 JSONL
加载 Qwen3-8B-Instruct
跑 10 - 50 step
确认 loss 能下降
保存 LoRA adapter
```

第 3 步：扩展训练数据

```text
整理 1000 条左右高质量客服对话
拆分 train / eval
固定 system prompt
统一拒答和人工升级标准
```

第 4 步：正式 QLoRA 微调

```text
训练 2 - 3 epoch
保存 adapter
用测试集评估格式、语气、边界、幻觉
必要时补数据再训
```

第 5 步：搭 RAG

```text
整理产品/售后/FAQ 文档
切分文档
生成 embedding
写入向量库
后端接口接入检索结果
```

第 6 步：客服系统后端

```text
FastAPI 提供 /chat 接口
接收用户消息
调用 RAG
拼接 system prompt + 检索上下文 + 用户问题
调用本地模型生成
返回客服回复
```

第 7 步：前端客服窗口

```text
聊天窗口
会话列表
人工接管按钮
订单号输入
消息状态
```

## 9. 第一版验收标准

```text
能本地启动模型
能加载 LoRA adapter
能接收用户问题
能检索知识库
能按客服语气回答
遇到未知事实不编造
遇到订单/物流/退款实时问题不乱答
能通过 HTTP API 给前端调用
```

## 10. 下一步行动

下一步应该先做环境：

```text
1. 安装或定位 Python / Conda
2. 安装 Git
3. 创建 conda 环境 yd-qlora
4. 安装 PyTorch 和训练依赖
5. 准备最小 JSONL 数据
6. 跑通 Qwen3-8B QLoRA 最小训练
```

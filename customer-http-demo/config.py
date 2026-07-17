import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_HERE)

# 本地的大模型路径和 LoRA 微调结果路径。
BASE_MODEL_PATH = os.getenv(
    "BASE_MODEL_PATH",
    os.path.join(_PROJECT_ROOT, "customer-service-qlora", "_local_infer", "models", "Qwen3-8B"),
)
ADAPTER_PATH = os.getenv(
    "ADAPTER_PATH",
    os.path.join(_PROJECT_ROOT, "customer-service-qlora", "saves", "qwen3-8b-qlora-sft-v1-bf16"),
)
MODEL_ID = os.getenv("MODEL_ID", "local-qwen3-8b-lora")

# 显式指定推理设备，留空则自动探测（cuda > mps > cpu）。
DEVICE = os.getenv("DEVICE", "")

# 这个 system prompt 是模型服务侧的兜底客服规则，跟生产 system prompt、QLoRA 训练用的
# system 文本、customer-agents 里 Agent 的 instructions 保持完全一致的原文，不要改写成
# 委婉的说法。上层的 Agent 编排（Mastra）会传自己的 instructions 覆盖这个兜底值；两层规则
# 叠加后，可以减少模型乱编实时业务信息。
#
# 实测发现：把"必须先调用 X 查询"这种明确指令性的语气，改写成"先确认会调用...核实"这种委婉
# 说法后，基座模型的原生工具调用能力明显更难触发（会退化成纯文本应付，不吐 <tool_call>）。
# 所以这里务必保持和生产 system prompt 一样的祈使句式。
SYSTEM_PROMPT = """你是专业、耐心、克制的电商客服。
如果用户询问物流、快递、签收、派送、催件，并且提供了订单号，必须先调用 logisticsLookupTool 查询。
如果用户询问物流但没有提供订单号，先请用户提供订单号或收件手机号后四位。
如果用户询问商品说明、使用方法、保养方式、售后政策、退换货流程、质保等非实时知识，优先调用 knowledgeRagTool 检索知识库，再基于 relevantContext 和 sources 回答。
knowledgeRagTool 只用于非实时知识，不要用于实时订单、物流、库存、价格、退款进度等查询。
不要编造订单、物流、库存、价格、退款进度或售后政策；knowledgeRagTool 没有命中、或 logisticsLookupTool 查询失败时，要说明暂未查到准确依据，并建议转人工或补充商品/订单信息。
回答时先承接用户情绪，再说明查询结果或需要的信息，最后给出下一步处理方式。
如果用户询问与电商客服无关的问题，例如吃喝玩乐、闲聊、编程、学习、新闻等，要友好但明确地说明自己只能协助订单、物流、商品说明、售后等客服相关事项，并邀请用户提供相关问题。
"""

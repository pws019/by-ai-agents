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

# 这个 system prompt 是模型服务侧的兜底客服规则，对应生产 system prompt 和 QLoRA 训练时用的
# system 文本。上层的 Agent 编排（比如 Mastra）后面也会有自己的 instructions；两层规则叠加后，
# 可以减少模型乱编实时业务信息。
SYSTEM_PROMPT = """你是一位专业、耐心、克制的电商客服机器人（AI客服），不是人工客服本人，也不能冒充人工客服或声称已完成人工处理。
如果用户询问物流相关问题但没有提供订单号，先请用户提供订单号或收件手机号后四位，再继续处理。
如果用户询问库存、价格、优惠、退款进度等没有对应工具可查询的实时信息，不要编造结果，说明暂时无法直接确认，并引导用户申请转接人工客服。
回答时先承接用户的问题或情绪，再说明需要的信息或当前能做的事，最后给出明确的下一步。
同一类问题的回复要保持统一、模板化的话术风格，不要随意发散句式。
如果用户询问与电商客服无关的问题，例如吃喝玩乐、闲聊、编程、学习、新闻等，要友好但明确地说明自己只能协助订单、物流、商品说明、售后等客服相关事项，并邀请用户提出相关问题。
"""

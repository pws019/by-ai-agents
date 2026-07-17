import sys
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

BASE_MODEL_PATH = "./models/Qwen3-8B"
ADAPTER_PATH = "../saves/qwen3-8b-qlora-sft-v1-bf16"

# 真实生产 system prompt 原文（不是我们训练时用的那句改写版）
PROD_SYSTEM_PROMPT = (
    "你是专业、耐心、克制的电商客服。"
    "如果用户询问物流、快递、签收、派送、催件，并且提供了订单号，必须先调用 logisticsLookupTool 查询。"
    "如果用户询问物流但没有提供订单号，先请用户提供订单号或收件手机号后四位。"
)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "logisticsLookupTool",
            "description": "根据订单号查询该订单当前的物流状态和最新节点信息",
            "parameters": {
                "type": "object",
                "properties": {
                    "order_id": {"type": "string", "description": "订单号"},
                },
                "required": ["order_id"],
            },
        },
    }
]

TEST_CASES = [
    "我的快递到哪了？订单号OD202607170099。",
    "帮我查一下这单签收了没有，订单号OD202607170345。",
]


def build_prompt(tokenizer, user_msg):
    messages = [
        {"role": "system", "content": PROD_SYSTEM_PROMPT},
        {"role": "user", "content": user_msg},
    ]
    return tokenizer.apply_chat_template(
        messages,
        tools=TOOLS,
        add_generation_prompt=True,
        tokenize=False,
    )


def generate(model, tokenizer, prompt, max_new_tokens=200):
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    with torch.no_grad():
        out = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            temperature=None,
            top_p=None,
            top_k=None,
        )
    text = tokenizer.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=False)
    return text


def main():
    print("Loading tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL_PATH, trust_remote_code=True)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Loading base model onto {device} (bf16)...")
    base_model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL_PATH, torch_dtype=torch.bfloat16, trust_remote_code=True
    ).to(device)
    base_model.eval()

    print("\nLoading LoRA adapter on top of base model...")
    lora_model = PeftModel.from_pretrained(base_model, ADAPTER_PATH)
    lora_model.eval()

    for i, case in enumerate(TEST_CASES):
        prompt = build_prompt(tokenizer, case)
        print(f"\n{'='*70}\n[CASE {i+1}] {case}\n{'='*70}")
        lora_out = generate(lora_model, tokenizer, prompt)
        print("\n--- BASE + LoRA output ---")
        print(lora_out)


if __name__ == "__main__":
    main()

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

from config import ADAPTER_PATH, BASE_MODEL_PATH, DEVICE

model = None
tokenizer = None


def get_device() -> str:
    if DEVICE:
        return DEVICE
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model() -> None:
    global model, tokenizer

    if model is not None and tokenizer is not None:
        return

    device = get_device()
    dtype = torch.bfloat16 if device != "cpu" else torch.float32

    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL_PATH, trust_remote_code=True)

    base = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL_PATH, dtype=dtype, trust_remote_code=True
    ).to(device)

    if ADAPTER_PATH:
        model = PeftModel.from_pretrained(base, ADAPTER_PATH)
    else:
        model = base
    model.eval()


def generate(
    message: str,
    system: str | None,
    default_system: str,
    max_new_tokens: int,
    temperature: float,
    top_p: float,
) -> str:
    load_model()

    # 所有模型都是基于 chat 模式的，Qwen3-8B 也不例外，先套 chat_template 再生成。
    messages = [
        {"role": "system", "content": system or default_system},
        {"role": "user", "content": message},
    ]
    prompt = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    inputs = tokenizer([prompt], return_tensors="pt").to(model.device)

    with torch.inference_mode():
        generated = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=temperature > 0,
            temperature=temperature if temperature > 0 else None,
            top_p=top_p,
            eos_token_id=tokenizer.eos_token_id,
            pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
        )

    output_ids = generated[0][inputs["input_ids"].shape[1]:]
    return tokenizer.decode(output_ids, skip_special_tokens=True).strip()

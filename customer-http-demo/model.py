import threading
from typing import Iterator

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

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


def _build_inputs(messages: list[dict]):
    # 所有模型都是基于 chat 模式的，Qwen3-8B 也不例外，先套 chat_template 再生成。
    prompt = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    return tokenizer([prompt], return_tensors="pt").to(model.device)


def _generate_kwargs(inputs, max_new_tokens: int, temperature: float, top_p: float) -> dict:
    return dict(
        **inputs,
        max_new_tokens=max_new_tokens,
        do_sample=temperature > 0,
        temperature=temperature if temperature > 0 else None,
        top_p=top_p,
        eos_token_id=tokenizer.eos_token_id,
        pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
    )


def generate(
    messages: list[dict],
    max_new_tokens: int,
    temperature: float,
    top_p: float,
) -> str:
    """一次性生成完整回复（非流式）。"""
    load_model()
    inputs = _build_inputs(messages)

    with torch.inference_mode():
        generated = model.generate(**_generate_kwargs(inputs, max_new_tokens, temperature, top_p))

    output_ids = generated[0][inputs["input_ids"].shape[1] :]
    return tokenizer.decode(output_ids, skip_special_tokens=True).strip()


def generate_stream(
    messages: list[dict],
    max_new_tokens: int,
    temperature: float,
    top_p: float,
) -> Iterator[str]:
    """流式生成，逐个文本片段 yield 出来，供 SSE 使用。"""
    load_model()
    inputs = _build_inputs(messages)

    streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)
    kwargs = _generate_kwargs(inputs, max_new_tokens, temperature, top_p)
    kwargs["streamer"] = streamer

    def _run():
        with torch.inference_mode():
            model.generate(**kwargs)

    thread = threading.Thread(target=_run)
    thread.start()

    for chunk in streamer:
        if chunk:
            yield chunk

    thread.join()

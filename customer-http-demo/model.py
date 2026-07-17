import json
import re
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


def _build_inputs(messages: list[dict], tools: list[dict] | None = None):
    # 所有模型都是基于 chat 模式的，Qwen3-8B 也不例外，先套 chat_template 再生成。
    # tools 透传给 apply_chat_template，让基座模型原生的工具调用能力有机会生效
    # （Qwen3 的模板会在 tools 非空时注入工具定义，并约定 <tool_call>{...}</tool_call> 输出格式）。
    prompt = tokenizer.apply_chat_template(
        messages,
        tools=tools,
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
    tools: list[dict] | None = None,
) -> str:
    """一次性生成完整回复（非流式）。"""
    load_model()
    inputs = _build_inputs(messages, tools)

    with torch.inference_mode():
        generated = model.generate(**_generate_kwargs(inputs, max_new_tokens, temperature, top_p))

    output_ids = generated[0][inputs["input_ids"].shape[1] :]
    return tokenizer.decode(output_ids, skip_special_tokens=True).strip()


def generate_stream(
    messages: list[dict],
    max_new_tokens: int,
    temperature: float,
    top_p: float,
    tools: list[dict] | None = None,
) -> Iterator[str]:
    """流式生成，逐个文本片段 yield 出来，供 SSE 使用。"""
    load_model()
    inputs = _build_inputs(messages, tools)

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


_TOOL_CALL_RE = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL)


def parse_tool_calls(text: str) -> tuple[str, list[dict]]:
    """解析 Qwen 原生的 <tool_call>{...}</tool_call> 输出。

    返回 (去掉 tool_call 标签后剩余的文本, 解析出的工具调用列表)。解析失败的块会被跳过，
    不抛异常——宁可漏检一次工具调用，也不要因为格式不规范让整个请求 500。
    """
    calls: list[dict] = []
    for match in _TOOL_CALL_RE.finditer(text):
        try:
            payload = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        name = payload.get("name")
        if not name:
            continue
        calls.append({"name": name, "arguments": payload.get("arguments", {})})

    remaining = _TOOL_CALL_RE.sub("", text).strip()
    return remaining, calls

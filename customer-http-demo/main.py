import json
import time
import uuid

import torch
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

import model as model_module
from config import ADAPTER_PATH, BASE_MODEL_PATH, MODEL_ID, SYSTEM_PROMPT
from model import generate, generate_stream, get_device, load_model, parse_tool_calls
from schemas import ChatRequest, ChatResponse, OpenAIChatCompletionRequest

app = FastAPI(title="customer-http-demo", description="Qwen3-8B QLoRA 客服模型 HTTP 接口封装")


@app.on_event("startup")
def startup() -> None:
    load_model()


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": model_module.model is not None and model_module.tokenizer is not None,
        "device": get_device(),
        "cuda": torch.cuda.is_available(),
        "mps": torch.backends.mps.is_available(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "base_model": BASE_MODEL_PATH,
        "adapter": ADAPTER_PATH,
        "model_id": MODEL_ID,
    }


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    messages = [
        {"role": "system", "content": req.system or SYSTEM_PROMPT},
        {"role": "user", "content": req.message},
    ]
    reply = generate(
        messages=messages,
        max_new_tokens=req.max_new_tokens,
        temperature=req.temperature,
        top_p=req.top_p,
    )
    return ChatResponse(reply=reply, model_id=MODEL_ID)


def _ensure_system_message(messages: list[dict]) -> list[dict]:
    if any(m["role"] == "system" for m in messages):
        return messages
    return [{"role": "system", "content": SYSTEM_PROMPT}, *messages]


@app.post("/v1/chat/completions")
def chat_completions(req: OpenAIChatCompletionRequest):
    """OpenAI Chat Completions 兼容端点，供 @ai-sdk/openai-compatible（Mastra）调用。"""
    messages = _ensure_system_message(req.messages)
    model_id = req.model or MODEL_ID
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())

    if not req.stream:
        raw_reply = generate(
            messages=messages,
            max_new_tokens=req.max_tokens,
            temperature=req.temperature,
            top_p=req.top_p,
            tools=req.tools,
        )
        content, calls = parse_tool_calls(raw_reply) if req.tools else (raw_reply, [])

        if calls:
            message = {
                "role": "assistant",
                "content": content or None,
                "tool_calls": [
                    {
                        "id": f"call_{uuid.uuid4().hex}",
                        "type": "function",
                        "function": {
                            "name": call["name"],
                            "arguments": json.dumps(call["arguments"], ensure_ascii=False),
                        },
                    }
                    for call in calls
                ],
            }
            finish_reason = "tool_calls"
        else:
            message = {"role": "assistant", "content": content}
            finish_reason = "stop"

        return {
            "id": completion_id,
            "object": "chat.completion",
            "created": created,
            "model": model_id,
            "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    TOOL_CALL_OPEN = "<tool_call>"

    def sse(payload: dict) -> str:
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    def chunk(delta: dict, finish_reason: str | None = None) -> dict:
        return {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_id,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }

    def event_stream():
        yield sse(chunk({"role": "assistant"}))

        # 是否可能是工具调用，在看到足够字符明确排除之前，先按 <tool_call> 的原文前缀缓冲，
        # 不直接把原始 <tool_call>{...}</tool_call> 文本流给客户端。
        buffer = ""
        is_tool_call: bool | None = None

        for piece in generate_stream(
            messages=messages,
            max_new_tokens=req.max_tokens,
            temperature=req.temperature,
            top_p=req.top_p,
            tools=req.tools,
        ):
            if is_tool_call is False:
                yield sse(chunk({"content": piece}))
                continue

            buffer += piece
            if is_tool_call is None:
                if buffer.startswith(TOOL_CALL_OPEN):
                    is_tool_call = True
                elif TOOL_CALL_OPEN.startswith(buffer):
                    continue  # 还是 "<tool_call>" 的合法前缀，再等等
                else:
                    is_tool_call = False
                    yield sse(chunk({"content": buffer}))
                    buffer = ""
            # is_tool_call is True: 继续静默缓冲，等生成结束后一次性解析

        if is_tool_call:
            content, calls = parse_tool_calls(buffer)
            if calls:
                tool_calls_delta = {
                    "tool_calls": [
                        {
                            "index": i,
                            "id": f"call_{uuid.uuid4().hex}",
                            "type": "function",
                            "function": {
                                "name": call["name"],
                                "arguments": json.dumps(call["arguments"], ensure_ascii=False),
                            },
                        }
                        for i, call in enumerate(calls)
                    ]
                }
                yield sse(chunk(tool_calls_delta))
                yield sse(chunk({}, finish_reason="tool_calls"))
            else:
                # 解析失败（格式不规范），退化成普通文本，不要让请求直接失败
                yield sse(chunk({"content": content or buffer}))
                yield sse(chunk({}, finish_reason="stop"))
        else:
            yield sse(chunk({}, finish_reason="stop"))

        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")

import json
import time
import uuid

import torch
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

import model as model_module
from config import ADAPTER_PATH, BASE_MODEL_PATH, MODEL_ID, SYSTEM_PROMPT
from model import generate, generate_stream, get_device, load_model
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
    messages = _ensure_system_message([m.model_dump() for m in req.messages])
    model_id = req.model or MODEL_ID
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())

    if not req.stream:
        reply = generate(
            messages=messages,
            max_new_tokens=req.max_tokens,
            temperature=req.temperature,
            top_p=req.top_p,
        )
        return {
            "id": completion_id,
            "object": "chat.completion",
            "created": created,
            "model": model_id,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": reply},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    def event_stream():
        first_chunk = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_id,
            "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
        }
        yield f"data: {json.dumps(first_chunk, ensure_ascii=False)}\n\n"

        for piece in generate_stream(
            messages=messages,
            max_new_tokens=req.max_tokens,
            temperature=req.temperature,
            top_p=req.top_p,
        ):
            chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model_id,
                "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}],
            }
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

        final_chunk = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_id,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }
        yield f"data: {json.dumps(final_chunk, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")

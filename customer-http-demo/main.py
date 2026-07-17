import torch
from fastapi import FastAPI

import model as model_module
from config import ADAPTER_PATH, BASE_MODEL_PATH, MODEL_ID, SYSTEM_PROMPT
from model import generate, get_device, load_model
from schemas import ChatRequest, ChatResponse

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
    reply = generate(
        message=req.message,
        system=req.system,
        default_system=SYSTEM_PROMPT,
        max_new_tokens=req.max_new_tokens,
        temperature=req.temperature,
        top_p=req.top_p,
    )
    return ChatResponse(reply=reply, model_id=MODEL_ID)

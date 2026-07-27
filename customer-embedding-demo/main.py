import torch
from fastapi import FastAPI

import model as model_module
from config import MAX_LENGTH, MODEL_ID, MODEL_PATH, NORMALIZE_EMBEDDINGS
from model import embed_texts, get_device, load_model
from schemas import EmbedRequest, OpenAIEmbeddingItem, OpenAIEmbeddingRequest, OpenAIEmbeddingResponse

app = FastAPI(
    title="customer-embedding-demo",
    description="Qwen3-Embedding-0.6B 本地向量服务，供 RAG 入库和检索调用",
)


@app.on_event("startup")
def startup() -> None:
    load_model()


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": model_module.model is not None,
        "device": get_device(),
        "cuda": torch.cuda.is_available(),
        "mps": torch.backends.mps.is_available(),
        "model_path": MODEL_PATH,
        "model_id": MODEL_ID,
        "max_length": MAX_LENGTH,
        "normalize_embeddings": NORMALIZE_EMBEDDINGS,
    }


def _as_list(value: str | list[str]) -> list[str]:
    return [value] if isinstance(value, str) else value


@app.post("/embed")
def embed(req: EmbedRequest) -> list[list[float]]:
    """TEI 风格接口。

    customer-agents 里的 embedding-client.ts 默认调用这个端点：
    POST /embed
    { "inputs": ["文本1", "文本2"] }

    返回值直接是二维向量数组，和 TEI 的常用返回格式保持一致。
    """
    return embed_texts(_as_list(req.inputs))


@app.post("/v1/embeddings", response_model=OpenAIEmbeddingResponse)
def openai_embeddings(req: OpenAIEmbeddingRequest) -> OpenAIEmbeddingResponse:
    """OpenAI-compatible embeddings 接口。

    这个端点不是当前默认路径，但保留下来方便你后续把
    EMBEDDING_PROVIDER 改成 openai-compatible 时复用同一个服务。
    """
    embeddings = embed_texts(_as_list(req.input))
    return OpenAIEmbeddingResponse(
        model=req.model or MODEL_ID,
        data=[
            OpenAIEmbeddingItem(index=index, embedding=embedding)
            for index, embedding in enumerate(embeddings)
        ],
    )


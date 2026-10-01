"""real 模式：OpenAI 兼容的 /v1/embeddings 端点（跟 model/langchain_adapter.py 对 chat 端点的
关系一样）。本地默认指向 customer-embedding-demo（Qwen3-Embedding-0.6B，1024 维，见那个
服务的 main.py 里 `POST /v1/embeddings`），不需要 API key；真正接云端 embedding 服务时
MODEL_API_KEY 才会被用上。
"""
import httpx

from .base import Embedder


class OpenAiEmbedder:
    def __init__(self, client: httpx.AsyncClient, model: str, dimension: int):
        self._client = client
        self._model = model
        self.dimension = dimension

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        res = await self._client.post("/v1/embeddings", json={"model": self._model, "input": texts})
        res.raise_for_status()
        data = sorted(res.json()["data"], key=lambda d: d["index"])
        return [d["embedding"] for d in data]


def create_openai_embedder(base_url: str, api_key: str, model: str, dimension: int) -> OpenAiEmbedder:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    client = httpx.AsyncClient(base_url=base_url, headers=headers, timeout=30.0)
    return OpenAiEmbedder(client, model, dimension)

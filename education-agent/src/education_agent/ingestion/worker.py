"""索引 worker 入口：python -m education_agent.ingestion.worker（或未来接入定时任务/管理页面触发）。

项目目前没有真正的调度基础设施（design.md §8：数据库任务/outbox 而非消息中间件），这里只是
"反复调用 run_pending_jobs 直到没有待办任务，然后按间隔再看一眼"，可靠性落在任务表的状态机上，
不落在这个循环本身——这个进程随时可以被杀掉重启，不会丢任务、不会重复生效。
"""
import asyncio
import os

from qdrant_client import AsyncQdrantClient

from ..config import DATABASE_URL, KNOWLEDGE_COLLECTION, QDRANT_URL
from ..embedding.base import Embedder
from ..embedding.mock import MockEmbedder
from ..embedding.openai_embedder import create_openai_embedder
from .pipeline import run_pending_jobs
from .vector_store import VectorStore


def build_embedder(env: dict) -> Embedder:
    """默认直连本地已经在跑的 customer-embedding-demo（Qwen3-Embedding-0.6B，1024 维，
    `npm run dev --workspace=customer-embedding-demo`，见那个服务的 README）——跟 QDRANT_URL
    一样，本地有真实、免费、不需要 key 的服务可用时不强制走 mock。EMBEDDING_* 留空就是这组默认值；
    真的要换成云端 embedding 服务时覆盖即可。EDUCATION_MODE=mock 才换回 MockEmbedder
    （比如本地没装/没起这个服务时）。"""
    if env.get("EDUCATION_MODE", "mock") == "mock":
        return MockEmbedder()
    base_url = env.get("EMBEDDING_BASE_URL") or "http://127.0.0.1:8080"
    model = env.get("EMBEDDING_MODEL") or "Qwen/Qwen3-Embedding-0.6B"
    dimension = int(env.get("EMBEDDING_DIMENSION") or "1024")
    return create_openai_embedder(base_url, env.get("MODEL_API_KEY", ""), model, dimension)


async def run_forever(*, poll_interval_s: float = 5.0) -> None:
    embedder = build_embedder(os.environ)
    store = VectorStore(AsyncQdrantClient(url=QDRANT_URL), KNOWLEDGE_COLLECTION, embedder.dimension)
    await store.ensure_collection()
    print(f"ingestion worker 启动：collection={KNOWLEDGE_COLLECTION} dim={embedder.dimension}")
    while True:
        outcomes = await run_pending_jobs(DATABASE_URL, store, embedder)
        for o in outcomes:
            status = "成功" if o.ok else f"失败: {o.error}"
            print(f"job {o.id} ({o.kind}): {status}")
        if not outcomes:
            await asyncio.sleep(poll_interval_s)


def main() -> None:
    asyncio.run(run_forever())


if __name__ == "__main__":
    main()

"""searchKnowledge 工具背后的检索实现（T-27）：权限过滤、业务状态再核验、无依据的明确报告。

design.md §6 三句话对应这里的三个步骤：
1. "私人检索先从 API 取得有效 cohort/content 范围" → `fetch_cohort_scope`（scope.py）。
2. "在向量/图查询中加筛选；……查询范围必须显式生成，空权限不能退化为查询所有数据" →
   `_build_filter`：永远显式构造 should 条件（public 可见 或 cohortId 在范围内），
   范围为空集时这条件就是"谁都不匹配"，不是省略过滤器。
3. "最终引用再次核验……查询校验业务 activeVersion，未激活或撤回片段不可返回" →
   `_verify_still_active`：Qdrant 里的候选不保证是当前激活版本（T-26 的撤回是立即生效，
   但物理清理是异步的），这一步用 Postgres 的业务状态把过期候选挡掉，是真正兜底的一关。

AC-018 要的"无依据不编造"落在 `SearchResult.has_evidence`：score_threshold 过滤 + 权限过滤 +
业务再核验三关都可能让候选清空，清空就是清空，不拿不相关的片段凑数。
"""
from dataclasses import dataclass

from qdrant_client import models

from ..embedding.base import Embedder
from ..ingestion import db as ingestion_db
from ..ingestion.vector_store import VectorStore
from ..tools.client import BusinessApi
from .scope import fetch_cohort_scope

TOP_K = 5
# 粗粒度阈值：向量检索总会返回"最接近"的几条，哪怕全都不相关。低于这个相似度就认为
# "没有真的匹配上"，交给 AC-018 的无依据路径，而不是把八竿子打不着的片段当成答案。
# 用本地真实 embedding 服务（Qwen3-Embedding-0.6B）实测过短查询 vs 不相关长文本的余弦相似度
# 落在 0.14～0.33 之间、真正相关的落在 0.8+，0.5 留了足够余量，不是拍脑袋的数字。
MIN_SCORE = 0.5


@dataclass(frozen=True)
class Citation:
    lesson_id: str
    content: str
    start_ms: int | None
    end_ms: int | None


@dataclass(frozen=True)
class SearchResult:
    citations: tuple[Citation, ...]

    @property
    def has_evidence(self) -> bool:
        return len(self.citations) > 0


def _build_filter(allowed_cohort_ids: set[str]) -> models.Filter:
    return models.Filter(
        should=[
            models.FieldCondition(key="visibility", match=models.MatchValue(value="public")),
            models.FieldCondition(key="cohortId", match=models.MatchAny(any=sorted(allowed_cohort_ids))),
        ]
    )


async def _verify_still_active(dsn: str, hits: list) -> list:
    documents = await ingestion_db.fetch_documents(dsn, list({h.document_id for h in hits}))
    return [
        h for h in hits
        if (d := documents.get(h.document_id)) is not None and d.activated_at is not None and d.version == h.document_version
    ]


async def search_knowledge(
    *, embedder: Embedder, store: VectorStore, dsn: str, api: BusinessApi, query: str, top_k: int = TOP_K
) -> SearchResult:
    allowed_cohort_ids = await fetch_cohort_scope(api)

    [vector] = await embedder.embed([query])
    hits = await store.search(
        vector, limit=top_k, score_threshold=MIN_SCORE, query_filter=_build_filter(allowed_cohort_ids)
    )
    hits = await _verify_still_active(dsn, hits)

    return SearchResult(tuple(Citation(h.lesson_id, h.content, h.start_ms, h.end_ms) for h in hits))

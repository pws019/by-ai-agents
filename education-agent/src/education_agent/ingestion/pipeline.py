"""索引任务编排（T-26）："构建新版本索引 → 检查完成 → 激活版本"（design.md §6）。

三件事分开来看：
- `run_index_job`：只负责"建索引"和"检查完成"，不激活——索引成功不等于对外可见，
  激活是独立的、明确的动作（老师发布），不是索引一成功就自动生效。
- `activate_document` / `withdraw_document`（db.py）：业务状态的翻转，立即生效，
  不等待任何物理清理。
- `run_pending_jobs`：失败重跑的入口，索引和清理共用同一张任务表、同一套领取逻辑。

一个任务（无论 index 还是 cleanup）失败只记录到 knowledge_index_jobs，不向上抛异常——
失败重跑是预期中的正常状态，不是需要让调用方整个崩溃的程序错误。
"""
from dataclasses import dataclass

from ..embedding.base import Embedder
from . import db
from .vector_store import SegmentPoint, VectorStore


@dataclass(frozen=True)
class JobOutcome:
    job_id: str
    kind: str
    ok: bool
    error: str | None = None


async def run_index_job(dsn: str, store: VectorStore, embedder: Embedder, job: db.Job) -> JobOutcome:
    try:
        await store.ensure_collection()  # 先保证 collection 存在，哪怕后面建向量这一步失败，count/delete 也不会因为"连 collection 都没有"而报错
        document = await db.fetch_document(dsn, job.document_id)
        if document is None:
            raise ValueError(f"document 不存在: {job.document_id}")
        segments = await db.fetch_segments(dsn, job.document_id)
        cohort_id = await db.fetch_lesson_cohort_id(dsn, document.lesson_id)

        vectors_by_hash = await _reusable_vectors(dsn, store, document, segments)
        to_embed = [s for s in segments if s.content_hash not in vectors_by_hash]
        if to_embed:
            fresh = await embedder.embed([s.content for s in to_embed])
            vectors_by_hash.update({s.content_hash: v for s, v in zip(to_embed, fresh, strict=True)})

        points = [
            SegmentPoint(
                segment_id=s.id, vector=vectors_by_hash[s.content_hash], document_id=document.id,
                document_version=document.version, lesson_id=document.lesson_id, cohort_id=cohort_id,
                visibility=document.visibility, content=s.content, start_ms=s.start_ms, end_ms=s.end_ms,
            )
            for s in segments
        ]
        await store.upsert(points)

        count = await store.count_by_document(document.id)
        if count != len(segments):
            raise RuntimeError(f"索引后点位数({count}) 跟 segment 数({len(segments)}) 对不上")

        await db.mark_job_succeeded(dsn, job.id)
        return JobOutcome(job.id, job.kind, ok=True)
    except Exception as e:  # noqa: BLE001 — 索引失败是预期中的业务结果，不是让 worker 崩溃的理由
        await db.mark_job_failed(dsn, job.id, str(e))
        return JobOutcome(job.id, job.kind, ok=False, error=str(e))


async def _reusable_vectors(dsn: str, store: VectorStore, document: db.Document, segments: list[db.Segment]) -> dict[str, list[float]]:
    """content_hash 跟上一个已索引版本完全相同的 segment，直接搬那一版算好的向量过来，
    不重新调用 embedder——T-25 落库时就为这个优化留了 content_hash，这里是它唯一的用途。
    """
    previous = await db.fetch_previous_indexed_document(dsn, document.lesson_id, document.id)
    if previous is None:
        return {}
    previous_segments = await db.fetch_segments(dsn, previous.id)
    current_hashes = {s.content_hash for s in segments}
    hash_to_old_id = {s.content_hash: s.id for s in previous_segments if s.content_hash in current_hashes}
    if not hash_to_old_id:
        return {}
    old_vectors = await store.fetch_vectors(list(hash_to_old_id.values()))
    return {h: old_vectors[old_id] for h, old_id in hash_to_old_id.items() if old_id in old_vectors}


async def run_cleanup_job(dsn: str, store: VectorStore, job: db.Job) -> JobOutcome:
    try:
        await store.delete_by_document(job.document_id)
        await db.mark_job_succeeded(dsn, job.id)
        return JobOutcome(job.id, job.kind, ok=True)
    except Exception as e:  # noqa: BLE001 — 同上：物理清理失败就是要重跑，不是崩溃
        await db.mark_job_failed(dsn, job.id, str(e))
        return JobOutcome(job.id, job.kind, ok=False, error=str(e))


async def run_pending_jobs(dsn: str, store: VectorStore, embedder: Embedder, *, limit: int = 20) -> list[JobOutcome]:
    """领取并处理最多 limit 条待处理任务（pending，或失败次数未到上限的 failed）。
    没有任务可领时直接返回空列表，不是错误——这是"失败重跑"真正被调用的入口：
    重新调用这个函数，上次失败的任务会被重新领取、重新跑一遍。
    """
    outcomes: list[JobOutcome] = []
    for _ in range(limit):
        job = await db.claim_job(dsn)
        if job is None:
            break
        if job.kind == "index":
            outcomes.append(await run_index_job(dsn, store, embedder, job))
        else:
            outcomes.append(await run_cleanup_job(dsn, store, job))
    return outcomes

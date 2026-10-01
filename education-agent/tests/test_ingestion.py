"""T-26：索引任务、发布激活、撤回/删除与失败重跑。真实临时 Postgres（跟 TS 侧
education-api/src/knowledge/import.test.ts 同一个做法：每个测试模块一个临时数据库，跑完整套
migration，结束后整个删掉，不污染共享的开发库）+ 真实本地 Qdrant（infra 的 compose 服务）+
真实本地 embedding（customer-embedding-demo，Qwen3-Embedding-0.6B）——索引任务的编排正确性
不需要靠 mock 模型才能验证，本地已经有一份能跑的真实服务就该用它，mock 只留给
embedding/mock.py 自己的单元测试。

验证的性质对应 AC-016："文档改版/删除；旧片段不可检索，失败重跑无重复数据"：
- 激活新版本会原子地撤回同一 lesson 的旧版本（撤回立即生效，不等物理清理）。
- 撤回后旧版本即使向量还没被物理删除，业务状态（activated_at）已经不再是激活的。
- 索引失败重跑：同一个 job 记录重跑，不会在 Qdrant 里堆出重复点位。
- content_hash 没变的 segment 复用上一版本已经算好的向量，不重新调用 embedding 服务。
"""
import asyncio
import hashlib
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx
import psycopg
import pytest

from education_agent.config import DATABASE_URL, QDRANT_URL
from education_agent.embedding.openai_embedder import create_openai_embedder
from education_agent.ingestion import db
from education_agent.ingestion.pipeline import run_pending_jobs
from education_agent.ingestion.vector_store import DimensionMismatch, VectorStore
from qdrant_client import AsyncQdrantClient

EMBEDDING_URL = "http://127.0.0.1:8080"
MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "education-api" / "src" / "db" / "migrations"


def _with_db(url: str, name: str) -> str:
    parts = urlsplit(url)
    return urlunsplit(parts._replace(path=f"/{name}"))


def _db_available() -> bool:
    try:
        psycopg.connect(DATABASE_URL, connect_timeout=2).close()
        return True
    except psycopg.Error:
        return False


def _embedding_available() -> bool:
    try:
        return httpx.get(f"{EMBEDDING_URL}/health", timeout=2).status_code == 200
    except httpx.HTTPError:
        return False


pytestmark = pytest.mark.skipif(
    not (_db_available() and _embedding_available()),
    reason="需要本地 education Postgres（npm run edu:infra）和本地 embedding（npm run dev --workspace=customer-embedding-demo）",
)


@pytest.fixture
def dsn():
    """每个测试一个全新的临时数据库：建库、跑完 education-api 的全部 migration、yield dsn，
    结束后删库——跟 TS 侧 import.test.ts 同一个理由，索引任务会真的写业务表，不能留在共享开发库里。
    """
    name = f"edu_test_{uuid.uuid4().hex[:12]}"
    admin = psycopg.connect(_with_db(DATABASE_URL, "postgres"), autocommit=True)
    admin.execute(f"CREATE DATABASE {name}")
    test_dsn = _with_db(DATABASE_URL, name)
    sql = "\n".join(
        MIGRATIONS_DIR.joinpath(f).read_text("utf-8") for f in sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql"))
    )
    # migrate.ts 靠连接参数 search_path=app 让迁移文件里不带 schema 前缀的 CREATE TABLE 落进 app；
    # 这里手动复现同一件事，否则建表会悄悄落进 public。
    with psycopg.connect(test_dsn) as conn:
        conn.execute("CREATE SCHEMA IF NOT EXISTS app")
        conn.execute("SET search_path = app")
        conn.execute(sql)
        conn.commit()
    yield test_dsn
    admin.execute(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s", (name,))
    admin.execute(f"DROP DATABASE {name}")
    admin.close()


@pytest.fixture
def store():
    """每个测试独立的 Qdrant collection：避免并发跑测试互相污染点位计数。"""
    collection = f"knowledge_segments_test_{uuid.uuid4().hex[:12]}"
    client = AsyncQdrantClient(url=QDRANT_URL)
    vs = VectorStore(client, collection, dimension=1024)
    yield vs
    asyncio.run(client.delete_collection(collection))


@pytest.fixture
def embedder():
    """真实本地 embedding 服务，不是 mock；包一层只记录"请求过哪些文本"，用来断言
    content_hash 复用路径真的跳过了没变的 segment，而不是去改 embedding 本身的行为。
    """

    class CountingEmbedder:
        def __init__(self, inner):
            self._inner = inner
            self.dimension = inner.dimension
            self.calls: list[str] = []

        async def embed(self, texts):
            self.calls.extend(texts)
            return await self._inner.embed(texts)

    return CountingEmbedder(create_openai_embedder(EMBEDDING_URL, "", "Qwen/Qwen3-Embedding-0.6B", 1024))


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def _insert_lesson(dsn: str) -> tuple[str, str]:
    """直接插入 course → course_version → cohort → lesson 这条最小链路，返回 (lesson_id, cohort_id)。
    T-26 测的是索引任务本身，不是 T-25 的导入；这里不走 education-api 的 import.ts。"""
    async with await psycopg.AsyncConnection.connect(dsn) as conn, conn.cursor() as cur:
        await cur.execute("INSERT INTO app.courses (title) VALUES ('课程') RETURNING id")
        course_id = (await cur.fetchone())[0]
        await cur.execute("INSERT INTO app.course_versions (course_id, version) VALUES (%s, 1) RETURNING id", (course_id,))
        version_id = (await cur.fetchone())[0]
        await cur.execute(
            "INSERT INTO app.cohorts (course_id, course_version_id, name, currency, status) "
            "VALUES (%s, %s, '班期1', 'CNY', 'running') RETURNING id",
            (course_id, version_id),
        )
        cohort_id = (await cur.fetchone())[0]
        await cur.execute("INSERT INTO app.lessons (cohort_id, title, position) VALUES (%s, '第一课', 1) RETURNING id", (cohort_id,))
        lesson_id = (await cur.fetchone())[0]
        await conn.commit()
        return str(lesson_id), str(cohort_id)


async def _insert_document(dsn: str, lesson_id: str, version: int, contents: list[str], visibility: str = "private") -> str:
    async with await psycopg.AsyncConnection.connect(dsn) as conn, conn.cursor() as cur:
        await cur.execute(
            "INSERT INTO app.knowledge_documents (lesson_id, kind, source_name, source_hash, version, visibility) "
            "VALUES (%s, 'markdown', 'test.md', %s, %s, %s) RETURNING id",
            (lesson_id, _sha256(f"{lesson_id}-{version}"), version, visibility),
        )
        document_id = str((await cur.fetchone())[0])
        for position, content in enumerate(contents):
            await cur.execute(
                "INSERT INTO app.knowledge_segments (document_id, position, content, content_hash) VALUES (%s, %s, %s, %s)",
                (document_id, position, content, _sha256(content)),
            )
        await conn.commit()
        return document_id


async def _document_row(dsn: str, document_id: str) -> dict:
    async with await psycopg.AsyncConnection.connect(dsn) as conn, conn.cursor() as cur:
        await cur.execute("SELECT activated_at, revoked_at FROM app.knowledge_documents WHERE id = %s", (document_id,))
        row = await cur.fetchone()
        return {"activated_at": row[0], "revoked_at": row[1]}


async def test_index_job_builds_points_with_required_payload(dsn, store, embedder):
    lesson_id, cohort_id = await _insert_lesson(dsn)
    doc_id = await _insert_document(dsn, lesson_id, 1, ["第一段内容", "第二段内容"], visibility="public")
    await db.enqueue_job(dsn, doc_id, "index")

    outcomes = await run_pending_jobs(dsn, store, embedder)
    assert len(outcomes) == 1 and outcomes[0].ok, outcomes

    assert await store.count_by_document(doc_id) == 2
    points = await store._client.scroll(store._collection, scroll_filter=None, limit=10)
    payloads = {p.payload["segmentId"]: p.payload for p in points[0] if p.payload["sourceId"] == doc_id}
    assert len(payloads) == 2
    for payload in payloads.values():
        assert payload["sourceId"] == doc_id
        assert payload["sourceVersion"] == 1
        assert payload["cohortId"] == cohort_id
        assert payload["visibility"] == "public"
        assert payload["lessonId"] == lesson_id
    assert len(embedder.calls) == 2, "首个版本没有旧向量可复用，两段都应该真的调用了 embedding"


async def test_activate_requires_successful_index_job(dsn):
    lesson_id, _ = await _insert_lesson(dsn)
    doc_id = await _insert_document(dsn, lesson_id, 1, ["内容"])

    with pytest.raises(db.ActivationError):
        await db.activate_document(dsn, doc_id)


async def test_activate_document_fails_fast_instead_of_blocking_when_lesson_is_busy(dsn):
    """用 pg_try_advisory_xact_lock 而不是会阻塞等待的版本：持锁的事务如果卡住（长事务、
    连接异常），不能让同一个 lesson 后续所有激活操作一起被拖着无限等。这里手动在另一个连接上
    持住同一把锁（跟 activate_document 内部用的是同一个命名空间+key），模拟"已经有一个激活
    操作在进行"，验证第二次调用是立刻失败，不是卡住。"""
    lesson_id, _ = await _insert_lesson(dsn)
    doc_id = await _insert_document(dsn, lesson_id, 1, ["内容"])
    await db.enqueue_job(dsn, doc_id, "index")
    job = await db.claim_job(dsn)
    await db.mark_job_succeeded(dsn, job.id)  # 只测锁本身，不需要真的跑一遍索引

    holder = await psycopg.AsyncConnection.connect(dsn)
    await holder.execute("SELECT pg_advisory_xact_lock(26, hashtext(%s))", (lesson_id,))
    try:
        with pytest.raises(db.LessonBusyError):
            await db.activate_document(dsn, doc_id)
    finally:
        await holder.rollback()  # 事务结束（哪怕是回滚）才会释放这把 xact 级别的咨询锁
        await holder.close()

    await db.activate_document(dsn, doc_id)  # 锁放开之后，正常激活应该照常成功


async def test_activating_new_version_atomically_revokes_old_one_without_waiting_for_cleanup(dsn, store, embedder):
    lesson_id, _ = await _insert_lesson(dsn)
    v1 = await _insert_document(dsn, lesson_id, 1, ["不变的内容", "v1 独有的内容"])
    await db.enqueue_job(dsn, v1, "index")
    await run_pending_jobs(dsn, store, embedder)
    await db.activate_document(dsn, v1)

    calls_before_v2 = len(embedder.calls)
    v2 = await _insert_document(dsn, lesson_id, 2, ["不变的内容", "v2 新增的内容"])
    await db.enqueue_job(dsn, v2, "index")
    await run_pending_jobs(dsn, store, embedder)

    # "不变的内容" 的 content_hash 跟 v1 一样，应该直接复用 v1 已经算好的向量，不重新请求 embedding；
    # 只有 v2 真正新增的那一段应该被送去 embedding。
    assert embedder.calls[calls_before_v2:] == ["v2 新增的内容"]

    await db.activate_document(dsn, v2)

    v1_row, v2_row = await _document_row(dsn, v1), await _document_row(dsn, v2)
    assert v1_row["activated_at"] is None and v1_row["revoked_at"] is not None
    assert v2_row["activated_at"] is not None and v2_row["revoked_at"] is None

    # AC-016：旧版本即使向量还没被物理清除，也已经不是业务上的激活版本了。
    assert await store.count_by_document(v1) == 2, "撤回不等于物理清除：清理是独立的异步任务"
    assert await db.fetch_job_status(dsn, v1, "cleanup") == "pending"

    outcomes = await run_pending_jobs(dsn, store, embedder)
    assert any(o.kind == "cleanup" and o.ok for o in outcomes)
    assert await store.count_by_document(v1) == 0, "cleanup 任务跑完后旧版本的向量才真的被删掉"


async def test_withdraw_is_immediate_and_idempotent(dsn, store, embedder):
    lesson_id, _ = await _insert_lesson(dsn)
    doc_id = await _insert_document(dsn, lesson_id, 1, ["内容"])
    await db.enqueue_job(dsn, doc_id, "index")
    await run_pending_jobs(dsn, store, embedder)
    await db.activate_document(dsn, doc_id)

    assert await db.withdraw_document(dsn, doc_id) is True
    row = await _document_row(dsn, doc_id)
    assert row["activated_at"] is None and row["revoked_at"] is not None

    # 再撤回一次是幂等的，不报错，也不会再登记一条重复的 cleanup 任务。
    assert await db.withdraw_document(dsn, doc_id) is False
    async with await psycopg.AsyncConnection.connect(dsn) as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT count(*) FROM app.knowledge_index_jobs WHERE document_id = %s AND kind = 'cleanup'", (doc_id,)
        )
        assert (await cur.fetchone())[0] == 1


async def test_failed_index_job_retry_does_not_duplicate_points(dsn, store, embedder):
    lesson_id, _ = await _insert_lesson(dsn)
    doc_id = await _insert_document(dsn, lesson_id, 1, ["段落一", "段落二"])
    await db.enqueue_job(dsn, doc_id, "index")

    class FlakyEmbedder:
        dimension = embedder.dimension
        calls_before_success = 1

        async def embed(self, texts):
            if FlakyEmbedder.calls_before_success > 0:
                FlakyEmbedder.calls_before_success -= 1
                raise RuntimeError("模拟 embedding 服务抽风")
            return await embedder.embed(texts)

    flaky = FlakyEmbedder()
    outcomes = await run_pending_jobs(dsn, store, flaky, limit=1)  # limit=1：只看第一次尝试，不让它在同一批里自动重试
    assert len(outcomes) == 1 and not outcomes[0].ok
    assert await db.fetch_job_status(dsn, doc_id, "index") == "failed"
    assert await store.count_by_document(doc_id) == 0, "失败时不应该留下任何半成品点位"

    # 不传 limit：这就是"失败重跑"真正被调用的样子——重新调用 run_pending_jobs，失败的任务被重新领取。
    outcomes = await run_pending_jobs(dsn, store, flaky)
    assert len(outcomes) == 1 and outcomes[0].ok
    assert await store.count_by_document(doc_id) == 2, "重跑成功后应该正好是两个点位，不是因为重试堆出更多"


async def test_claim_job_reclaims_a_running_job_abandoned_by_a_crashed_worker(dsn):
    """worker 领了任务（claim_job 把它标成 running）之后进程被杀，再也没人调
    mark_job_succeeded/mark_job_failed——这条任务不是 pending 也不是 failed，正常的
    "失败重跑"路径够不到它。claim_job 得靠"running 太久没人碰"这个粗粒度信号把它捡回来。

    用真实的极短阈值（0.05s）+ 真实的短暂 sleep 等它"过期"，而不是手动改 updated_at：
    knowledge_index_jobs 表上的 touch_updated_at 触发器会在任何 UPDATE 时把 updated_at
    强制改成 now()，手动改这个字段的值会被触发器原地覆盖，测不出想测的东西。
    """
    lesson_id, _ = await _insert_lesson(dsn)
    doc_id = await _insert_document(dsn, lesson_id, 1, ["内容"])
    await db.enqueue_job(dsn, doc_id, "index")

    first = await db.claim_job(dsn)  # 模拟：worker 领了任务就崩了
    assert first is not None and first.attempts == 1

    # 还没过期：不该被当成僵尸抢回来，否则一个真的还在正常跑的任务会被并发重复处理。
    assert await db.claim_job(dsn, stale_running_after_s=60) is None

    await asyncio.sleep(0.2)
    second = await db.claim_job(dsn, stale_running_after_s=0.05)
    assert second is not None and second.id == first.id and second.attempts == 2


async def test_run_pending_jobs_returns_empty_when_nothing_to_do(dsn, store, embedder):
    assert await run_pending_jobs(dsn, store, embedder) == []


async def test_ensure_collection_creates_payload_indexes_for_filtered_fields(store):
    """count_by_document/delete_by_document 按 sourceId 过滤，T-27 的权限过滤会按
    cohortId/lessonId/visibility 过滤——这些字段不建 payload index，量大后就是全表扫描，
    跟表的 WHERE 列不建索引是同一个问题。"""
    await store.ensure_collection()
    info = await store._client.get_collection(store._collection)
    assert set(info.payload_schema.keys()) >= {"sourceId", "cohortId", "lessonId", "visibility"}


async def test_ensure_collection_rejects_dimension_mismatch_instead_of_failing_later_at_upsert():
    """同名 collection 之前是用别的 embedding 模型（不同维度）建的，不能悄悄放行——
    不然要等到 upsert 那一步才报一个不好懂的"vector dimension error"。"""
    collection = f"knowledge_segments_test_{uuid.uuid4().hex[:12]}"
    client = AsyncQdrantClient(url=QDRANT_URL)
    try:
        await VectorStore(client, collection, dimension=4).ensure_collection()
        with pytest.raises(DimensionMismatch):
            await VectorStore(client, collection, dimension=1024).ensure_collection()
    finally:
        await client.delete_collection(collection)

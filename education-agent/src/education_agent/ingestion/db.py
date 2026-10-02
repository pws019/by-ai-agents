"""直接读写 knowledge_documents / knowledge_segments / knowledge_index_jobs 三张表（T-26）。

这些表由 education-api 的 migration 建（0010/0011），但索引任务本身是批处理，不属于"以谁的
身份发起一次请求"这种模型，没有 actor、没有 RunContext——跟工具调用（tools/runtime.py）是
完全不同的访问模式，所以不走 BusinessApi/HTTP，直接操作同一个 Postgres 实例，跟
checkpoint_cleanup.py 对 checkpoint 表的做法是同一个道理。

查询用 SQLAlchemy Core（不是它的 ORM 层）拼，不是手写 SQL 字符串——跟 education-api 的
db/schema.ts + drizzle 是同一个角色：表结构的真相仍然是 .sql migration（见 tables.py 头部
说明），这里只是借它的类型化查询构建器，换来字段名拼错能在开发时就被发现，而不是等运行时报错。

每个函数独立开关一个 engine：索引任务量级是"老师发布一次资料"，不是高频路径，不值得维护长连接池。
"""
from contextlib import asynccontextmanager
from dataclasses import dataclass

from sqlalchemy import func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import create_async_engine

from .tables import knowledge_documents, knowledge_index_jobs, knowledge_segments, lessons

MAX_ATTEMPTS = 5

# worker 进程被杀/崩溃时，正在跑的任务会停在 running 状态，既不满足 pending/failed 的领取条件，
# 也没有任何心跳告诉别人"这个任务其实已经没人管了"——这里没有做真正的心跳机制（每个任务函数
# 独立开关连接，运行期间不会回来更新 updated_at），只能用一个足够宽松的超时粗粒度判断"这个
# running 大概率是僵尸"：真实索引任务（embed 几段文字 + upsert 到 Qdrant）正常几秒到几十秒
# 内完成，远小于这个阈值；设短了可能把"确实还在跑"的任务错误地抢过来重跑一遍（Qdrant upsert
# 本身幂等，顶多多花一次 embedding 调用，不会产生脏数据，但仍是已知的粗糙之处，留给以后真的
# 需要长任务时再补心跳）。
STALE_RUNNING_AFTER_S = 600


@dataclass(frozen=True)
class Document:
    id: str
    lesson_id: str
    version: int
    visibility: str
    activated_at: object | None


@dataclass(frozen=True)
class Segment:
    id: str
    position: int
    content: str
    content_hash: str
    start_ms: int | None
    end_ms: int | None


@dataclass(frozen=True)
class Job:
    id: str
    document_id: str
    kind: str
    attempts: int


@asynccontextmanager
async def _connect(dsn: str):
    """psycopg 的原生 DSN（postgresql://...）换成 SQLAlchemy 的方言前缀，用完即弃——
    跟之前 `psycopg.AsyncConnection.connect(dsn)` 的"每次独立开关"是同一个生命周期，
    只是换了一层更安全的查询构建 API，调用方传进来的 dsn 不用跟着改。
    """
    engine = create_async_engine(dsn.replace("postgresql://", "postgresql+psycopg://", 1))
    try:
        async with engine.connect() as conn:
            yield conn
    finally:
        await engine.dispose()


async def fetch_document(dsn: str, document_id: str) -> Document | None:
    async with _connect(dsn) as conn:
        row = (await conn.execute(
            select(
                knowledge_documents.c.id, knowledge_documents.c.lesson_id, knowledge_documents.c.version,
                knowledge_documents.c.visibility, knowledge_documents.c.activated_at,
            ).where(knowledge_documents.c.id == document_id)
        )).first()
        return None if row is None else Document(row.id, row.lesson_id, row.version, row.visibility, row.activated_at)


async def fetch_documents(dsn: str, document_ids: list[str]) -> dict[str, Document]:
    """批量版的 fetch_document，按 id 查询一批（T-27 的检索候选去重后一次性核验，不是
    一条候选发一次请求）。返回字典只包含真的存在的 id；不存在的 id 直接从结果里缺席。"""
    if not document_ids:
        return {}
    async with _connect(dsn) as conn:
        rows = (await conn.execute(
            select(
                knowledge_documents.c.id, knowledge_documents.c.lesson_id, knowledge_documents.c.version,
                knowledge_documents.c.visibility, knowledge_documents.c.activated_at,
            ).where(knowledge_documents.c.id.in_(document_ids))
        )).all()
        return {r.id: Document(r.id, r.lesson_id, r.version, r.visibility, r.activated_at) for r in rows}


async def fetch_segments(dsn: str, document_id: str) -> list[Segment]:
    async with _connect(dsn) as conn:
        rows = (await conn.execute(
            select(
                knowledge_segments.c.id, knowledge_segments.c.position, knowledge_segments.c.content,
                knowledge_segments.c.content_hash, knowledge_segments.c.start_ms, knowledge_segments.c.end_ms,
            ).where(knowledge_segments.c.document_id == document_id).order_by(knowledge_segments.c.position)
        )).all()
        return [Segment(r.id, r.position, r.content, r.content_hash, r.start_ms, r.end_ms) for r in rows]


async def fetch_lesson_cohort_id(dsn: str, lesson_id: str) -> str:
    async with _connect(dsn) as conn:
        row = (await conn.execute(select(lessons.c.cohort_id).where(lessons.c.id == lesson_id))).first()
        if row is None:
            raise ValueError(f"lesson 不存在: {lesson_id}")
        return row.cohort_id


async def fetch_lesson_titles(dsn: str, lesson_ids: list[str]) -> dict[str, str]:
    """批量取课次标题，供 T-28 的 citation/replay.card 事件用（两个事件payload都要带人能看懂的
    课次名字，不是只有 lessonId）。返回字典只包含真的存在的 id，用法跟 fetch_documents 一致。"""
    if not lesson_ids:
        return {}
    async with _connect(dsn) as conn:
        rows = (await conn.execute(
            select(lessons.c.id, lessons.c.title).where(lessons.c.id.in_(lesson_ids))
        )).all()
        return {r.id: r.title for r in rows}


async def fetch_previous_indexed_document(dsn: str, lesson_id: str, exclude_document_id: str) -> Document | None:
    """同一 lesson 里，version 比当前小、且索引任务已经成功过的最近一个版本——供"内容没变就复用
    旧向量"用。不要求它是当前 activated 的那个：同一个版本可能先建完索引、还没被激活就又导入了
    更新的一版，这种情况下复用的来源仍然是它，不是业务意义上的"当前对外可见版本"。
    """
    d, j = knowledge_documents, knowledge_index_jobs
    async with _connect(dsn) as conn:
        row = (await conn.execute(
            select(d.c.id, d.c.lesson_id, d.c.version, d.c.visibility, d.c.activated_at)
            .join(j, (j.c.document_id == d.c.id) & (j.c.kind == "index"))
            .where(d.c.lesson_id == lesson_id, d.c.id != exclude_document_id, j.c.status == "succeeded")
            .order_by(d.c.version.desc())
            .limit(1)
        )).first()
        return None if row is None else Document(row.id, row.lesson_id, row.version, row.visibility, row.activated_at)


async def enqueue_job(dsn: str, document_id: str, kind: str) -> None:
    """登记一个索引/清理任务；同一 (document_id, kind) 已经有记录就什么都不做——
    重复导入触发、或撤回后手滑点了两次，都不会堆出重复任务。"""
    async with _connect(dsn) as conn:
        await conn.execute(
            pg_insert(knowledge_index_jobs)
            .values(document_id=document_id, kind=kind)
            .on_conflict_do_nothing(index_elements=["document_id", "kind"])
        )
        await conn.commit()


async def claim_job(
    dsn: str, max_attempts: int = MAX_ATTEMPTS, stale_running_after_s: float = STALE_RUNNING_AFTER_S
) -> Job | None:
    """原子地认领一条待处理任务：pending、失败次数还没到上限的 failed，或者卡在 running 太久
    （worker 崩溃留下的僵尸任务，见 STALE_RUNNING_AFTER_S 的说明）。FOR UPDATE SKIP LOCKED
    保证多个 worker 并发跑也不会抢到同一条；没有任务可领时返回 None，不是报错。

    "太久"用数据库自己的 now() 算，不用 Python 进程的本机时钟：这个服务和 Postgres 经常分别跑在
    宿主机和 Docker 容器里，两边时钟哪怕只差几十毫秒，混用就会让一个刚刚好卡在阈值附近的判断
    直接翻面——时间比较这件事本来就该交给写入 updated_at 的同一个时钟源判断，不是巧合碰对。
    """
    j = knowledge_index_jobs
    stale_before = func.now() - text("(:stale_s * interval '1 second')").bindparams(stale_s=stale_running_after_s)
    claimed = (
        select(j.c.id)
        .where(
            j.c.attempts < max_attempts,
            or_(
                j.c.status.in_(("pending", "failed")),
                (j.c.status == "running") & (j.c.updated_at < stale_before),
            ),
        )
        .order_by(j.c.created_at)
        .with_for_update(skip_locked=True)
        .limit(1)
        .cte("claimed")
    )
    stmt = (
        update(j)
        .where(j.c.id == claimed.c.id)
        .values(status="running", attempts=j.c.attempts + 1)
        .returning(j.c.id, j.c.document_id, j.c.kind, j.c.attempts)
    )
    async with _connect(dsn) as conn:
        row = (await conn.execute(stmt)).first()
        await conn.commit()
        return None if row is None else Job(row.id, row.document_id, row.kind, row.attempts)


async def mark_job_succeeded(dsn: str, job_id: str) -> None:
    async with _connect(dsn) as conn:
        await conn.execute(
            update(knowledge_index_jobs).where(knowledge_index_jobs.c.id == job_id)
            .values(status="succeeded", last_error=None)
        )
        await conn.commit()


async def mark_job_failed(dsn: str, job_id: str, error: str) -> None:
    async with _connect(dsn) as conn:
        await conn.execute(
            update(knowledge_index_jobs).where(knowledge_index_jobs.c.id == job_id)
            .values(status="failed", last_error=error[:2000])
        )
        await conn.commit()


async def fetch_job_status(dsn: str, document_id: str, kind: str) -> str | None:
    async with _connect(dsn) as conn:
        row = (await conn.execute(
            select(knowledge_index_jobs.c.status)
            .where(knowledge_index_jobs.c.document_id == document_id, knowledge_index_jobs.c.kind == kind)
        )).first()
        return None if row is None else row.status


class ActivationError(Exception):
    pass


# 咨询锁是整个数据库共享的扁平 64 位编号空间，不是这个模块私有的。单参数形式
# pg_advisory_lock(key) 等价于双参数形式里命名空间=0 的那个 key——education-api 的
# db/migrate.ts 就用了单参数形式（LOCK_KEY=728301）。这里用非零命名空间，保证不会跟它、
# 或者以后任何其它用单参数形式的锁，撞进同一个数字；真要在这个项目里再加别的咨询锁，
# 应该各自挑一个不同的命名空间常量，不能都用 0 或都用单参数形式。
_LESSON_ACTIVATION_LOCK_NAMESPACE = 26  # 对应 T-26，没有别的含义，只是个好记的隔离标记


class LessonBusyError(Exception):
    """同一 lesson 上已经有另一个激活操作在进行。不等它——阻塞等待的问题是：如果持锁的那个
    事务卡住（连接异常、长事务），后面所有对这个 lesson 的激活都会一起卡住，没有任何超时。
    改成拿不到锁立即返回，把"要不要重试"交给调用方决定（HTTP 层可以映射成 409 让前端重试）。"""


async def activate_document(dsn: str, document_id: str) -> None:
    """发布：激活这个版本，同时撤回同一 lesson 当前激活的版本（如果有）。要求索引任务已成功——
    没建完索引就激活，查询会拿着一个 Qdrant 里根本不存在的版本去搜，等于什么都搜不到。

    revoke 和 activate 在同一个事务里：不存在"旧版本已撤回、新版本还没激活"或者"两个版本同时
    激活"的中间状态（部分唯一索引 knowledge_documents_one_active 在数据库层面也保证了这点）。
    撤回的旧版本顺带登记一个 cleanup 任务——物理清除向量是后续异步的事，不在这个事务里做，
    不能让激活等着它。
    """
    d, j = knowledge_documents, knowledge_index_jobs
    async with _connect(dsn) as conn:
        row = (await conn.execute(select(d.c.lesson_id).where(d.c.id == document_id))).first()
        if row is None:
            raise ActivationError(f"document 不存在: {document_id}")
        lesson_id = row.lesson_id

        job_row = (await conn.execute(
            select(j.c.status).where(j.c.document_id == document_id, j.c.kind == "index")
        )).first()
        if job_row is None or job_row.status != "succeeded":
            raise ActivationError(f"document {document_id} 的索引任务还没成功，不能激活（当前状态: {job_row and job_row.status}）")

        # 同一 lesson 内所有并发的激活操作互斥，避免 READ COMMITTED 下两次激活各自读到"没有旧版本"
        # 而都成功撤回+激活，短暂出现两个 activated_at 都非空的窗口。用 try 版本而不是会一直
        # 阻塞等待的 pg_advisory_xact_lock：拿不到就立即失败，不会因为别的事务卡住而被无限期拖住。
        got_lock = (await conn.execute(
            text("SELECT pg_try_advisory_xact_lock(:ns, hashtext(:lesson_id))"),
            {"ns": _LESSON_ACTIVATION_LOCK_NAMESPACE, "lesson_id": str(lesson_id)},
        )).scalar()
        if not got_lock:
            raise LessonBusyError(f"lesson {lesson_id} 正在被另一个激活操作处理，请稍后重试")

        revoked_ids = [r.id for r in await conn.execute(
            update(d).where(d.c.lesson_id == lesson_id, d.c.id != document_id, d.c.activated_at.isnot(None))
            .values(activated_at=None, revoked_at=func.now())
            .returning(d.c.id)
        )]

        await conn.execute(
            update(d).where(d.c.id == document_id).values(activated_at=func.now(), revoked_at=None)
        )

        for revoked_id in revoked_ids:
            await conn.execute(
                pg_insert(j).values(document_id=revoked_id, kind="cleanup")
                .on_conflict_do_nothing(index_elements=["document_id", "kind"])
            )

        await conn.commit()


async def withdraw_document(dsn: str, document_id: str) -> bool:
    """撤回：不等待任何人替代，直接让这个版本立刻不再是 activated。AC-016 要的"旧版本即使未
    物理清除也不能返回"就是靠这一行 UPDATE 立即生效——物理清除向量是另外登记的 cleanup 任务，
    慢、可以重试，但绝不是"能不能查到"的判断依据。

    对本来就没激活的 document 调用是幂等的（返回 False，不报错）：撤回一个草稿或已经撤回过的
    版本不该是错误。
    """
    d, j = knowledge_documents, knowledge_index_jobs
    async with _connect(dsn) as conn:
        row = (await conn.execute(
            update(d).where(d.c.id == document_id, d.c.activated_at.isnot(None))
            .values(activated_at=None, revoked_at=func.now())
            .returning(d.c.id)
        )).first()
        if row is None:
            await conn.commit()
            return False

        await conn.execute(
            pg_insert(j).values(document_id=document_id, kind="cleanup")
            .on_conflict_do_nothing(index_elements=["document_id", "kind"])
        )
        await conn.commit()
        return True

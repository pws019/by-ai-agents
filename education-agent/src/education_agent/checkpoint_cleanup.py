"""按 thread 清理旧 checkpoint（progress.md 已知局限第 2 层）。

背景：LangGraph 的 `AsyncPostgresSaver` 目前没有实现 `aprune`/`prune`——调用会直接走到
`BaseCheckpointSaver` 里 `raise NotImplementedError` 的默认实现（已在 langgraph 1.2.11 +
langgraph-checkpoint-postgres 3.1.2 上验证，PyPI 当前最新版同样如此；见
https://github.com/langchain-ai/langgraph/issues/8531）。官方自托管场景下的建议就是自己写
清理任务（docs.langchain.com/oss/python/langgraph/persistence 的 "Checkpoints growing
unboundedly" 一节）。

依赖 langgraph-checkpoint-postgres 的内部表结构（checkpoints / checkpoint_blobs /
checkpoint_writes），这三张表不是这个库公开 API 的一部分：升级这个依赖版本时要重新核对
下面的 SQL 是否还成立（尤其是 checkpoints.checkpoint 里 channel_versions 这个字段的形状）。

安全前提（已核实，见 progress.md）：student_graph.py 的图里所有 channel 都是
BinaryOperatorAggregate / LastValue / EphemeralValue，没有用 DeltaChannel——DeltaChannel
的当前值依赖"从某个快照开始重放增量"，删掉中间的旧 checkpoint 会让它悄悄拼出空值而不报错
（issue #8531 里反复强调的核心风险）。如果以后图里引入了 DeltaChannel 类型的 channel，
这份清理逻辑需要重新评估，不能直接照搬。

算法（对应 issue #8531 提出的安全做法）：按 (thread_id, checkpoint_ns) 只保留最新一条
checkpoint；checkpoints.checkpoint 里的 channel_versions 是一份"目录"，指向 checkpoint_blobs
里各个 channel 的真实值——不在这份目录里的 blob 版本不再被任何保留的 checkpoint 引用，才能删；
checkpoint_writes 按 checkpoint_id 关联，只属于某一条具体的 checkpoint，跟着旧 checkpoint 一起
删即可。全过程在一个事务里完成，避免中途失败留下"只删了一半"的不一致状态。
"""
import psycopg

from .config import CHECKPOINT_SCHEMA


async def prune_thread_checkpoints(dsn: str, thread_id: str, checkpoint_ns: str = "") -> None:
    """只保留这个线程最新的一条 checkpoint，删掉更早的 checkpoint/writes，以及不再被引用的 blob。
    线程还没有任何 checkpoint 时（比如从未成功跑过一次）什么都不做。
    """
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                f"SELECT checkpoint_id, checkpoint FROM {CHECKPOINT_SCHEMA}.checkpoints "
                "WHERE thread_id = %s AND checkpoint_ns = %s ORDER BY checkpoint_id DESC LIMIT 1",
                (thread_id, checkpoint_ns),
            )
            row = await cur.fetchone()
            if row is None:
                return
            latest_id, checkpoint = row
            needed = list(checkpoint["channel_versions"].items())  # [(channel, version), ...] 仍被最新 checkpoint 引用

            await cur.execute(
                f"DELETE FROM {CHECKPOINT_SCHEMA}.checkpoints "
                "WHERE thread_id = %s AND checkpoint_ns = %s AND checkpoint_id != %s",
                (thread_id, checkpoint_ns, latest_id),
            )
            await cur.execute(
                f"DELETE FROM {CHECKPOINT_SCHEMA}.checkpoint_writes "
                "WHERE thread_id = %s AND checkpoint_ns = %s AND checkpoint_id != %s",
                (thread_id, checkpoint_ns, latest_id),
            )
            if needed:
                placeholders = ",".join(["(%s, %s)"] * len(needed))
                await cur.execute(
                    f"DELETE FROM {CHECKPOINT_SCHEMA}.checkpoint_blobs "
                    f"WHERE thread_id = %s AND checkpoint_ns = %s AND (channel, version) NOT IN ({placeholders})",
                    (thread_id, checkpoint_ns, *[v for pair in needed for v in pair]),
                )
            else:
                await cur.execute(
                    f"DELETE FROM {CHECKPOINT_SCHEMA}.checkpoint_blobs WHERE thread_id = %s AND checkpoint_ns = %s",
                    (thread_id, checkpoint_ns),
                )
        await conn.commit()

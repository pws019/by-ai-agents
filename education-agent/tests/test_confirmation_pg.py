"""T-19 第 3 步在真实 Postgres checkpointer 上的验收：
- AC-011：等待确认时"服务重启"，同一会话可继续原任务，且没有重复写入。
- 工作证（token）不进入 checkpoint 的任何表（此前只在内存 checkpointer 上验证过）。

"重启"的做法：关闭第一批连接池和图对象，再用全新的连接池、checkpointer、图对象继续。图的全部状态都在 Postgres 里，
进程内没有别的东西，所以这与真的杀进程等价；T-04 已有真实 kill -9 的验收（test_restart_resume.py）。
"""
import uuid

import psycopg
import pytest
from langgraph.types import Command

from education_agent.checkpoint import open_checkpointer
from education_agent.config import CHECKPOINT_SCHEMA, DATABASE_URL
from education_agent.graphs.student_graph import REPLY_NEEDS_CONFIRMATION, RunScope
from education_agent.tools.spec import RunBudget

from test_student_graph import CONFIRMATION_ID, DRAFT_SCRIPT, TOKEN, Harness, ctx


def _db_available() -> bool:
    try:
        psycopg.connect(DATABASE_URL, connect_timeout=2).close()
        return True
    except psycopg.Error:
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="需要本地 education Postgres（npm run edu:infra）")

NEW_TOKEN = "SECOND-SIGNED-TOKEN-AFTER-RESTART"


def persisted_occurrences(thread_id: str, needle: str) -> int:
    """在这个线程的所有 checkpoint 表里，needle 出现在多少行（二进制 blob 和 json 列都查）。"""
    n = needle.encode()
    with psycopg.connect(DATABASE_URL) as conn:
        conn.execute(f"SET search_path = {CHECKPOINT_SCHEMA}")
        counts = [
            conn.execute("SELECT count(*) FROM checkpoint_blobs WHERE thread_id = %s AND position(%s::bytea in blob) > 0", (thread_id, n)).fetchone()[0],
            conn.execute("SELECT count(*) FROM checkpoint_writes WHERE thread_id = %s AND position(%s::bytea in blob) > 0", (thread_id, n)).fetchone()[0],
            conn.execute("SELECT count(*) FROM checkpoints WHERE thread_id = %s AND (checkpoint::text LIKE %s OR metadata::text LIKE %s)", (thread_id, f"%{needle}%", f"%{needle}%")).fetchone()[0],
        ]
    return sum(counts)


async def test_pending_confirmation_survives_restart_without_duplicate_writes_and_token_never_hits_the_database():
    thread = f"t-{uuid.uuid4().hex[:8]}"

    # 进程 1：起草并停在确认卡。
    async with open_checkpointer() as saver:
        h1 = Harness(list(DRAFT_SCRIPT), checkpointer=saver)
        out = await h1.say("我想转班", thread=thread)
        assert out["__interrupt__"][0].value["reply"] == REPLY_NEEDS_CONFIRMATION
    posts_before_restart = [r for r in h1.requests if r.method == "POST"]
    assert len(posts_before_restart) == 1

    # 落库检查。先做"正向对照"：确认卡 id 确实在状态里，说明这种查找方式能找到东西；再断言 token 不在。
    assert persisted_occurrences(thread, CONFIRMATION_ID) > 0, "对照失败：查找方式本身有问题，下面的'找不到 token'就不可信"
    assert persisted_occurrences(thread, TOKEN) == 0
    assert persisted_occurrences(thread, "student-1") == 0

    # 进程 2（全新的连接池/checkpointer/图，没有任何内存状态）：学员在界面确认后，用新的工作证恢复。
    async with open_checkpointer() as saver:
        h2 = Harness([], checkpointer=saver)  # 脚本为空：恢复路径不得调用模型
        assert (await h2.snapshot(thread)).next == ("await_confirmation",), "重启后应仍停在等待确认"
        h2.application.update(status="submitted")
        new_ctx = ctx()
        object.__setattr__(new_ctx, "token", NEW_TOKEN)
        out = await h2.graph.ainvoke(
            Command(resume="anything"), {"configurable": {"thread_id": thread}}, context=RunScope(new_ctx, RunBudget())
        )
    assert out["reply"] == "你的申请已提交，等待老师处理。"
    assert [r.method for r in h2.requests] == ["GET"], "恢复后只读了申请状态：没有重复创建草稿，也没有任何确认/提交请求"
    assert h2.requests[0].headers["X-Actor-Context"] == NEW_TOKEN, "恢复用的是新工作证，不是旧的"
    assert persisted_occurrences(thread, NEW_TOKEN) == 0 and persisted_occurrences(thread, TOKEN) == 0

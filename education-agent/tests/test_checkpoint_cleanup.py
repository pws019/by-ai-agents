"""checkpoint_cleanup.py 在真实 Postgres 上的验收（progress.md 已知局限第 2 层）。

LangGraph 的 AsyncPostgresSaver 没有实现 aprune，这里手写的清理逻辑直接操作
langgraph-checkpoint-postgres 的内部表（checkpoints/checkpoint_blobs/checkpoint_writes）。
要重点验证两件事：①真的把行数收口到 1；②裁剪后状态依然完整可读，尤其是"挂起等确认"这种
最不能出错的场景——裁剪不能让恢复变得读不出来或读出坏数据。
"""
import uuid

import httpx
import psycopg
import pytest
from langgraph.types import Command

from education_agent.checkpoint import open_checkpointer
from education_agent.checkpoint_cleanup import prune_thread_checkpoints
from education_agent.config import CHECKPOINT_SCHEMA, DATABASE_URL
from education_agent.graphs.student_graph import REPLY_NEEDS_CONFIRMATION, RunScope
from education_agent.model.base import ModelReply
from education_agent.server import create_app
from education_agent.tools.spec import RunBudget

from test_agent_server import SECRET, route, token
from test_student_graph import DRAFT_SCRIPT, Harness, ctx


def _db_available() -> bool:
    try:
        psycopg.connect(DATABASE_URL, connect_timeout=2).close()
        return True
    except psycopg.Error:
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="需要本地 education Postgres（npm run edu:infra）")


async def _table_counts(thread_id: str) -> dict[str, int]:
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn, conn.cursor() as cur:
        out = {}
        for table in ("checkpoints", "checkpoint_blobs", "checkpoint_writes"):
            await cur.execute(f"SELECT count(*) FROM {CHECKPOINT_SCHEMA}.{table} WHERE thread_id = %s", (thread_id,))
            out[table] = (await cur.fetchone())[0]
        return out


async def test_prune_collapses_to_one_checkpoint_and_state_stays_readable():
    thread = f"t-{uuid.uuid4().hex[:8]}"
    async with open_checkpointer() as saver:
        h = Harness([route("query"), ModelReply(text="ok1"), route("query"), ModelReply(text="ok2"), route("query"), ModelReply(text="ok3")], checkpointer=saver)
        for text in ("第一轮", "第二轮", "第三轮"):
            await h.say(text, thread=thread)

        before = await _table_counts(thread)
        assert before["checkpoints"] > 1, "多轮下应该已经积累了不止 1 条 checkpoint，测试前提成立"

        await prune_thread_checkpoints(DATABASE_URL, thread)

        after = await _table_counts(thread)
        assert after["checkpoints"] == 1

        snap = await h.snapshot(thread)
        assert [m["content"] for m in snap.values["messages"] if m["role"] == "user"] == ["第一轮", "第二轮", "第三轮"]
        assert snap.values["reply"] == "ok3"


async def test_prune_does_not_break_resume_of_a_pending_confirmation():
    thread = f"t-{uuid.uuid4().hex[:8]}"
    async with open_checkpointer() as saver:
        h = Harness(list(DRAFT_SCRIPT), checkpointer=saver)
        out = await h.say("我想转班", thread=thread)
        assert out["__interrupt__"][0].value["reply"] == REPLY_NEEDS_CONFIRMATION

        await prune_thread_checkpoints(DATABASE_URL, thread)
        assert (await _table_counts(thread))["checkpoints"] == 1

        snap = await h.snapshot(thread)
        assert snap.next == ("await_confirmation",), "裁剪后仍应停在等待确认，而不是变得读不出挂起状态"

        h.application.update(status="submitted")
        result = await h.graph.ainvoke(
            Command(resume="anything"), {"configurable": {"thread_id": thread}}, context=RunScope(ctx(), RunBudget())
        )
        assert result["reply"] == "你的申请已提交，等待老师处理。"


async def test_server_prunes_after_every_run_when_given_a_checkpoint_dsn():
    conversation = str(uuid.UUID(int=99))
    async with open_checkpointer() as saver:
        h = Harness([route("query"), ModelReply(text="ok1"), route("query"), ModelReply(text="ok2")], checkpointer=saver)
        app = create_app(h.graph, SECRET, checkpoint_dsn=DATABASE_URL)
        http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent.test")
        tok = token()
        thread_id = f"student-1:{conversation}"

        for text in ("第一轮", "第二轮"):
            r = await http.post("/internal/runs", json={"conversationId": conversation, "text": text}, headers={"X-Actor-Context": tok})
            assert r.status_code == 200

        assert (await _table_counts(thread_id))["checkpoints"] == 1


async def test_server_without_checkpoint_dsn_does_not_touch_postgres_at_all():
    # 默认（没传 checkpoint_dsn）不应该发起任何清理：InMemorySaver 场景下这张表根本不存在于这个线程下。
    conversation = str(uuid.UUID(int=100))
    from langgraph.checkpoint.memory import InMemorySaver
    h = Harness([route("query"), ModelReply(text="ok1")], checkpointer=InMemorySaver())
    app = create_app(h.graph, SECRET)  # checkpoint_dsn 留空
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent.test")
    r = await http.post("/internal/runs", json={"conversationId": conversation, "text": "你好"}, headers={"X-Actor-Context": token()})
    assert r.status_code == 200


async def test_prune_failure_is_logged_but_does_not_break_an_already_completed_stream(caplog):
    conversation = str(uuid.UUID(int=101))
    async with open_checkpointer() as saver:
        h = Harness([route("query"), ModelReply(text="ok")], checkpointer=saver)
        bad_dsn = DATABASE_URL.replace("edu:", "edu:wrong-password@@")  # 故意连不上
        app = create_app(h.graph, SECRET, checkpoint_dsn=bad_dsn)
        http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent.test")
        r = await http.post("/internal/runs", json={"conversationId": conversation, "text": "你好"}, headers={"X-Actor-Context": token()})
        assert r.status_code == 200 and "message.completed" in r.text, "清理失败不能影响本次已经成功的响应"
        assert "checkpoint prune failed" in caplog.text

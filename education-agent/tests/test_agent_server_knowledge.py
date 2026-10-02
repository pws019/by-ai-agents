"""T-29：教师维护页面触发发布/撤回的 /internal/knowledge/* 接口。
走真实的 FastAPI 应用（ASGI）+ 真实临时 Postgres（复用 test_ingestion.py 的 dsn 夹具）——
这两个接口都是对 T-26 已经测过的 ingestion.db 函数（activate_document/withdraw_document）的
薄 HTTP 封装，这里只验证"封装对不对"（认证、角色、状态码映射），不重新验证一遍 T-26 已经
验证过的并发/状态机正确性。不需要真实 embedding/Qdrant：索引任务的状态直接用 SQL 插入
knowledge_index_jobs 行模拟，不用真的跑一遍索引。索引状态查询本身没有单独的接口——那只是
读一行数据，没有并发不变量要保护，education-api 直接读数据库，见 server.py 的说明。
"""
import time
import uuid

import httpx
import psycopg
import pytest

from education_agent.server import create_app

from test_context import sign
from test_ingestion import _db_available, _insert_document, _insert_lesson, dsn  # noqa: F401

SECRET = "knowledge-admin-test-secret"

pytestmark = pytest.mark.skipif(not _db_available(), reason="需要本地 education Postgres（npm run edu:infra）")


def token(role: str = "teacher", *, actor: str = "teacher-1") -> str:
    return sign({"actorId": actor, "role": role, "requestId": "req-1", "exp": int(time.time()) + 60}, SECRET)


class Client:
    def __init__(self, dsn: str):
        app = create_app(None, SECRET, knowledge_dsn=dsn)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent.test")


async def _set_index_status(dsn: str, document_id: str, status: str) -> None:
    async with await psycopg.AsyncConnection.connect(dsn) as conn, conn.cursor() as cur:
        await cur.execute(
            "INSERT INTO app.knowledge_index_jobs (document_id, kind, status) VALUES (%s, 'index', %s)", (document_id, status)
        )
        await conn.commit()


# ---- 认证/授权：三个接口共用同一套规则 -----------------------------------------------------

@pytest.mark.parametrize("path_suffix", ["activate", "withdraw"])
async def test_post_endpoints_require_a_valid_teacher_token(dsn, path_suffix):
    c = Client(dsn)
    doc_id = str(uuid.uuid4())

    r = await c.http.post(f"/internal/knowledge/documents/{doc_id}/{path_suffix}")
    assert r.status_code == 401

    r = await c.http.post(f"/internal/knowledge/documents/{doc_id}/{path_suffix}", headers={"X-Actor-Context": "garbage"})
    assert r.status_code == 401

    r = await c.http.post(f"/internal/knowledge/documents/{doc_id}/{path_suffix}", headers={"X-Actor-Context": token("student")})
    assert r.status_code == 403


async def test_knowledge_endpoints_are_unavailable_when_the_app_was_built_without_knowledge_dsn():
    app = create_app(None, SECRET)  # 没传 knowledge_dsn：比如只测聊天图的场景
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent.test")
    r = await http.post("/internal/knowledge/documents/00000000-0000-0000-0000-000000000000/activate", headers={"X-Actor-Context": token()})
    assert r.status_code == 503 and r.json()["error"]["code"] == "DEPENDENCY_UNAVAILABLE"


# ---- activate ----------------------------------------------------------------------------

async def test_activate_succeeds_once_index_job_has_succeeded(dsn):
    lesson_id, _cohort_id = await _insert_lesson(dsn)
    doc_id = await _insert_document(dsn, lesson_id, 1, ["内容"])
    await _set_index_status(dsn, doc_id, "succeeded")
    c = Client(dsn)

    r = await c.http.post(f"/internal/knowledge/documents/{doc_id}/activate", headers={"X-Actor-Context": token()})
    assert r.status_code == 204

    async with await psycopg.AsyncConnection.connect(dsn) as conn, conn.cursor() as cur:
        await cur.execute("SELECT activated_at FROM app.knowledge_documents WHERE id = %s", (doc_id,))
        assert (await cur.fetchone())[0] is not None


async def test_activate_rejects_a_document_whose_index_job_has_not_succeeded_yet(dsn):
    lesson_id, _cohort_id = await _insert_lesson(dsn)
    doc_id = await _insert_document(dsn, lesson_id, 1, ["内容"])
    await _set_index_status(dsn, doc_id, "running")
    c = Client(dsn)

    r = await c.http.post(f"/internal/knowledge/documents/{doc_id}/activate", headers={"X-Actor-Context": token()})
    assert r.status_code == 422 and r.json()["error"]["code"] == "NOT_READY"


async def test_activate_reports_lesson_busy_instead_of_blocking_when_another_activation_holds_the_lock(dsn):
    lesson_id, _cohort_id = await _insert_lesson(dsn)
    doc_id = await _insert_document(dsn, lesson_id, 1, ["内容"])
    await _set_index_status(dsn, doc_id, "succeeded")
    c = Client(dsn)

    async with await psycopg.AsyncConnection.connect(dsn) as holder:
        await holder.execute("SELECT pg_advisory_xact_lock(26, hashtext(%s))", (lesson_id,))
        r = await c.http.post(f"/internal/knowledge/documents/{doc_id}/activate", headers={"X-Actor-Context": token()})
    assert r.status_code == 409 and r.json()["error"]["code"] == "LESSON_BUSY"


# ---- withdraw ------------------------------------------------------------------------------

async def test_withdraw_is_idempotent_and_reports_whether_anything_was_actually_withdrawn(dsn):
    lesson_id, _cohort_id = await _insert_lesson(dsn)
    doc_id = await _insert_document(dsn, lesson_id, 1, ["内容"])
    await _set_index_status(dsn, doc_id, "succeeded")
    c = Client(dsn)
    await c.http.post(f"/internal/knowledge/documents/{doc_id}/activate", headers={"X-Actor-Context": token()})

    r = await c.http.post(f"/internal/knowledge/documents/{doc_id}/withdraw", headers={"X-Actor-Context": token()})
    assert r.status_code == 200 and r.json() == {"withdrawn": True}

    r2 = await c.http.post(f"/internal/knowledge/documents/{doc_id}/withdraw", headers={"X-Actor-Context": token()})
    assert r2.status_code == 200 and r2.json() == {"withdrawn": False}

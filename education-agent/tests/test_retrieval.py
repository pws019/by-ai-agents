"""T-27：权限过滤 RAG、引用及无依据处理、服务端限制候选数（AC-013/015/018）。

复用 test_ingestion.py 的真实临时 Postgres + 真实本地 Qdrant + 真实本地 embedding 夹具
（dsn/store/embedder）——检索要在已经被 T-26 索引过的数据上跑，两边本来就该共用同一套
真实服务，不是各自发明一套 mock。`/me/enrollments` 用 httpx.MockTransport 控制返回值
（没有真实 education-api 在跑），这是本仓库其它地方（test_student_graph.py 等）一贯的
mock 业务 API 做法，跟"不 mock 向量/embedding"不矛盾——业务 API 的权限判断本身不是
T-27 要验证的东西，T-27 要验证的是"拿到权限范围之后，检索这一侧有没有正确使用它"。
"""
import time

import httpx
import psycopg
import pytest

from education_agent.ingestion import db
from education_agent.ingestion.pipeline import run_pending_jobs
from education_agent.retrieval.search import TOP_K, search_knowledge
from education_agent.tools.client import BusinessApi
from education_agent.tools.context import RunContext

from test_ingestion import _insert_document, _insert_lesson, dsn, embedder, pytestmark, store  # noqa: F401

TOKEN = "SECRET-SIGNED-TOKEN"


def _ctx() -> RunContext:
    return RunContext("student-1", "student", "req-1", int(time.time() + 60), TOKEN)


def _enrollment(cohort_id: str, status: str = "active") -> dict:
    return {"cohort": {"cohortId": cohort_id}, "status": status}


def _api(enrollments: list[dict]) -> BusinessApi:
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path.endswith("/me/enrollments"), req.url.path
        return httpx.Response(200, json={"items": enrollments})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://api.test")
    return BusinessApi(client, _ctx(), 5.0)


async def _index_and_activate(dsn, store, embedder, lesson_id, version, contents, visibility="private") -> str:
    doc_id = await _insert_document(dsn, lesson_id, version, contents, visibility=visibility)
    await db.enqueue_job(dsn, doc_id, "index")
    outcomes = await run_pending_jobs(dsn, store, embedder)
    assert all(o.ok for o in outcomes), outcomes
    await db.activate_document(dsn, doc_id)
    return doc_id


async def test_search_returns_citation_with_real_time_position_for_my_active_cohort(dsn, store, embedder):
    """AC-013：学员问知识点，拿到本期有效片段、原文引用及真实时间位置。"""
    lesson_id, cohort_id = await _insert_lesson(dsn)
    doc_id = await _insert_document(dsn, lesson_id, 1, ["冰箱压缩机不启动的常见原因是电源或温控器故障"])
    # 这段内容有真实的时间轴（像字幕那样），直接改 start_ms/end_ms 验证"真实时间位置"真的传出去了。
    async with await psycopg.AsyncConnection.connect(dsn) as conn, conn.cursor() as cur:
        await cur.execute("UPDATE app.knowledge_segments SET start_ms = 12000, end_ms = 18000 WHERE document_id = %s", (doc_id,))
        await conn.commit()
    await db.enqueue_job(dsn, doc_id, "index")
    outcomes = await run_pending_jobs(dsn, store, embedder)
    assert all(o.ok for o in outcomes), outcomes
    await db.activate_document(dsn, doc_id)

    result = await search_knowledge(
        embedder=embedder, store=store, dsn=dsn, api=_api([_enrollment(cohort_id)]), query="压缩机不启动怎么办"
    )

    assert result.has_evidence
    citation = result.citations[0]
    assert citation.lesson_id == lesson_id
    assert "压缩机" in citation.content
    assert (citation.start_ms, citation.end_ms) == (12000, 18000)
    # T-28 的 citation/replay.card 事件要用到的字段：source_id/source_version 对应 document，
    # segment_id 对应这一条具体片段，lesson_title 是 _insert_lesson 固定建出来的"第一课"。
    assert citation.source_id == doc_id
    assert citation.source_version == 1
    assert citation.lesson_title == "第一课"
    assert citation.segment_id


async def test_search_does_not_return_private_content_from_a_cohort_i_am_not_enrolled_in(dsn, store, embedder):
    """知识检索这一侧的权限边界——跟 AC-015 说的"本期学员看不到外班期受限文本"是同一条规则。"""
    lesson_id, _cohort_id = await _insert_lesson(dsn)
    await _index_and_activate(dsn, store, embedder, lesson_id, 1, ["冰箱压缩机不启动的常见原因是电源或温控器故障"], visibility="private")

    result = await search_knowledge(embedder=embedder, store=store, dsn=dsn, api=_api([]), query="压缩机不启动怎么办")

    assert not result.has_evidence


async def test_public_content_is_visible_even_without_any_enrollment(dsn, store, embedder):
    """visibility=public 的资料不受 cohort 范围限制（比如公开的退费政策讲义）。"""
    lesson_id, _cohort_id = await _insert_lesson(dsn)
    await _index_and_activate(dsn, store, embedder, lesson_id, 1, ["退费政策：开课前七天可全额退费"], visibility="public")

    result = await search_knowledge(embedder=embedder, store=store, dsn=dsn, api=_api([]), query="退费政策是什么")

    assert result.has_evidence


async def test_reports_no_evidence_instead_of_fabricating_when_nothing_matches(dsn, store, embedder):
    """AC-018：题目无知识覆盖，明确无依据，不编造片段。"""
    lesson_id, _cohort_id = await _insert_lesson(dsn)
    await _index_and_activate(dsn, store, embedder, lesson_id, 1, ["冰箱压缩机不启动的常见原因是电源或温控器故障"], visibility="public")

    result = await search_knowledge(embedder=embedder, store=store, dsn=dsn, api=_api([]), query="量子计算机的基本原理是什么")

    assert not result.has_evidence
    assert result.citations == ()


async def test_search_does_not_return_citations_from_a_withdrawn_document_even_though_vectors_still_exist(dsn, store, embedder):
    """跟 T-26 AC-016 是同一条规则，这里从检索这一侧验证：撤回立即生效，不等物理清理。"""
    lesson_id, _cohort_id = await _insert_lesson(dsn)
    doc_id = await _index_and_activate(dsn, store, embedder, lesson_id, 1, ["冰箱压缩机不启动的常见原因是电源或温控器故障"], visibility="public")

    assert await db.withdraw_document(dsn, doc_id) is True
    assert await store.count_by_document(doc_id) > 0, "撤回不等于物理清除：对照一下向量还在"

    result = await search_knowledge(embedder=embedder, store=store, dsn=dsn, api=_api([]), query="压缩机不启动怎么办")

    assert not result.has_evidence


async def test_candidate_count_is_capped_server_side_regardless_of_how_much_matches(dsn, store, embedder):
    """服务端限制候选数：不管实际有多少条内容足够相关，返回的引用数不会超过 TOP_K——
    这个上限是代码里的常量，不是模型能通过参数影响的东西（SearchKnowledgeArgs 根本没有这个字段）。
    """
    lesson_id, _cohort_id = await _insert_lesson(dsn)
    contents = [f"冰箱压缩机常见故障第{i}种：温控器老化导致启动异常" for i in range(TOP_K + 3)]
    await _index_and_activate(dsn, store, embedder, lesson_id, 1, contents, visibility="public")

    result = await search_knowledge(embedder=embedder, store=store, dsn=dsn, api=_api([]), query="冰箱压缩机常见故障")

    assert result.has_evidence
    assert len(result.citations) <= TOP_K


async def test_search_knowledge_tool_puts_citations_in_artifacts_shaped_exactly_like_the_sse_event(dsn, store, embedder):
    """T-28：searchKnowledge 工具的 artifacts["citations"] 要跟
    contracts/education/events.schema.json 的 citation payload 完全一致（sourceId/sourceVersion/
    title/segmentId/startSeconds/endSeconds，additionalProperties:false，多一个少一个键都不行）——
    这是 graphs/loop.py 直接 `emit({"type": "citation", **citation})` 的前提。
    """
    from education_agent.tools.contracts import SearchKnowledgeArgs, build_search_knowledge_spec

    lesson_id, cohort_id = await _insert_lesson(dsn)
    doc_id = await _insert_document(dsn, lesson_id, 1, ["冰箱压缩机不启动的常见原因是电源或温控器故障"])
    async with await psycopg.AsyncConnection.connect(dsn) as conn, conn.cursor() as cur:
        await cur.execute("UPDATE app.knowledge_segments SET start_ms = 12000, end_ms = 18000 WHERE document_id = %s", (doc_id,))
        await conn.commit()
    await db.enqueue_job(dsn, doc_id, "index")
    outcomes = await run_pending_jobs(dsn, store, embedder)
    assert all(o.ok for o in outcomes), outcomes
    await db.activate_document(dsn, doc_id)

    spec = build_search_knowledge_spec(embedder, store, dsn)
    output = await spec.handler(_api([_enrollment(cohort_id)]), SearchKnowledgeArgs(query="压缩机不启动怎么办"))

    assert output.data["found"] is True
    [citation] = output.artifacts["citations"]
    assert citation == {
        "sourceId": doc_id,
        "sourceVersion": 1,
        "title": "第一课",
        "segmentId": citation["segmentId"],  # 只断言存在且是唯一一条，不是具体值（UUID 随机生成）
        "startSeconds": 12.0,
        "endSeconds": 18.0,
    }
    assert set(citation.keys()) == {"sourceId", "sourceVersion", "title", "segmentId", "startSeconds", "endSeconds"}

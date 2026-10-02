"""T-29：RAG 基线评估。固定数据集在 evals/education/rag_baseline/cases.json（仓库根目录下的
evals/education/，design.md §1 列的"固定数据集、断言、实验配置及报告说明"）；这个脚本是跑这份
数据集需要的 education_agent 依赖，放在这个包里，不是放进 education-agent/tests/——
两者目的不同：tests/ 验证"编排对不对"（T-26/T-27 已经覆盖），这里验证"给定一批真实会问的问题，
检索答得怎么样"，并把结果写成一份带时间戳的报告，供以后同一批 case 跑出新结果时横向对比。

合成数据，不是真实课程内容——跟 cases.json 里写的一样，不声称这是对真实课程检索效果的评估
（tasks.md 的风险与停止条件："没有真实字幕：先用合成样例跑通，不声称完成真实课程检索评估"）。

运行：cd education-agent && PYTHONPATH=src uv run python -m education_agent.evals.rag_baseline
需要本地 Postgres（npm run edu:infra）、本地 Qdrant（同上）、本地 embedding
（npm run dev --workspace=customer-embedding-demo）——跟 tests/test_retrieval.py 同一组依赖，
不是额外发明一套。
"""
import asyncio
import hashlib
import json
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx
import psycopg
from qdrant_client import AsyncQdrantClient

from ..config import DATABASE_URL, QDRANT_URL
from ..embedding.openai_embedder import create_openai_embedder
from ..ingestion import db
from ..ingestion.pipeline import run_pending_jobs
from ..ingestion.vector_store import VectorStore
from ..retrieval.search import search_knowledge
from ..tools.client import BusinessApi
from ..tools.context import RunContext

REPO_ROOT = Path(__file__).resolve().parents[4]
EVAL_DIR = REPO_ROOT / "evals" / "education" / "rag_baseline"
MIGRATIONS_DIR = REPO_ROOT / "education-api" / "src" / "db" / "migrations"
EMBEDDING_URL = "http://127.0.0.1:8080"
TOKEN = "SECRET-SIGNED-TOKEN"  # BusinessApi 要求有个值；/me/enrollments 在这里被假的 transport 接管，值本身不参与判断


def _with_db(url: str, name: str) -> str:
    parts = urlsplit(url)
    return urlunsplit(parts._replace(path=f"/{name}"))


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass
class CaseResult:
    case_id: str
    description: str
    passed: bool
    detail: str


def _ctx() -> RunContext:
    return RunContext("eval-student", "student", "eval-req", int(time.time()) + 300, TOKEN)


def _api_with_cohort(cohort_id: str) -> BusinessApi:
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path.endswith("/me/enrollments"), req.url.path
        return httpx.Response(200, json={"items": [{"cohort": {"cohortId": cohort_id}, "status": "active"}]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://api.eval")
    return BusinessApi(client, _ctx(), 30.0)


async def _insert_lesson_with_document(conn: psycopg.AsyncConnection, title: str, contents: list[str]) -> tuple[str, str, str]:
    """建最小链路 course→course_version→cohort→lesson，再插入一个 document+segments（version=1）。
    返回 (lesson_id, cohort_id, document_id)。"""
    async with conn.cursor() as cur:
        await cur.execute("INSERT INTO app.courses (title) VALUES ('RAG 基线评估合成课程') RETURNING id")
        course_id = (await cur.fetchone())[0]
        await cur.execute("INSERT INTO app.course_versions (course_id, version) VALUES (%s, 1) RETURNING id", (course_id,))
        version_id = (await cur.fetchone())[0]
        await cur.execute(
            "INSERT INTO app.cohorts (course_id, course_version_id, name, currency, status) VALUES (%s, %s, '评估班期', 'CNY', 'running') RETURNING id",
            (course_id, version_id),
        )
        cohort_id = (await cur.fetchone())[0]
        await cur.execute("INSERT INTO app.lessons (cohort_id, title, position) VALUES (%s, %s, 1) RETURNING id", (cohort_id, title))
        lesson_id = (await cur.fetchone())[0]
        document_id = await _insert_document(conn, str(lesson_id), 1, contents)
        return str(lesson_id), str(cohort_id), document_id


async def _insert_document(conn: psycopg.AsyncConnection, lesson_id: str, version: int, contents: list[str]) -> str:
    async with conn.cursor() as cur:
        await cur.execute(
            "INSERT INTO app.knowledge_documents (lesson_id, kind, source_name, source_hash, version) VALUES (%s,'markdown','eval.md',%s,%s) RETURNING id",
            (lesson_id, _sha256(f"{lesson_id}-{version}-{''.join(contents)}"), version),
        )
        document_id = str((await cur.fetchone())[0])
        for position, content in enumerate(contents):
            await cur.execute(
                "INSERT INTO app.knowledge_segments (document_id, position, content, content_hash) VALUES (%s,%s,%s,%s)",
                (document_id, position, content, _sha256(content)),
            )
        await conn.commit()
        return document_id


async def _run_query_cases(dsn: str, store: VectorStore, embedder, cases: list[dict]) -> list[CaseResult]:
    results = []
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        for case in cases:
            lesson_id, cohort_id, document_id = await _insert_lesson_with_document(conn, case["lessonTitle"], case["documentContents"])
            await db.enqueue_job(dsn, document_id, "index")
            outcomes = await run_pending_jobs(dsn, store, embedder)
            if not all(o.ok for o in outcomes):
                results.append(CaseResult(case["id"], case["description"], False, f"索引失败：{outcomes}"))
                continue
            await db.activate_document(dsn, document_id)

            result = await search_knowledge(embedder=embedder, store=store, dsn=dsn, api=_api_with_cohort(cohort_id), query=case["query"])
            expect_evidence = case["expectHasEvidence"]
            if result.has_evidence != expect_evidence:
                results.append(CaseResult(
                    case["id"], case["description"], False,
                    f"期望 has_evidence={expect_evidence}，实际={result.has_evidence}",
                ))
                continue
            if expect_evidence and "expectContentContains" in case:
                joined = " ".join(c.content for c in result.citations)
                if case["expectContentContains"] not in joined:
                    results.append(CaseResult(case["id"], case["description"], False, f"引用文本里没有找到 {case['expectContentContains']!r}"))
                    continue
            results.append(CaseResult(case["id"], case["description"], True, "通过"))
    return results


async def _run_traceability_case(dsn: str, store: VectorStore, embedder) -> CaseResult:
    """对应 T-29 的验收项本身："更新资料后新答案可追溯版本"——不是数据集里的一条 query 断言，
    是一个独立的多步场景：v1 写错的说法 → 发布 v1 → 问一遍，拿到的引用确实指向 v1 → 导入并发布
    修正过的 v2（会原子撤回 v1）→ 再问一遍同样的问题，引用必须指向 v2，不能还停在 v1。
    """
    case_id, description = "version-traceability", "更新资料后新答案可追溯到新版本（T-29 验收项）"
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        lesson_id, cohort_id, doc_v1 = await _insert_lesson_with_document(
            conn, "第 5 课：退费政策", ["退费政策（旧）：开课后一律不退费。"],
        )
    await db.enqueue_job(dsn, doc_v1, "index")
    outcomes = await run_pending_jobs(dsn, store, embedder)
    if not all(o.ok for o in outcomes):
        return CaseResult(case_id, description, False, f"v1 索引失败：{outcomes}")
    await db.activate_document(dsn, doc_v1)

    api = _api_with_cohort(cohort_id)
    first = await search_knowledge(embedder=embedder, store=store, dsn=dsn, api=api, query="退费政策是什么")
    if not first.has_evidence or first.citations[0].source_id != doc_v1:
        return CaseResult(case_id, description, False, f"v1 发布后应该引用 v1（{doc_v1}），实际 {first.citations}")

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        doc_v2 = await _insert_document(conn, lesson_id, 2, ["退费政策（新）：开课前七天可全额退费。"])
    await db.enqueue_job(dsn, doc_v2, "index")
    outcomes = await run_pending_jobs(dsn, store, embedder)
    if not all(o.ok for o in outcomes):
        return CaseResult(case_id, description, False, f"v2 索引失败：{outcomes}")
    await db.activate_document(dsn, doc_v2)  # 原子撤回 v1、激活 v2

    second = await search_knowledge(embedder=embedder, store=store, dsn=dsn, api=api, query="退费政策是什么")
    if not second.has_evidence or second.citations[0].source_id != doc_v2 or second.citations[0].source_version != 2:
        return CaseResult(case_id, description, False, f"v2 发布后应该引用 v2（{doc_v2}, version=2），实际 {second.citations}")
    if "七天" not in second.citations[0].content:
        return CaseResult(case_id, description, False, "引用内容不是更新后的文本")
    return CaseResult(case_id, description, True, "通过：v1→v2 之后新答案正确追溯到 v2")


def _write_report(results: list[CaseResult], embedder_model: str) -> Path:
    report_dir = EVAL_DIR / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = report_dir / f"{timestamp}.md"
    passed = sum(1 for r in results if r.passed)
    lines = [
        f"# RAG 基线评估报告 {timestamp}",
        "",
        f"embedding 模型：{embedder_model}（本地真实服务，不是 mock）。合成数据，见 cases.json 的 note。",
        "",
        f"结果：{passed}/{len(results)} 通过",
        "",
        "| case | 结论 | 说明 |",
        "|---|---|---|",
    ]
    for r in results:
        lines.append(f"| {r.case_id}（{r.description}） | {'PASS' if r.passed else 'FAIL'} | {r.detail} |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


async def main() -> int:
    cases = json.loads((EVAL_DIR / "cases.json").read_text("utf-8"))["cases"]

    name = f"edu_eval_{uuid.uuid4().hex[:12]}"
    admin = await psycopg.AsyncConnection.connect(_with_db(DATABASE_URL, "postgres"), autocommit=True)
    await admin.execute(f"CREATE DATABASE {name}")
    dsn = _with_db(DATABASE_URL, name)
    sql = "\n".join(MIGRATIONS_DIR.joinpath(f).read_text("utf-8") for f in sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql")))
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        await conn.execute("CREATE SCHEMA IF NOT EXISTS app")
        await conn.execute("SET search_path = app")
        await conn.execute(sql)
        await conn.commit()

    embedder = create_openai_embedder(EMBEDDING_URL, "", "Qwen/Qwen3-Embedding-0.6B", 1024)
    collection = f"rag_baseline_eval_{uuid.uuid4().hex[:12]}"
    client = AsyncQdrantClient(url=QDRANT_URL)
    store = VectorStore(client, collection, dimension=1024)

    try:
        results = await _run_query_cases(dsn, store, embedder, cases)
        results.append(await _run_traceability_case(dsn, store, embedder))
    finally:
        await client.delete_collection(collection)
        await admin.execute(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s", (name,))
        await admin.execute(f"DROP DATABASE {name}")
        await admin.close()

    report_path = _write_report(results, "Qwen/Qwen3-Embedding-0.6B (local)")
    for r in results:
        print(f"{'PASS' if r.passed else 'FAIL'}  {r.case_id}: {r.detail}")
    print(f"\n报告已写入 {report_path}")
    return 0 if all(r.passed for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

"""Agent 的 HTTP/SSE 入口：验签、线程隔离、事件序列、恢复、错误脱敏。
图用 ScriptedModel + mock 业务 API（复用 test_student_graph 的 Harness），走真实的 FastAPI 应用（ASGI，不起端口）。
"""
import json
import time
import uuid
from pathlib import Path

import httpx
import pytest
from jsonschema import Draft202012Validator
from langgraph.checkpoint.memory import InMemorySaver

from education_agent.graphs.student_graph import REPLY_NEEDS_CONFIRMATION
from education_agent.model.base import ModelReply
from education_agent.server import create_app

from test_context import sign
from test_student_graph import CONFIRMATION_ID, DRAFT_SCRIPT, ENROLLMENT, Harness, call, route

SECRET = "server-test-secret"
CONVERSATION = str(uuid.UUID(int=7))


def token(actor: str = "student-1", *, secret: str = SECRET, run_id: str = "run-1", exp: int | None = None) -> str:
    return sign({"actorId": actor, "role": "student", "requestId": run_id, "exp": exp or int(time.time()) + 60}, secret)


def parse_sse(text: str) -> list[dict]:
    return [json.loads(line[len("data: "):]) for line in text.splitlines() if line.startswith("data: ")]


class Client:
    def __init__(self, h: Harness):
        self.h = h
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(h.graph, SECRET)), base_url="http://agent.test")

    async def run(self, body: dict, tok: str | None = None, conversation: str = CONVERSATION):
        headers = {"X-Actor-Context": tok} if tok is not None else {}
        return await self.http.post("/internal/runs", json={"conversationId": conversation, **body}, headers=headers)


def make(replies: list[ModelReply]) -> Client:
    return Client(Harness(replies, checkpointer=InMemorySaver()))


# ---- 认证 ---------------------------------------------------------------------------------

@pytest.mark.parametrize("bad", [None, "", "garbage", "a.b"])
async def test_missing_or_malformed_context_is_rejected_before_anything_runs(bad):
    c = make([])
    r = await c.run({"text": "hi"}, bad)
    assert r.status_code == 401 and r.json() == {"error": {"code": "UNAUTHENTICATED"}}
    assert c.h.model.calls == [] and c.h.requests == []


async def test_wrong_secret_and_expired_context_are_rejected():
    c = make([])
    assert (await c.run({"text": "hi"}, token(secret="other"))).status_code == 401
    assert (await c.run({"text": "hi"}, token(exp=int(time.time()) - 5))).status_code == 401
    assert c.h.model.calls == []


@pytest.mark.parametrize("body", [{}, {"text": "hi", "resume": True}, {"text": ""}])
async def test_request_must_have_exactly_one_of_text_or_resume(body):
    r = await make([]).run(body, token())
    assert r.status_code == 422


# ---- 事件流 -------------------------------------------------------------------------------

async def test_query_run_streams_tool_status_deltas_and_ends_with_the_full_text():
    c = make([route("query"), ModelReply(tool_calls=(call("getMyEnrollment", {}),)), ModelReply(text="你的下一课是第 2 课。")])
    r = await c.run({"text": "我下节课是什么？"}, token(run_id="run-42"))
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(r.text)

    assert [e["eventId"] for e in events] == [str(n) for n in range(1, len(events) + 1)]
    assert {e["runId"] for e in events} == {"run-42"} and {e["conversationId"] for e in events} == {CONVERSATION}
    assert events[-1]["type"] == "message.completed" and events[-1]["payload"] == {"text": "你的下一课是第 2 课。"}
    assert [e["payload"] for e in events if e["type"] == "tool.status"] == [
        {"tool": "getMyEnrollment", "status": "started"}, {"tool": "getMyEnrollment", "status": "succeeded"}]
    assert "".join(e["payload"]["text"] for e in events if e["type"] == "message.delta") == "你的下一课是第 2 课。"
    assert sum(e["type"] == "message.completed" for e in events) == 1
    assert c.h.requests[0].headers["X-Actor-Context"] == token(run_id="run-42"), "业务 API 收到的就是 BFF 签发的那张工作证"


async def test_draft_run_emits_the_confirmation_card_then_completes_and_never_submits():
    c = make(list(DRAFT_SCRIPT))
    events = parse_sse((await c.run({"text": "我想转班"}, token())).text)
    types = [e["type"] for e in events]
    assert types[-2:] == ["application.confirmation", "message.completed"]
    assert events[-2]["payload"]["confirmationId"] == CONFIRMATION_ID
    assert events[-1]["payload"]["text"] == REPLY_NEEDS_CONFIRMATION
    assert [r.method for r in c.h.requests] == ["POST"], "只有创建草稿的请求，没有确认/提交"


# ---- 恢复 ---------------------------------------------------------------------------------

async def test_resume_reports_the_real_state_and_cannot_be_repeated():
    c = make(list(DRAFT_SCRIPT))
    await c.run({"text": "我想转班"}, token())
    c.h.application.update(status="submitted")

    events = parse_sse((await c.run({"resume": True}, token(run_id="run-2"))).text)
    assert events[-1]["type"] == "message.completed" and events[-1]["payload"]["text"] == "你的申请已提交，等待老师处理。"
    assert events[-1]["runId"] == "run-2", "恢复用的是这次请求带来的新工作证"

    again = await c.run({"resume": True}, token())
    assert again.status_code == 409 and again.json()["error"]["code"] == "NOT_AWAITING_CONFIRMATION"


async def test_resume_with_nothing_pending_is_a_plain_409_not_an_empty_stream():
    r = await make([]).run({"resume": True}, token())
    assert r.status_code == 409


# ---- 线程隔离 -----------------------------------------------------------------------------

async def test_another_actor_with_the_same_conversation_id_gets_a_different_thread():
    c = make([*DRAFT_SCRIPT, route("query"), ModelReply(text="你好")])
    await c.run({"text": "我想转班"}, token("student-1"))

    # student-2 用同一个 conversationId：看不到 student-1 挂起的确认，也看不到 student-1 的对话历史。
    assert (await c.run({"resume": True}, token("student-2"))).status_code == 409
    await c.run({"text": "你好"}, token("student-2"))
    seen_by_student_2 = json.dumps(c.h.model.calls[-1][0], ensure_ascii=False)
    assert "我想转班" not in seen_by_student_2

    # student-1 的确认仍然挂着，没被 student-2 动过。
    c.h.application.update(status="submitted")
    assert (await c.run({"resume": True}, token("student-1"))).status_code == 200


# ---- 错误与脱敏 ---------------------------------------------------------------------------

class ExplodingModel:
    async def chat(self, messages, tools, on_text=None):
        raise RuntimeError("db connect failed: postgresql://edu:SECRET-PASSWORD@10.0.0.5/education")


async def test_failure_becomes_a_fixed_error_event_with_no_details():
    h = Harness([], checkpointer=InMemorySaver())
    h.model = ExplodingModel()
    from education_agent.graphs.student_graph import build_student_graph
    from education_agent.tools.contracts import TOOL_SPECS
    from education_agent.tools.runtime import ToolRuntime

    graph = build_student_graph(h.model, ToolRuntime(TOOL_SPECS, httpx.AsyncClient(base_url="http://api.test")), InMemorySaver())
    c = Client(h)
    c.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(graph, SECRET)), base_url="http://agent.test")

    r = await c.run({"text": "hi"}, token(run_id="run-9"))
    events = parse_sse(r.text)
    assert events[-1] == {"eventId": "1", "conversationId": CONVERSATION, "runId": "run-9", "type": "run.error",
                          "payload": {"code": "INTERNAL", "message": "服务暂时出错，请稍后重试。"}}
    assert "SECRET-PASSWORD" not in r.text and "postgresql" not in r.text
    assert not any(e["type"] == "message.completed" for e in events)


async def test_stream_never_contains_the_token():
    c = make([*DRAFT_SCRIPT])
    tok = token()
    r = await c.run({"text": "我想转班"}, tok)
    assert tok not in r.text and tok.split(".")[0] not in r.text


# ---- 删除线程（progress.md 已知局限第 6 层）------------------------------------------------

async def test_delete_thread_requires_a_valid_token():
    c = make([])
    r = await c.http.delete(f"/internal/threads/{CONVERSATION}")
    assert r.status_code == 401
    r = await c.http.delete(f"/internal/threads/{CONVERSATION}", headers={"X-Actor-Context": "garbage"})
    assert r.status_code == 401


async def test_delete_thread_removes_the_state_and_is_idempotent():
    c = make([route("query"), ModelReply(text="ok")])
    tok = token()
    await c.run({"text": "你好"}, tok)
    config = {"configurable": {"thread_id": f"student-1:{CONVERSATION}"}}
    assert (await c.h.graph.aget_state(config)).values, "对照：删除前确实有状态"

    r = await c.http.delete(f"/internal/threads/{CONVERSATION}", headers={"X-Actor-Context": tok})
    assert r.status_code == 204
    assert (await c.h.graph.aget_state(config)).values == {}

    # 线程本来就不存在（或已经删过一次）也应该照样成功，不泄露"这个线程存不存在"。
    r = await c.http.delete(f"/internal/threads/{CONVERSATION}", headers={"X-Actor-Context": tok})
    assert r.status_code == 204


async def test_delete_thread_only_touches_the_callers_own_thread():
    c = make([route("query"), ModelReply(text="ok"), route("query"), ModelReply(text="ok2")])
    await c.run({"text": "student-1 的话"}, token("student-1"))
    await c.run({"text": "student-2 的话"}, token("student-2"))

    await c.http.delete(f"/internal/threads/{CONVERSATION}", headers={"X-Actor-Context": token("student-1")})

    config_1 = {"configurable": {"thread_id": f"student-1:{CONVERSATION}"}}
    config_2 = {"configurable": {"thread_id": f"student-2:{CONVERSATION}"}}
    assert (await c.h.graph.aget_state(config_1)).values == {}
    assert (await c.h.graph.aget_state(config_2)).values, "另一个 actor 的线程不该被动到"


async def test_delete_thread_failure_maps_to_dependency_unavailable(monkeypatch):
    c = make([])

    async def boom(_thread_id):
        raise RuntimeError("db unavailable")

    monkeypatch.setattr(c.h.graph.checkpointer, "adelete_thread", boom)
    r = await c.http.delete(f"/internal/threads/{CONVERSATION}", headers={"X-Actor-Context": token()})
    assert r.status_code == 503 and r.json()["error"]["code"] == "DEPENDENCY_UNAVAILABLE"


# ---- 与契约一致 ---------------------------------------------------------------------------

CONTRACT = Path(__file__).resolve().parents[2] / "contracts" / "education" / "events.schema.json"


def contract_errors(events: list[dict]) -> list[str]:
    """用契约里的 JSON Schema 校验每个事件。契约是唯一来源，这里不另写一份形状定义。
    唯一的差别：契约的 message.completed 要求 messageId，那是 BFF 落库后才有的，Agent 这一跳补一个占位再校验。"""
    validator = Draft202012Validator(json.loads(CONTRACT.read_text(encoding="utf-8")))
    errors = []
    for e in events:
        if e["type"] == "message.completed":
            e = {**e, "payload": {**e["payload"], "messageId": "filled-by-bff"}}
        errors += [f'{e["type"]}: {err.message}' for err in validator.iter_errors(e)]
    return errors


async def test_every_event_kind_the_agent_emits_conforms_to_the_contract_schema():
    query = parse_sse((await make([route("query"), ModelReply(tool_calls=(call("getMyEnrollment", {}),)), ModelReply(text="你的下一课是第 2 课。")])
                       .run({"text": "课表"}, token())).text)
    draft = parse_sse((await make(list(DRAFT_SCRIPT)).run({"text": "我想转班"}, token())).text)
    kinds = {e["type"] for e in query + draft}
    assert kinds == {"message.delta", "tool.status", "application.confirmation", "message.completed"}, "这个测试应当覆盖到 Agent 会发的全部正常事件类型"
    assert contract_errors(query + draft) == []


async def test_run_error_event_conforms_to_the_contract_schema():
    from education_agent.graphs.student_graph import build_student_graph
    from education_agent.tools.contracts import TOOL_SPECS
    from education_agent.tools.runtime import ToolRuntime

    h = Harness([], checkpointer=InMemorySaver())
    graph = build_student_graph(ExplodingModel(), ToolRuntime(TOOL_SPECS, httpx.AsyncClient(base_url="http://api.test")), InMemorySaver())
    c = Client(h)
    c.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(graph, SECRET)), base_url="http://agent.test")
    events = parse_sse((await c.run({"text": "hi"}, token())).text)
    assert [e["type"] for e in events] == ["run.error"] and contract_errors(events) == []

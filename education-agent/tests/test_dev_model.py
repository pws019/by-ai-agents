"""开发用假模型（DemoModel）与服务入口配置。假模型放进真实的图里、面对与真实业务 API 同形状的响应跑各条路径；
它通过只能说明"编排和界面用得上它"，不代表真实模型的效果。
"""
import json
import time

import httpx
import pytest
from langgraph.checkpoint.memory import InMemorySaver

from education_agent.dev_model import DemoModel
from education_agent.graphs.student_graph import REPLY_NEEDS_CONFIRMATION, RunScope, build_student_graph
from education_agent.main import ConfigError, Settings, build_model, load_settings
from education_agent.tools.context import RunContext
from education_agent.tools.contracts import TOOL_SPECS
from education_agent.tools.runtime import ToolRuntime
from education_agent.tools.spec import RunBudget

ENROLLMENT = "00000000-0000-0000-0000-000000000501"
COHORT_NEW = "00000000-0000-0000-0000-0000000000f3"
APP = "00000000-0000-0000-0000-000000000a01"


class Api:
    """与真实业务 API 同形状的响应；可配置目标班期、起草是否被拒。"""

    def __init__(self, *, targets=True, enrollments=None, draft_conflict=False, fail_all=False):
        self.requests: list[httpx.Request] = []
        self.targets, self.draft_conflict, self.fail_all = targets, draft_conflict, fail_all
        self.enrollments = enrollments if enrollments is not None else [
            {"enrollmentId": ENROLLMENT, "status": "active", "cohort": {"cohortId": "c1", "name": "AI 训练营 2026 春", "startAt": None}}
        ]

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.requests.append(req)
        p = req.url.path
        if self.fail_all:
            return httpx.Response(500, json={"error": {"code": "INTERNAL"}})
        if p.endswith("/me/enrollments"):
            return httpx.Response(200, json={"items": self.enrollments})
        if p.endswith("/schedule"):
            return httpx.Response(200, json={"items": [{"lessonId": f"L{i}", "title": t} for i, t in enumerate(["环境与基础", "模型训练入门", "微调实战", "评估"])]})
        if p.endswith("/progress"):
            return httpx.Response(200, json={"items": [{"lessonId": "L0", "status": "completed"}, {"lessonId": "L1", "status": "in_progress"}]})
        if p.endswith("/transfer-targets"):
            return httpx.Response(200, json={"items": [{"cohortId": COHORT_NEW, "name": "AI 训练营 2026 夏", "startAt": None}] if self.targets else []})
        if p.endswith("/catalog/current"):
            return httpx.Response(200, json={"cohortId": "c1", "title": "AI 全栈工程师训练营", "priceCents": 1299900, "currency": "CNY"})
        if p.endswith("/me/applications"):
            return httpx.Response(200, json={"items": [{"id": APP, "type": "transfer", "status": "approved", "executionStatus": "completed", "revision": 3, "summary": {}}]})
        if p.endswith("/applications/drafts"):
            if self.draft_conflict:
                return httpx.Response(409, json={"error": {"code": "INVALID_STATE"}})
            return httpx.Response(201, json={
                "id": APP, "revision": 1, "status": "draft", "summary": json.loads(req.content),
                "confirmation": {"confirmationId": "00000000-0000-0000-0000-00000000c0f1", "applicationId": APP, "revision": 1,
                                 "expiresAt": "2030-01-01T00:00:00.000Z", "summary": json.loads(req.content)},
            })
        return httpx.Response(404, json={"error": {"code": "NOT_FOUND"}})

    def paths(self) -> list[str]:
        return [f"{r.method} {r.url.path.removeprefix('/api/v1')}" for r in self.requests]


def make(api: Api, **model_kwargs):
    http = httpx.AsyncClient(transport=httpx.MockTransport(api), base_url="http://api.test")
    return build_student_graph(DemoModel(stream_delay=0, **model_kwargs), ToolRuntime(TOOL_SPECS, http), InMemorySaver())


async def say(graph, text: str, thread: str = "t1"):
    ctx = RunContext("s1", "student", "req-1", int(time.time()) + 60, "TOKEN")
    return await graph.ainvoke({"messages": [{"role": "user", "content": text}]}, {"configurable": {"thread_id": thread}}, context=RunScope(ctx, RunBudget()))


# ---- query -------------------------------------------------------------------------------

async def test_schedule_question_chains_enrollment_then_schedule_and_answers_from_the_data():
    api = Api()
    out = await say(make(api), "我的课表是什么？")
    assert api.paths() == ["GET /me/enrollments", f"GET /me/enrollments/{ENROLLMENT}/schedule"]
    assert out["stop_reason"] == "answered" and "「环境与基础」" in out["reply"] and "共 4 节课" in out["reply"]


@pytest.mark.parametrize("text,last_path,expect", [
    ("我学到哪了？", f"GET /me/enrollments/{ENROLLMENT}/progress", "已完成 1 节，进行中 1 节"),
    ("有哪些可转入的班期？", "GET /cohorts/transfer-targets", "AI 训练营 2026 夏"),
    ("现在的招生价格是多少", "GET /catalog/current", "12999 元"),
    ("我的申请怎么样了", "GET /me/applications", "转班（已批准）"),
    ("我有哪些报名", "GET /me/enrollments", "共有 1 个报名"),
])
async def test_other_query_kinds_use_the_expected_tool_and_answer_from_data(text, last_path, expect):
    api = Api()
    out = await say(make(api), text)
    assert api.paths()[-1] == last_path
    assert expect in out["reply"], out["reply"]


async def test_reply_is_streamed_in_pieces_that_add_up_to_the_final_text():
    graph = make(Api(), chunk_size=3)
    ctx = RunContext("s1", "student", "req-1", int(time.time()) + 60, "TOKEN")
    events = [e async for e in graph.astream({"messages": [{"role": "user", "content": "我有哪些报名"}]}, {"configurable": {"thread_id": "s"}},
                                             context=RunScope(ctx, RunBudget()), stream_mode="custom")]
    deltas = [e["text"] for e in events if e["type"] == "message.delta"]
    assert len(deltas) > 3 and all(len(d) <= 3 for d in deltas)
    final = (await graph.aget_state({"configurable": {"thread_id": "s"}})).values["reply"]
    assert "".join(deltas) == final


async def test_a_tool_error_gets_a_fixed_apology_instead_of_a_retry_loop():
    api = Api(fail_all=True)
    out = await say(make(api), "我的课表")
    assert "出了点问题" in out["reply"] and len(api.requests) == 1


async def test_no_active_enrollment_is_explained():
    api = Api(enrollments=[{"enrollmentId": ENROLLMENT, "status": "ended", "cohort": {"cohortId": "c1", "name": "旧班", "startAt": None}}])
    assert "没有在读的报名" in (await say(make(api), "我的课表"))["reply"]


# ---- application -------------------------------------------------------------------------

async def test_refund_request_drafts_and_stops_at_the_confirmation_card():
    api = Api()
    out = await say(make(api), "我想退费，时间冲突")
    assert api.paths() == ["GET /me/enrollments", "POST /applications/drafts"]
    body = json.loads(api.requests[-1].content)
    assert body == {"type": "refund", "enrollmentId": ENROLLMENT, "reason": "我想退费，时间冲突", "targetCohortId": None}
    assert out["stop_reason"] == "needs_confirmation" and out["reply"] == REPLY_NEEDS_CONFIRMATION
    assert out["__interrupt__"][0].value["confirmation"]["applicationId"] == APP


async def test_transfer_request_looks_up_targets_then_drafts_with_the_first_target():
    api = Api()
    out = await say(make(api), "我想转班")
    assert api.paths() == ["GET /me/enrollments", "GET /cohorts/transfer-targets", "POST /applications/drafts"]
    assert json.loads(api.requests[-1].content)["targetCohortId"] == COHORT_NEW
    assert out["stop_reason"] == "needs_confirmation"


async def test_transfer_with_no_available_target_explains_and_does_not_draft():
    api = Api(targets=False)
    out = await say(make(api), "我想转班")
    assert "没有可以转入的班期" in out["reply"] and not any("drafts" in p for p in api.paths())


async def test_draft_rejected_by_the_business_api_is_explained_without_retrying():
    api = Api(draft_conflict=True)
    out = await say(make(api), "我想退费")
    assert "进行中的同类申请" in out["reply"]
    assert sum("drafts" in p for p in api.paths()) == 1


@pytest.mark.parametrize("text", ["我的申请怎么样了", "我的退费进度怎么样了", "转班申请批了吗", "退费申请的状态"])
async def test_asking_about_an_existing_application_never_creates_a_draft(text):
    api = Api()
    out = await say(make(api), text)
    assert out["branch"] == "query" and "GET /me/applications" in api.paths()
    assert not any("drafts" in p for p in api.paths())


# ---- 多轮与分类 ---------------------------------------------------------------------------

async def test_tool_call_ids_stay_unique_across_turns_of_one_conversation():
    graph = make(Api())
    await say(graph, "我有哪些报名")
    out = await say(graph, "我的课表")
    ids = [c["id"] for m in out["messages"] if m["role"] == "assistant" for c in m.get("tool_calls", [])]
    assert len(ids) == len(set(ids)) >= 3


async def test_classification_uses_only_the_latest_user_message():
    graph = make(Api())
    first = await say(graph, "我想退费")
    assert first["branch"] == "application"
    second = await say(graph, "我的课表")
    assert second["branch"] == "query"


# ---- 服务入口配置 -------------------------------------------------------------------------

def test_defaults_to_mock_mode_and_builds_the_demo_model():
    s = load_settings({"INTERNAL_AUTH_SECRET": "x"})
    assert (s.mode, s.port, s.business_api_url) == ("mock", 8500, "http://127.0.0.1:8400")
    assert isinstance(build_model(s), DemoModel)


def test_missing_secret_fails_at_startup_not_at_first_request():
    with pytest.raises(ConfigError, match="INTERNAL_AUTH_SECRET"):
        load_settings({})


def test_unknown_mode_and_bad_port_are_rejected():
    with pytest.raises(ConfigError, match="EDUCATION_MODE"):
        load_settings({"INTERNAL_AUTH_SECRET": "x", "EDUCATION_MODE": "prod"})
    with pytest.raises(ConfigError, match="AGENT_PORT"):
        load_settings({"INTERNAL_AUTH_SECRET": "x", "AGENT_PORT": "abc"})


def test_real_mode_requires_all_model_settings_and_names_the_missing_ones():
    base = {"INTERNAL_AUTH_SECRET": "x", "EDUCATION_MODE": "real"}
    with pytest.raises(ConfigError, match="MODEL_BASE_URL.*MODEL_API_KEY.*MODEL_NAME"):
        load_settings(base)
    with pytest.raises(ConfigError, match="MODEL_NAME") as e:
        load_settings({**base, "MODEL_BASE_URL": "http://m/v1", "MODEL_API_KEY": "k"})
    assert "MODEL_BASE_URL" not in str(e.value)
    s = load_settings({**base, "MODEL_BASE_URL": "http://m/v1", "MODEL_API_KEY": "k", "MODEL_NAME": "qwen"})
    assert type(build_model(s)).__name__ == "LangChainChatModel"

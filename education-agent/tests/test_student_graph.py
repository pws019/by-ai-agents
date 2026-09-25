"""学员服务图 + 内层 ReAct 循环的编排测试（mock 模型 + mock 业务 API）。
mock 模型只能证明"编排是对的"（该走哪条分支、该停在哪、谁被拒绝），不能证明真实模型答得好。
"""
import json
import time
from dataclasses import replace

import httpx
import pytest
from langgraph.checkpoint.memory import InMemorySaver

from education_agent.graphs.student_graph import (
    REPLY_AUTH_EXPIRED,
    REPLY_BUDGET_EXHAUSTED,
    REPLY_NEEDS_CONFIRMATION,
    RunScope,
    build_student_graph,
)
from education_agent.model.base import ModelReply, ToolCall
from education_agent.model.scripted import ScriptedModel
from education_agent.tools.context import RunContext
from education_agent.tools.contracts import TOOL_SPECS
from education_agent.tools.runtime import ToolRuntime
from education_agent.tools.spec import RunBudget

ENROLLMENT = "00000000-0000-0000-0000-000000000501"
TOKEN = "SECRET-SIGNED-TOKEN"
CONFIRMATION_ID = "conf-SECRET-1"


def ctx(expires_in: float = 60) -> RunContext:
    return RunContext("student-1", "student", "req-1", int(time.time() + expires_in), TOKEN)


def business_api(req: httpx.Request) -> httpx.Response:
    p = req.url.path
    if p.endswith("/me/enrollments"):
        return httpx.Response(200, json={"items": [{"enrollmentId": ENROLLMENT, "status": "active"}]})
    if p.endswith("/schedule"):
        return httpx.Response(200, json={"items": [{"lessonId": "L1", "title": "第 2 课"}]})
    if p.endswith("/applications/drafts"):
        return httpx.Response(201, json={
            "id": "app-1", "revision": 1, "status": "draft",
            "summary": {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "冲突", "targetCohortId": None, "refundCents": None},
            "confirmation": {"confirmationId": CONFIRMATION_ID, "applicationId": "app-1", "revision": 1},
        })
    return httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": "x"}})


class Harness:
    def __init__(self, replies: list[ModelReply], *, checkpointer=None):
        self.requests: list[httpx.Request] = []

        def record(req):
            self.requests.append(req)
            return business_api(req)

        self.model = ScriptedModel(replies)
        http = httpx.AsyncClient(transport=httpx.MockTransport(record), base_url="http://api.test")
        self.graph = build_student_graph(self.model, ToolRuntime(TOOL_SPECS, http), checkpointer)

    async def say(self, text: str, *, run_ctx: RunContext | None = None, budget: RunBudget | None = None, thread: str = "t1"):
        return await self.graph.ainvoke(
            {"messages": [{"role": "user", "content": text}]},
            {"configurable": {"thread_id": thread}},
            context=RunScope(run_ctx or ctx(), budget or RunBudget()),
        )


def call(name: str, args: dict, call_id: str = "c1") -> ToolCall:
    return ToolCall(id=call_id, name=name, args=args)


def route(label: str) -> ModelReply:
    return ModelReply(text=label)


def assert_every_tool_call_has_a_tool_message(messages: list[dict]):
    asked = [c["id"] for m in messages if m["role"] == "assistant" for c in m.get("tool_calls", [])]
    answered = [m["tool_call_id"] for m in messages if m["role"] == "tool"]
    assert sorted(asked) == sorted(answered)


# ---- query 分支与内层循环 -----------------------------------------------------------------

async def test_query_flows_through_tools_and_answers():
    h = Harness([
        route("query"),
        ModelReply(tool_calls=(call("getMyEnrollment", {}),)),
        ModelReply(tool_calls=(call("getMySchedule", {"enrollmentId": ENROLLMENT}, "c2"),)),
        ModelReply(text="你的下一课是第 2 课。"),
    ])
    out = await h.say("我下节课是什么？")
    assert out["reply"] == "你的下一课是第 2 课。" and out["stop_reason"] == "answered"
    assert [r.url.path for r in h.requests] == ["/api/v1/me/enrollments", f"/api/v1/me/enrollments/{ENROLLMENT}/schedule"]
    assert all(r.headers["X-Actor-Context"] == TOKEN for r in h.requests)
    assert_every_tool_call_has_a_tool_message(out["messages"])


async def test_route_call_gets_no_tools_and_only_text_turns():
    h = Harness([route("query"), ModelReply(text="ok")])
    await h.say("你好")
    route_msgs, route_tools = h.model.calls[0]
    assert route_tools == []
    assert [m["role"] for m in route_msgs] == ["system", "user"]


async def test_unrecognized_route_label_falls_back_to_query():
    h = Harness([route("我觉得应该转人工吧"), ModelReply(text="ok")])
    out = await h.say("嗯")
    assert out["branch"] == "query"


async def test_query_branch_only_offers_read_tools_and_rejects_prepare_application():
    # 最小权限：即使模型（被诱导）在 query 分支里要起草申请，它既看不到这个工具，硬调也调不到。
    h = Harness([
        route("query"),
        ModelReply(tool_calls=(call("prepareApplication", {"type": "refund", "enrollmentId": ENROLLMENT, "reason": "x"}),)),
        ModelReply(text="好的"),
    ])
    out = await h.say("帮我退费")
    _, offered = h.model.calls[1]
    assert "prepareApplication" not in {t["name"] for t in offered}
    assert h.requests == []
    tool_msg = next(m for m in out["messages"] if m["role"] == "tool")
    assert json.loads(tool_msg["content"])["error"]["code"] == "UNKNOWN_TOOL"


# ---- application 分支：草稿与确认卡 -------------------------------------------------------

async def test_application_branch_stops_at_the_confirmation_card():
    h = Harness([
        route("application"),
        ModelReply(tool_calls=(call("prepareApplication", {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "冲突"}),)),
        # 故意不再给脚本：确认卡一出现，循环必须停下，不能再去问模型（否则 ScriptedModel 会断言失败）。
    ])
    out = await h.say("我想转班，时间冲突")
    assert out["stop_reason"] == "needs_confirmation" and out["reply"] == REPLY_NEEDS_CONFIRMATION
    assert out["confirmation"]["confirmationId"] == CONFIRMATION_ID
    assert [r.method for r in h.requests] == ["POST"], "只创建了草稿，没有任何提交/确认请求"
    assert CONFIRMATION_ID not in json.dumps(out["messages"]), "确认卡不能进入模型可见的历史"
    assert_every_tool_call_has_a_tool_message(out["messages"])


async def test_two_draft_calls_in_one_reply_create_only_one_draft():
    args = {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "冲突"}
    h = Harness([route("application"), ModelReply(tool_calls=(call("prepareApplication", args, "c1"), call("prepareApplication", args, "c2")))])
    out = await h.say("转班")
    assert [r.method for r in h.requests] == ["POST"]
    codes = [json.loads(m["content"]).get("error", {}).get("code") for m in out["messages"] if m["role"] == "tool"]
    assert codes == [None, "SKIPPED"]
    assert_every_tool_call_has_a_tool_message(out["messages"])


# ---- 终止性与登录过期 ---------------------------------------------------------------------

async def test_loop_terminates_when_budget_is_exhausted_even_if_model_never_stops():
    forever = [ModelReply(tool_calls=(call("getMyEnrollment", {}, f"c{i}"),)) for i in range(20)]
    h = Harness([route("query"), *forever])
    out = await h.say("查一下", budget=RunBudget(max_calls=3))
    assert out["stop_reason"] == "budget_exhausted" and out["reply"] == REPLY_BUDGET_EXHAUSTED
    assert len(h.requests) == 3
    assert len(h.model.calls) == 1 + 3 + 1, "1 次分类 + 3 轮被允许的调用 + 第 4 轮（这一轮的调用被预算拒绝，循环随即停止）"
    assert_every_tool_call_has_a_tool_message(out["messages"])


async def test_expired_context_short_circuits_before_any_model_or_api_call():
    h = Harness([])  # 脚本为空：只要调用了模型就会失败
    out = await h.say("你好", run_ctx=ctx(expires_in=-1))
    assert out["reply"] == REPLY_AUTH_EXPIRED
    assert h.model.calls == [] and h.requests == []


async def test_context_expiring_mid_run_stops_the_loop():
    h = Harness([route("query"), ModelReply(tool_calls=(call("getMyEnrollment", {}),))])
    out = await h.say("查", run_ctx=_expiring_after_authorize())
    assert out["stop_reason"] == "auth_expired" and out["reply"] == REPLY_AUTH_EXPIRED
    assert h.requests == []


def _expiring_after_authorize() -> RunContext:
    """第一次问 is_expired 时还有效（通过 load_authorized_context），之后就过期——模拟运行途中过期。"""
    class Flaky(RunContext):
        _asked = 0

        def is_expired(self, now=None):
            Flaky._asked += 1
            return Flaky._asked > 1

    Flaky._asked = 0
    return Flaky("student-1", "student", "req-1", int(time.time() + 60), TOKEN)


# ---- 状态与持久化 -------------------------------------------------------------------------

async def test_second_turn_sees_previous_history_and_resets_per_turn_fields():
    h = Harness([
        route("application"),
        ModelReply(tool_calls=(call("prepareApplication", {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "冲突"}),)),
        route("query"),
        ModelReply(text="好的，有什么可以帮你？"),
    ], checkpointer=InMemorySaver())
    first = await h.say("我想转班")
    assert first["confirmation"] is not None
    second = await h.say("对了，还有别的问题")
    assert second["confirmation"] is None, "上一轮的确认卡不能带到这一轮"
    later_msgs, _ = h.model.calls[-1]
    assert any(m["role"] == "user" and m["content"] == "我想转班" for m in later_msgs), "第二轮模型能看到第一轮的对话"

    # 第一轮的历史里已经有工具往来；第二轮的分类调用仍然只能看到文字往来。
    second_route_msgs, _ = h.model.calls[2]
    assert all(m["role"] != "tool" and not m.get("tool_calls") for m in second_route_msgs)


async def test_stale_confirmation_is_not_surfaced_on_a_later_turn_that_short_circuits():
    # 第二轮直接因登录过期短路，不经过任何分支节点；此时上一轮的确认卡若没被重置，就会被当成这一轮的结果再次交给 UI。
    h = Harness([
        route("application"),
        ModelReply(tool_calls=(call("prepareApplication", {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "冲突"}),)),
    ], checkpointer=InMemorySaver())
    assert (await h.say("我想转班"))["confirmation"] is not None
    second = await h.say("在吗", run_ctx=ctx(expires_in=-1))
    assert second["reply"] == REPLY_AUTH_EXPIRED and second["confirmation"] is None


async def test_run_context_token_is_never_persisted_in_the_checkpoint():
    saver = InMemorySaver()
    h = Harness([route("query"), ModelReply(text="ok")], checkpointer=saver)
    await h.say("你好")
    tup = await saver.aget_tuple({"configurable": {"thread_id": "t1"}})
    persisted = json.dumps({"metadata": tup.metadata, "values": tup.checkpoint["channel_values"]}, default=str)
    assert TOKEN not in persisted and "student-1" not in persisted


# ---- ToolRuntime.restricted_to ------------------------------------------------------------

async def test_restricted_runtime_hides_and_rejects_other_tools_and_rejects_typos():
    sent: list[httpx.Request] = []

    def api(req):
        sent.append(req)
        return httpx.Response(200, json={"items": []})

    rt = ToolRuntime(TOOL_SPECS, httpx.AsyncClient(transport=httpx.MockTransport(api), base_url="http://api.test"))
    only = rt.restricted_to({"getMyEnrollment"})
    assert [s["name"] for s in only.schemas()] == ["getMyEnrollment"]
    res = await only.call("prepareApplication", {}, ctx(), RunBudget())
    assert res.error_code == "UNKNOWN_TOOL" and sent == []
    with pytest.raises(ValueError):
        rt.restricted_to({"getMyEnrolment"})

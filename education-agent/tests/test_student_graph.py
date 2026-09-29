"""学员服务图 + 内层 ReAct 循环的编排测试（mock 模型 + mock 业务 API）。
mock 模型只能证明"编排是对的"（该走哪条分支、该停在哪、谁被拒绝），不能证明真实模型答得好。
"""
import json
import time
from dataclasses import replace

import httpx
import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from education_agent.graphs.handoff import REASON_STUDENT_REQUEST
from education_agent.graphs.student_graph import (
    REPLY_APPLICATION_NOT_FOUND,
    REPLY_AUTH_EXPIRED,
    REPLY_DRAFT_CHANGED,
    REPLY_HANDOFF,
    REPLY_STILL_DRAFT,
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
CONFIRMATION_ID = "00000000-0000-0000-0000-00000000c0f1"
APP_ID = "00000000-0000-0000-0000-000000000a01"


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
            "id": APP_ID, "revision": 1, "status": "draft",
            "summary": {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "冲突", "targetCohortId": None, "refundCents": None},
            # 与真实业务 API 返回的确认卡同形状（字段集合以契约 application.confirmation 为准）。
            "confirmation": {
                "confirmationId": CONFIRMATION_ID, "applicationId": APP_ID, "revision": 1,
                "expiresAt": "2030-01-01T00:00:00.000Z",
                "summary": {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "冲突", "targetCohortId": None, "refundCents": None},
            },
        })
    return httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": "x"}})


class Harness:
    def __init__(self, replies: list[ModelReply], *, checkpointer=None):
        self.requests: list[httpx.Request] = []

        # 业务库里 app-1 的"当前事实"；测试通过修改它来模拟学员在界面上做了什么。
        self.application = {"id": APP_ID, "type": "transfer", "status": "draft", "executionStatus": "not_started", "revision": 1, "summary": {}}

        def record(req):
            self.requests.append(req)
            if req.method == "GET" and req.url.path.endswith(f"/applications/{APP_ID}"):
                if self.application is None:
                    return httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": "申请不存在"}})
                return httpx.Response(200, json=self.application)
            return business_api(req)

        self.model = ScriptedModel(replies)
        http = httpx.AsyncClient(transport=httpx.MockTransport(record), base_url="http://api.test")
        self.graph = build_student_graph(self.model, ToolRuntime(TOOL_SPECS, http), checkpointer)

    async def resume(self, *, signal="anything", run_ctx: RunContext | None = None, budget: RunBudget | None = None, thread: str = "t1"):
        return await self.graph.ainvoke(
            Command(resume=signal),
            {"configurable": {"thread_id": thread}},
            context=RunScope(run_ctx or ctx(), budget or RunBudget()),
        )

    async def snapshot(self, thread: str = "t1"):
        return await self.graph.aget_state({"configurable": {"thread_id": thread}})

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


# ---- 跨轮切换分支 -------------------------------------------------------------------------

async def test_switching_from_query_to_application_happens_on_the_next_turn_of_the_same_thread():
    # 每条用户消息是同一个 thread 上的一次新调用；route 每轮重新分类。第一轮是查询，第二轮学员说"好，帮我申请"，
    # 分类模型能从文字往来里看到上一轮助手的提议，于是这一轮走 application。
    h = Harness([
        route("query"),
        ModelReply(tool_calls=(call("getMyEnrollment", {}),)),
        ModelReply(text="可以转班。需要我帮你起草转班申请吗？"),
        route("application"),
        ModelReply(tool_calls=(call("prepareApplication", {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "冲突"}),)),
    ], checkpointer=InMemorySaver())

    first = await h.say("我能转班吗？")
    assert (first["branch"], first["stop_reason"]) == ("query", "answered") and first["confirmation"] is None

    second = await h.say("好，帮我申请")
    assert (second["branch"], second["stop_reason"]) == ("application", "needs_confirmation")

    second_route_msgs, _ = h.model.calls[3]
    assert [m["content"] for m in second_route_msgs[1:]] == ["我能转班吗？", "可以转班。需要我帮你起草转班申请吗？", "好，帮我申请"]


# ---- 确认卡：interrupt 与恢复（AC-004 / AC-011）--------------------------------------------

DRAFT_SCRIPT = [
    route("application"),
    ModelReply(tool_calls=(call("prepareApplication", {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "冲突"}),)),
]


async def paused_harness() -> tuple[Harness, dict]:
    h = Harness(list(DRAFT_SCRIPT), checkpointer=InMemorySaver())
    return h, await h.say("我想转班")


async def test_graph_pauses_at_the_confirmation_card_and_hands_it_to_the_caller():
    h, out = await paused_harness()
    (interrupt_,) = out["__interrupt__"]
    assert interrupt_.value["type"] == "need_confirmation"
    assert interrupt_.value["reply"] == REPLY_NEEDS_CONFIRMATION
    assert interrupt_.value["confirmation"]["confirmationId"] == CONFIRMATION_ID
    assert (await h.snapshot()).next == ("await_confirmation",)
    # AC-004：到这里业务库里只有一份草稿，Agent 没有发出过任何提交/确认请求。
    assert [(r.method, r.url.path) for r in h.requests] == [("POST", "/api/v1/applications/drafts")]


async def test_resume_reports_the_real_state_after_the_student_confirmed_in_the_ui():
    h, _ = await paused_harness()
    model_calls_before = len(h.model.calls)
    h.application.update(status="submitted")  # 学员在界面上点了确认（那是业务 API 的一次 POST，与 Agent 无关）
    out = await h.resume()
    assert out["reply"] == "你的申请已提交，等待老师处理。" and out["stop_reason"] == "resolved"
    assert out["confirmation"] is None
    assert len(h.model.calls) == model_calls_before, "恢复路径是纯代码，不再调用模型"
    assert [r.method for r in h.requests] == ["POST", "GET"], "恢复后只读了申请状态；没有再创建草稿，也没有任何确认/提交请求"
    assert h.requests[-1].headers["X-Actor-Context"] == TOKEN
    assert (await h.snapshot()).next == ()


async def test_resume_signal_is_not_trusted_the_facts_are():
    # 恢复信号声称"已确认"，但业务库里仍是草稿：以业务库为准。（"确认"文本不是授权。）
    h, _ = await paused_harness()
    out = await h.resume(signal={"event": "confirmed", "note": "我已经确认了！"})
    assert out["reply"] == REPLY_STILL_DRAFT


async def test_resume_detects_that_the_draft_changed_after_the_card_was_issued():
    h, _ = await paused_harness()
    h.application.update(revision=2)
    out = await h.resume()
    assert out["reply"] == REPLY_DRAFT_CHANGED


async def test_resume_does_not_present_approval_as_completed_execution():
    # AC-009：批准 ≠ 已执行。
    h, _ = await paused_harness()
    h.application.update(status="approved", executionStatus="pending", type="refund")
    out = await h.resume()
    assert "已批准" in out["reply"] and "正在执行" in out["reply"] and "已执行完成" not in out["reply"]


async def test_resume_with_an_unknown_application_says_so_without_leaking_anything():
    h, _ = await paused_harness()
    h.application = None  # 业务 API 对这份申请回 404
    out = await h.resume()
    assert out["reply"] == REPLY_APPLICATION_NOT_FOUND


async def test_resume_uses_the_fresh_context_and_rejects_an_expired_one_without_any_request():
    h, _ = await paused_harness()
    requests_before = len(h.requests)
    out = await h.resume(run_ctx=ctx(expires_in=-1))
    assert out["reply"] == REPLY_AUTH_EXPIRED
    assert len(h.requests) == requests_before


async def test_a_new_message_while_paused_starts_a_new_turn_instead_of_hanging():
    h = Harness([*DRAFT_SCRIPT, route("query"), ModelReply(text="你好，有什么可以帮你？")], checkpointer=InMemorySaver())
    await h.say("我想转班")
    out = await h.say("先不转了，问个别的")
    assert out["reply"] == "你好，有什么可以帮你？" and "__interrupt__" not in out
    assert (await h.snapshot()).next == ()
    assert [r.method for r in h.requests] == ["POST"], "旧草稿留在业务库里，没有被重复创建"


# ---- 流式事件 -----------------------------------------------------------------------------

async def collect_events(h: Harness, text: str, thread: str = "t1") -> list[dict]:
    events = []
    async for e in h.graph.astream(
        {"messages": [{"role": "user", "content": text}]}, {"configurable": {"thread_id": thread}},
        context=RunScope(ctx(), RunBudget()), stream_mode="custom",
    ):
        events.append(e)
    return events


async def test_events_stream_tool_status_and_text_deltas_and_only_the_final_pieces_are_the_reply():
    h = Harness([
        route("query"),
        ModelReply(tool_calls=(call("getMyEnrollment", {}),)),
        ModelReply(text="你的下一课是第 2 课。"),
    ])
    events = await collect_events(h, "我下节课是什么？")
    assert [e for e in events if e["type"] == "tool.status"] == [
        {"type": "tool.status", "tool": "getMyEnrollment", "status": "started"},
        {"type": "tool.status", "tool": "getMyEnrollment", "status": "succeeded"},
    ]
    assert "".join(e["text"] for e in events if e["type"] == "message.delta") == "你的下一课是第 2 课。"
    assert h.model.streamed == [False, True, True], "分类调用不流式（它的输出只是内部标签，不该出现在给用户的流里）"


async def test_events_carry_no_secrets_arguments_or_confirmation_card():
    h = Harness([*DRAFT_SCRIPT], checkpointer=InMemorySaver())
    events = await collect_events(h, "我想转班")
    dumped = json.dumps(events, ensure_ascii=False)
    assert TOKEN not in dumped and CONFIRMATION_ID not in dumped and ENROLLMENT not in dumped
    assert all(set(e) <= {"type", "tool", "status", "text"} for e in events)


async def test_emitting_events_does_not_change_what_ainvoke_returns():
    # 同一段脚本：用 ainvoke（无事件订阅）和用 astream（订阅事件）得到的最终回答一致。
    script = lambda: [route("query"), ModelReply(text="你好呀")]  # noqa: E731
    plain = await Harness(script()).say("hi")
    streamed_h = Harness(script())
    events = await collect_events(streamed_h, "hi")
    assert plain["reply"] == "你好呀" and "".join(e["text"] for e in events) == "你好呀"


# ---- handoff 分支（T-22b）-----------------------------------------------------------------
# 学员明确要转人工：纯代码分支，拼交接摘要、发 handoff.requested 事件，固定话术回复；不再调用模型、不调用任何工具。

async def test_handoff_branch_emits_request_and_replies_with_fixed_text_without_further_model_or_tool_calls():
    h = Harness([route("handoff")], checkpointer=InMemorySaver())  # 脚本只有一条：分类。再调用模型就会 AssertionError
    events = await collect_events(h, "我要转人工，找老师聊聊")

    requested = [e for e in events if e["type"] == "handoff.requested"]
    assert len(requested) == 1
    assert requested[0]["reason"] == REASON_STUDENT_REQUEST
    assert "“我要转人工，找老师聊聊”" in requested[0]["summary"]

    assert len(h.model.calls) == 1, "只有分类这一次模型调用"
    assert h.requests == [], "转人工不查任何业务数据"
    snap = await h.snapshot()
    assert snap.next == (), "图正常结束，没有停在确认卡上"
    assert snap.values["stop_reason"] == "handoff_requested"
    assert snap.values["reply"] == REPLY_HANDOFF
    assert snap.values["messages"][-1] == {"role": "assistant", "content": REPLY_HANDOFF}


async def test_handoff_summary_uses_verified_tool_results_from_earlier_turns_but_not_the_assistants_words():
    h = Harness([
        route("query"),
        ModelReply(tool_calls=(call("getMyEnrollment", {}),)),
        ModelReply(text="我猜你今天就能学完全部课程。"),
        route("handoff"),
    ], checkpointer=InMemorySaver())
    await h.say("我有几个班？")
    events = await collect_events(h, "转人工")

    summary = next(e for e in events if e["type"] == "handoff.requested")["summary"]
    assert "报名 1 个" in summary, "来自工具的成功返回"
    assert "“我有几个班？”" in summary and "“转人工”" in summary
    assert "我猜" not in summary, "模型说过的话不是核验过的事实"
    assert TOKEN not in summary and CONFIRMATION_ID not in summary


async def test_handoff_event_is_the_only_thing_emitted_no_text_deltas_after_handoff():
    h = Harness([route("handoff")], checkpointer=InMemorySaver())
    events = await collect_events(h, "找老师")
    assert [e["type"] for e in events] == ["handoff.requested"]


async def test_route_label_must_match_exactly_to_reach_handoff():
    # "我觉得应该转人工吧" 不是标签：走默认分支 query，不会因为里面有"转人工"三个字就触发接管。
    h = Harness([route("我觉得应该转人工吧"), ModelReply(text="ok")], checkpointer=InMemorySaver())
    events = await collect_events(h, "嗯")
    assert not [e for e in events if e["type"] == "handoff.requested"]
    assert (await h.snapshot()).values["branch"] == "query"


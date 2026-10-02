"""run_tool_loop 的单元测试（T-28 新增）：不需要真实业务 API/Postgres/Qdrant，
只验证"工具结果的 artifacts 里有 citations 时，emit 出什么事件"这一条编排规则。
其它既有行为（事件只是边跑边通知、确认卡让循环停下）已经由 test_student_graph.py
走完整图间接覆盖；这里只补 T-27/T-28 之前没有专门测过的 citation/replay.card 分支。
"""
import time

import httpx

from education_agent.graphs.loop import run_tool_loop
from education_agent.model.base import ModelReply, ToolCall
from education_agent.model.scripted import ScriptedModel
from education_agent.tools.context import RunContext
from education_agent.tools.runtime import ToolRuntime
from education_agent.tools.spec import RunBudget, ToolArgs, ToolOutput, ToolSpec


class _NoArgs(ToolArgs):
    pass


def _ctx() -> RunContext:
    return RunContext("student-1", "student", "req-1", int(time.time() + 60), "TOKEN")


def _runtime(spec: ToolSpec) -> ToolRuntime:
    return ToolRuntime((spec,), httpx.AsyncClient())


async def _search_tool(citations: list[dict]):
    async def handler(_api, _args: _NoArgs) -> ToolOutput:
        return ToolOutput(data={"found": True}, artifacts={"citations": citations})

    return ToolSpec("searchKnowledge", "搜索", _NoArgs, handler)


async def test_each_citation_in_artifacts_emits_a_citation_event_with_exactly_the_schema_fields():
    citation = {"sourceId": "doc-1", "sourceVersion": 1, "title": "第一课", "segmentId": "seg-1", "startSeconds": 12.0, "endSeconds": 18.5}
    tools = _runtime(await _search_tool([citation]))
    model = ScriptedModel([
        ModelReply(tool_calls=(ToolCall(id="c1", name="searchKnowledge", args={}),)),
        ModelReply(text="找到了"),
    ])
    events: list[dict] = []

    await run_tool_loop(model=model, tools=tools, ctx=_ctx(), budget=RunBudget(), messages=[], emit=events.append)

    citation_events = [e for e in events if e["type"] == "citation"]
    assert citation_events == [{"type": "citation", **citation}]


async def test_citation_with_a_full_time_range_also_emits_a_replay_card():
    citation = {"sourceId": "doc-1", "sourceVersion": 1, "title": "第一课", "segmentId": "seg-1", "startSeconds": 12.0, "endSeconds": 18.5}
    tools = _runtime(await _search_tool([citation]))
    model = ScriptedModel([
        ModelReply(tool_calls=(ToolCall(id="c1", name="searchKnowledge", args={}),)),
        ModelReply(text="找到了"),
    ])
    events: list[dict] = []

    await run_tool_loop(model=model, tools=tools, ctx=_ctx(), budget=RunBudget(), messages=[], emit=events.append)

    assert [e for e in events if e["type"] == "replay.card"] == [
        {"type": "replay.card", "segmentId": "seg-1", "lessonTitle": "第一课", "startSeconds": 12.0, "endSeconds": 18.5}
    ]


async def test_citation_without_a_timeline_does_not_emit_a_replay_card_but_still_emits_the_citation():
    # 讲义没有时间轴：startSeconds/endSeconds 是 None（不编一个假的时间点），没法生成可以跳转播放的卡片。
    citation = {"sourceId": "doc-2", "sourceVersion": 1, "title": "讲义", "segmentId": "seg-2", "startSeconds": None, "endSeconds": None}
    tools = _runtime(await _search_tool([citation]))
    model = ScriptedModel([
        ModelReply(tool_calls=(ToolCall(id="c1", name="searchKnowledge", args={}),)),
        ModelReply(text="找到了"),
    ])
    events: list[dict] = []

    await run_tool_loop(model=model, tools=tools, ctx=_ctx(), budget=RunBudget(), messages=[], emit=events.append)

    assert [e["type"] for e in events if e["type"] in ("citation", "replay.card")] == ["citation"]


async def test_no_citations_in_artifacts_emits_neither_event_and_loop_keeps_going_as_before():
    async def handler(_api, _args: _NoArgs) -> ToolOutput:
        return ToolOutput(data={"ok": True})

    tools = _runtime(ToolSpec("getMyEnrollment", "x", _NoArgs, handler))
    model = ScriptedModel([
        ModelReply(tool_calls=(ToolCall(id="c1", name="getMyEnrollment", args={}),)),
        ModelReply(text="好的"),
    ])
    events: list[dict] = []

    result = await run_tool_loop(model=model, tools=tools, ctx=_ctx(), budget=RunBudget(), messages=[], emit=events.append)

    assert [e["type"] for e in events if e["type"] in ("citation", "replay.card")] == []
    assert result.stop == "answered"
    assert result.text == "好的"

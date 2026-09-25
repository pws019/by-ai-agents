"""模型层：mock 实现的行为，以及 LangChain 适配器与"OpenAI 兼容端点"之间真实交换的内容。
端点用 httpx.MockTransport 充当，所以能断言"发出去的请求体长什么样"，也能喂给适配器各种（含畸形的）回复。
"""
import json

import httpx
import pytest

from education_agent.model.base import ModelReply, ToolCall
from education_agent.model.langchain_adapter import UNPARSABLE_ARGS_KEY, create_langchain_model
from education_agent.model.scripted import ScriptedModel
from education_agent.tools.contracts import TOOL_SPECS
from education_agent.tools.runtime import ToolRuntime


# ---- ScriptedModel ----------------------------------------------------------------------

async def test_scripted_model_replies_in_order_and_records_what_it_received():
    m = ScriptedModel([ModelReply(text="a"), ModelReply(text="b")])
    msgs = [{"role": "user", "content": "hi"}]
    assert (await m.chat(msgs, [])).text == "a"
    assert (await m.chat(msgs, [{"name": "t"}])).text == "b"
    assert [len(c[1]) for c in m.calls] == [0, 1]


async def test_scripted_model_fails_loudly_when_called_more_than_scripted():
    m = ScriptedModel([ModelReply(text="only one")])
    await m.chat([], [])
    with pytest.raises(AssertionError):
        await m.chat([], [])


# ---- LangChain 适配器 -------------------------------------------------------------------

class FakeEndpoint:
    """假的 OpenAI 兼容端点：记录请求体，按顺序返回预设的 assistant 消息。"""

    def __init__(self, *assistant_messages: dict):
        self.requests: list[dict] = []
        self.headers: list[httpx.Headers] = []
        self._msgs = iter(assistant_messages)

    def __call__(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        self.requests.append(body)
        self.headers.append(req.headers)
        msg = next(self._msgs)
        return httpx.Response(200, json={
            "id": "x", "object": "chat.completion", "created": 0, "model": body["model"],
            "choices": [{"index": 0, "finish_reason": "stop", "message": msg}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })

    def model(self):
        client = httpx.AsyncClient(transport=httpx.MockTransport(self))
        return create_langchain_model("http://model.test/v1", "dev-key", "qwen-ft", http_async_client=client)


def tool_call_msg(name: str, arguments: str, call_id: str = "call_1") -> dict:
    return {"role": "assistant", "content": None,
            "tool_calls": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}]}


async def test_plain_text_reply_becomes_model_reply():
    ep = FakeEndpoint({"role": "assistant", "content": "你好"})
    reply = await ep.model().chat([{"role": "user", "content": "hi"}], [])
    assert reply == ModelReply(text="你好", tool_calls=())
    assert ep.headers[0]["authorization"] == "Bearer dev-key"
    assert "tools" not in ep.requests[0], "没有可用工具时不该带 tools 字段"


async def test_tool_schemas_are_sent_and_contain_nothing_about_identity():
    ep = FakeEndpoint({"role": "assistant", "content": "ok"})
    runtime_tools = ToolRuntime(TOOL_SPECS, httpx.AsyncClient()).schemas()
    await ep.model().chat([{"role": "user", "content": "hi"}], runtime_tools)
    sent = ep.requests[0]["tools"]
    assert {t["function"]["name"] for t in sent} == {s.name for s in TOOL_SPECS}
    assert all(t["type"] == "function" for t in sent)
    text = json.dumps(sent).lower()
    assert "studentid" not in text and "actorid" not in text and "token" not in text


async def test_tool_call_reply_is_parsed_into_tool_calls_with_dict_args():
    ep = FakeEndpoint(tool_call_msg("getMySchedule", json.dumps({"enrollmentId": "E-1"})))
    reply = await ep.model().chat([{"role": "user", "content": "课表"}], [{"name": "getMySchedule", "description": "d", "parameters": {"type": "object", "properties": {}}}])
    assert reply.tool_calls == (ToolCall(id="call_1", name="getMySchedule", args={"enrollmentId": "E-1"}),)


async def test_history_with_tool_round_trip_is_sent_with_correct_roles_and_ids():
    ep = FakeEndpoint({"role": "assistant", "content": "下一课是第 2 课"})
    history = [
        {"role": "system", "content": "你是助手"},
        {"role": "user", "content": "课表"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "call_1", "name": "getMySchedule", "args": {"enrollmentId": "E-1"}}]},
        {"role": "tool", "content": '{"ok": true}', "tool_call_id": "call_1"},
    ]
    await ep.model().chat(history, [])
    sent = ep.requests[0]["messages"]
    assert [m["role"] for m in sent] == ["system", "user", "assistant", "tool"]
    assert sent[2]["tool_calls"][0]["id"] == "call_1"
    assert json.loads(sent[2]["tool_calls"][0]["function"]["arguments"]) == {"enrollmentId": "E-1"}
    assert sent[3]["tool_call_id"] == "call_1"


async def test_unparsable_tool_arguments_are_not_silently_dropped_or_run_with_empty_args():
    # 模型吐出坏掉的 JSON 参数。若丢掉：模型以为调用过了；若当成空参数：会误调用无参工具（如 getMyEnrollment）。
    ep = FakeEndpoint(tool_call_msg("getMyEnrollment", "{not valid json"))
    reply = await ep.model().chat([{"role": "user", "content": "x"}], [{"name": "getMyEnrollment", "description": "d", "parameters": {"type": "object", "properties": {}}}])
    (call,) = reply.tool_calls
    assert call.name == "getMyEnrollment" and call.args == {UNPARSABLE_ARGS_KEY: True}


async def test_unparsable_arguments_are_rejected_by_tool_runtime_as_invalid_args():
    # 与 ToolRuntime 的衔接：标记键被 extra="forbid" 拒绝，走已有的 INVALID_ARGS 通路，且不发任何 HTTP 请求。
    import time

    from education_agent.tools.context import RunContext
    from education_agent.tools.spec import RunBudget

    sent: list[httpx.Request] = []

    async def api(req):
        sent.append(req)
        return httpx.Response(200, json={"items": []})

    rt = ToolRuntime(TOOL_SPECS, httpx.AsyncClient(transport=httpx.MockTransport(api), base_url="http://api.test"))
    ctx = RunContext("s", "student", "r", int(time.time()) + 60, "T")
    res = await rt.call("getMyEnrollment", {UNPARSABLE_ARGS_KEY: True}, ctx, RunBudget())
    assert (res.ok, res.error_code) == (False, "INVALID_ARGS")
    assert sent == []

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


# ---- 流式 ---------------------------------------------------------------------------------

def sse(*deltas: dict) -> httpx.Response:
    """OpenAI 兼容的流式响应：每个 delta 一条 data 行，最后是 finish 与 [DONE]。"""
    def chunk(delta: dict, finish=None) -> str:
        body = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": "m",
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        return f"data: {json.dumps(body, ensure_ascii=False)}\n\n"

    text = "".join(chunk(d) for d in deltas) + chunk({}, "stop") + "data: [DONE]\n\n"
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=text.encode())


def streaming_model(*deltas: dict):
    requests: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        requests.append(json.loads(req.content))
        return sse(*deltas)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return create_langchain_model("http://model.test/v1", "k", "m", http_async_client=client), requests


async def test_streamed_text_is_delivered_piece_by_piece_and_returned_in_full():
    model, requests = streaming_model({"role": "assistant", "content": "你"}, {"content": "好，"}, {"content": "世界"})
    pieces: list[str] = []
    reply = await model.chat([{"role": "user", "content": "hi"}], [], on_text=pieces.append)
    assert pieces == ["你", "好，", "世界"]
    assert reply == ModelReply(text="你好，世界", tool_calls=())
    assert requests[0]["stream"] is True


async def test_streamed_tool_call_arguments_arrive_in_chunks_and_are_merged_into_valid_args():
    model, _ = streaming_model(
        {"role": "assistant", "content": None, "tool_calls": [{"index": 0, "id": "call_9", "type": "function", "function": {"name": "getMySchedule", "arguments": ""}}]},
        {"tool_calls": [{"index": 0, "function": {"arguments": '{"enrollment'}}]},
        {"tool_calls": [{"index": 0, "function": {"arguments": 'Id": "E-1"}'}}]},
    )
    pieces: list[str] = []
    reply = await model.chat([{"role": "user", "content": "课表"}], [{"name": "getMySchedule", "description": "d", "parameters": {"type": "object", "properties": {}}}], on_text=pieces.append)
    assert pieces == [], "纯工具调用没有文本，不该回调"
    assert reply.tool_calls == (ToolCall(id="call_9", name="getMySchedule", args={"enrollmentId": "E-1"}),)


async def test_streamed_unparsable_arguments_are_still_surfaced_as_invalid_not_dropped():
    model, _ = streaming_model(
        {"role": "assistant", "content": None, "tool_calls": [{"index": 0, "id": "call_9", "type": "function", "function": {"name": "getMyEnrollment", "arguments": ""}}]},
        {"tool_calls": [{"index": 0, "function": {"arguments": "{not valid json"}}]},
    )
    reply = await model.chat([{"role": "user", "content": "x"}], [{"name": "getMyEnrollment", "description": "d", "parameters": {"type": "object", "properties": {}}}], on_text=lambda _t: None)
    (call,) = reply.tool_calls
    assert call.name == "getMyEnrollment" and call.args == {UNPARSABLE_ARGS_KEY: True}


async def test_scripted_model_streams_in_chunks_when_asked():
    m = ScriptedModel([ModelReply(text="abcdefghij")], chunk_size=4)
    pieces: list[str] = []
    reply = await m.chat([], [], on_text=pieces.append)
    assert pieces == ["abcd", "efgh", "ij"] and reply.text == "abcdefghij" and m.streamed == [True]


async def test_streamed_no_arg_call_with_empty_argument_string_is_valid_not_flagged():
    model, _ = streaming_model(
        {"role": "assistant", "content": None, "tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": "getMyEnrollment", "arguments": ""}}]},
    )
    reply = await model.chat([{"role": "user", "content": "x"}], [{"name": "getMyEnrollment", "description": "d", "parameters": {"type": "object", "properties": {}}}], on_text=lambda _t: None)
    assert reply.tool_calls == (ToolCall(id="call_1", name="getMyEnrollment", args={}),)


async def test_streamed_arguments_that_are_valid_json_but_not_an_object_are_flagged():
    model, _ = streaming_model(
        {"role": "assistant", "content": None, "tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": "getMyEnrollment", "arguments": "[1, 2]"}}]},
    )
    reply = await model.chat([{"role": "user", "content": "x"}], [{"name": "getMyEnrollment", "description": "d", "parameters": {"type": "object", "properties": {}}}], on_text=lambda _t: None)
    assert reply.tool_calls[0].args == {UNPARSABLE_ARGS_KEY: True}

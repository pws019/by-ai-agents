"""T-24：模拟写入成功但响应超时，验证模型可查回事实并复用原草稿。"""
import json
import time

import httpx
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from education_agent.graphs.student_graph import RunScope, build_student_graph
from education_agent.model.base import ModelReply, ToolCall
from education_agent.model.scripted import ScriptedModel
from education_agent.tools.context import RunContext
from education_agent.tools.contracts import TOOL_SPECS
from education_agent.tools.runtime import ToolRuntime
from education_agent.tools.spec import RunBudget

from test_student_graph import APP_ID, CONFIRMATION_ID, ENROLLMENT


async def test_write_commits_then_times_out_lookup_and_retry_reuse_the_same_draft():
    draft = {
        "id": APP_ID, "type": "transfer", "status": "draft", "revision": 1,
        "summary": {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "时间冲突"},
        "confirmation": {
            "confirmationId": CONFIRMATION_ID, "applicationId": APP_ID, "revision": 1,
            "expiresAt": "2030-01-01T00:00:00.000Z",
            "summary": {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "时间冲突"},
        },
    }
    created: list[dict] = []
    requests: list[tuple[str, str]] = []

    async def business_api(req: httpx.Request) -> httpx.Response:
        requests.append((req.method, req.url.path))
        if req.method == "POST" and req.url.path.endswith("/applications/drafts"):
            body = json.loads(req.content)
            if not created:
                created.append(body)  # 服务端事务已经提交；随后才丢失响应。
                raise httpx.ReadTimeout("response lost after commit", request=req)
            assert body == created[0]
            return httpx.Response(200, json=draft)  # 业务唯一约束：返回原草稿与原确认卡。
        if req.url.path.endswith("/me/applications"):
            return httpx.Response(200, json={"items": [draft]})
        if req.url.path.endswith(f"/applications/{APP_ID}"):
            return httpx.Response(200, json={**draft, "status": "submitted"})
        raise AssertionError(f"意外业务请求: {req.method} {req.url.path}")

    args = {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "时间冲突"}
    model = ScriptedModel([
        ModelReply(text="application"),
        ModelReply(tool_calls=(ToolCall(id="write-1", name="prepareApplication", args=args),)),
        ModelReply(tool_calls=(ToolCall(id="lookup", name="getApplicationStatus", args={}),)),
        ModelReply(tool_calls=(ToolCall(id="write-2", name="prepareApplication", args=args),)),
    ])
    context = RunContext("student-1", "student", "run-1", int(time.time()) + 60, "signed-token")
    async with httpx.AsyncClient(transport=httpx.MockTransport(business_api), base_url="http://api.test") as http:
        graph = build_student_graph(model, ToolRuntime(TOOL_SPECS, http), InMemorySaver())
        config = {"configurable": {"thread_id": "student-1:timeout-recovery"}}
        result = await graph.ainvoke(
            {"messages": [{"role": "user", "content": "我想转班，时间冲突"}]},
            config, context=RunScope(context, RunBudget()),
        )
        assert result["confirmation"]["confirmationId"] == CONFIRMATION_ID
        assert len(created) == 1, "第二次调用必须复用业务库已有草稿"
        assert requests == [
            ("POST", "/api/v1/applications/drafts"),
            ("GET", "/api/v1/me/applications"),
            ("POST", "/api/v1/applications/drafts"),
        ]
        tool_results = [json.loads(m["content"]) for m in result["messages"] if m["role"] == "tool"]
        assert tool_results[0]["error"]["code"] == "TIMEOUT"
        assert tool_results[1]["data"]["items"][0]["id"] == APP_ID
        assert tool_results[2]["data"]["applicationId"] == APP_ID
        assert (await graph.aget_state(config)).next == ("await_confirmation",)

        resumed = await graph.ainvoke(Command(resume=True), config, context=RunScope(context, RunBudget()))
        assert resumed["reply"] == "你的申请已提交，等待老师处理。"
        assert len(created) == 1
        assert requests[-1] == ("GET", f"/api/v1/applications/{APP_ID}")

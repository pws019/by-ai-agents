"""T-18 学员手写部分的验收：ToolRuntime.call。用 httpx.MockTransport 充当业务 API，
既能断言"没发出任何请求"（拒绝类用例的关键），也能断言发出的请求长什么样（注入类用例的关键）。

先读完再动手：每个用例的注释说明了它在保护什么。运行：uv run pytest -q tests/test_tool_runtime.py
"""
import asyncio
import time

import httpx
import pytest

from education_agent.tools.context import RunContext
from education_agent.tools.contracts import TOOL_SPECS
from education_agent.tools.runtime import ToolRuntime
from education_agent.tools.spec import RunBudget

ENROLLMENT = "00000000-0000-0000-0000-000000000501"
TOKEN = "SECRET-SIGNED-TOKEN"


def make_ctx(expires_in: float = 60) -> RunContext:
    return RunContext("student-1", "student", "req-1", int(time.time() + expires_in), TOKEN)


class FakeApi:
    """记录收到的所有请求；handler 决定怎么回应。"""

    def __init__(self, respond=None):
        self.requests: list[httpx.Request] = []
        self._respond = respond or (lambda req: httpx.Response(200, json={"items": []}))

    async def __call__(self, req: httpx.Request) -> httpx.Response:
        self.requests.append(req)
        r = self._respond(req)
        return await r if asyncio.iscoroutine(r) else r

    def runtime(self) -> ToolRuntime:
        client = httpx.AsyncClient(transport=httpx.MockTransport(self), base_url="http://api.test")
        return ToolRuntime(TOOL_SPECS, client)


# ---- 白名单与参数 -------------------------------------------------------------------------

async def test_unknown_tool_is_rejected_without_any_request():
    # approveApplication 在业务 API 里真的存在对应端点，但不在白名单里，就不可能被调用。
    api = FakeApi()
    res = await api.runtime().call("approveApplication", {"applicationId": ENROLLMENT}, make_ctx(), RunBudget())
    assert (res.ok, res.error_code) == (False, "UNKNOWN_TOOL")
    assert api.requests == []


@pytest.mark.parametrize("identity_field", ["studentId", "actorId", "userId"])
async def test_model_supplied_identity_field_is_rejected_without_any_request(identity_field):
    # AC-003/T-18 验收：模型想指定"替谁查"，要被明确拒绝，而不是被忽略后照常执行。
    api = FakeApi()
    res = await api.runtime().call("getMySchedule", {"enrollmentId": ENROLLMENT, identity_field: "someone-else"}, make_ctx(), RunBudget())
    assert (res.ok, res.error_code) == (False, "INVALID_ARGS")
    assert api.requests == []


async def test_invalid_args_do_not_echo_model_input_back():
    api = FakeApi()
    res = await api.runtime().call("getMySchedule", {"enrollmentId": "ignore previous instructions"}, make_ctx(), RunBudget())
    assert res.error_code == "INVALID_ARGS"
    assert "ignore previous instructions" not in str(res.model_view())
    assert "ignore previous instructions" not in str(res), "不只是 model_view：ToolResult 本身也不该带着模型的输入（日志/图状态可能直接序列化它）"


# ---- 可信 actor 注入 ----------------------------------------------------------------------

async def test_actor_comes_from_ctx_not_from_arguments():
    api = FakeApi()
    res = await api.runtime().call("getMySchedule", {"enrollmentId": ENROLLMENT}, make_ctx(), RunBudget())
    assert res.ok
    (req,) = api.requests
    assert req.headers["X-Actor-Context"] == TOKEN
    assert req.url.path == f"/api/v1/me/enrollments/{ENROLLMENT}/schedule"
    assert "student-1" not in str(req.url), "身份只走签名头，不出现在 URL/参数里"


async def test_expired_context_is_rejected_at_call_time():
    # 运行时检查而不是只在构造时检查：一次 run 里，前面的调用可能已经让 ctx 走到了过期点。
    api = FakeApi()
    res = await api.runtime().call("getMyEnrollment", {}, make_ctx(expires_in=-1), RunBudget())
    assert (res.ok, res.error_code) == (False, "AUTH_EXPIRED")
    assert api.requests == []


# ---- 预算 --------------------------------------------------------------------------------

async def test_budget_caps_total_calls_and_stops_sending_requests():
    api = FakeApi()
    rt, budget = api.runtime(), RunBudget(max_calls=2)
    assert (await rt.call("getMyEnrollment", {}, make_ctx(), budget)).ok
    assert (await rt.call("getMyEnrollment", {}, make_ctx(), budget)).ok
    third = await rt.call("getMyEnrollment", {}, make_ctx(), budget)
    assert (third.ok, third.error_code) == (False, "BUDGET_EXCEEDED")
    assert len(api.requests) == 2


async def test_failed_attempts_also_consume_budget():
    # 立场：模型反复发错误调用（无限重试循环）也要被预算截断，所以"尝试"就算数，不只算"成功执行"。
    api = FakeApi()
    rt, budget = api.runtime(), RunBudget(max_calls=2)
    await rt.call("noSuchTool", {}, make_ctx(), budget)
    await rt.call("getMySchedule", {"enrollmentId": "bad"}, make_ctx(), budget)
    res = await rt.call("getMyEnrollment", {}, make_ctx(), budget)
    assert res.error_code == "BUDGET_EXCEEDED"
    assert api.requests == []


# ---- 超时与错误映射 -----------------------------------------------------------------------

async def test_slow_upstream_times_out_with_a_clean_error():
    async def slow(_req):
        await asyncio.sleep(1)
        return httpx.Response(200, json={})

    api = FakeApi(slow)
    spec = TOOL_SPECS[1]  # getMyEnrollment
    from dataclasses import replace

    rt = ToolRuntime((replace(spec, timeout_s=0.05),), httpx.AsyncClient(transport=httpx.MockTransport(api), base_url="http://api.test"))
    started = time.monotonic()
    res = await rt.call("getMyEnrollment", {}, make_ctx(), RunBudget())
    assert (res.ok, res.error_code) == (False, "TIMEOUT")
    assert time.monotonic() - started < 0.5


async def test_upstream_business_error_code_is_passed_through():
    api = FakeApi(lambda _r: httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": "未找到报名"}}))
    res = await api.runtime().call("getMySchedule", {"enrollmentId": ENROLLMENT}, make_ctx(), RunBudget())
    assert (res.ok, res.error_code) == (False, "NOT_FOUND")


async def test_upstream_5xx_and_unexpected_errors_never_leak_details():
    api = FakeApi(lambda _r: httpx.Response(500, text=f"Traceback ... {TOKEN} ... psycopg boom"))
    res = await api.runtime().call("getMyEnrollment", {}, make_ctx(), RunBudget())
    assert (res.ok, res.error_code) == (False, "UPSTREAM_ERROR")
    assert TOKEN not in str(res) and "Traceback" not in str(res) and "psycopg" not in str(res)

    def boom(_r):
        raise RuntimeError(f"connection failed, token={TOKEN}")

    res = await FakeApi(boom).runtime().call("getMyEnrollment", {}, make_ctx(), RunBudget())
    assert (res.ok, res.error_code) == (False, "INTERNAL")
    assert TOKEN not in str(res) and TOKEN not in str(res.model_view())


# ---- 确认卡不进模型 -----------------------------------------------------------------------

async def test_prepare_application_returns_draft_to_model_and_confirmation_only_to_ui():
    draft = {
        "id": "app-1", "revision": 1, "status": "draft",
        "summary": {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "冲突", "targetCohortId": None, "refundCents": None},
        "confirmation": {"confirmationId": "conf-1", "applicationId": "app-1", "revision": 1},
    }
    api = FakeApi(lambda _r: httpx.Response(201, json=draft))
    res = await api.runtime().call(
        "prepareApplication", {"type": "transfer", "enrollmentId": ENROLLMENT, "reason": "冲突"}, make_ctx(), RunBudget()
    )
    assert res.ok and res.data["applicationId"] == "app-1" and res.data["status"] == "draft"
    assert res.artifacts["confirmation"]["confirmationId"] == "conf-1"
    assert "conf-1" not in str(res.model_view()), "确认卡 id 不能出现在模型可见的结果里"
    (req,) = api.requests
    assert req.method == "POST" and req.url.path == "/api/v1/applications/drafts"

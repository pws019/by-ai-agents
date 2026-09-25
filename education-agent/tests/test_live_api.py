"""跨服务联调：Python 的 ToolRuntime 打真实运行的 education-api（用 seed 数据），验证信任链两端真的对得上。
默认跳过。运行方式：
  1) education-api 用同一个密钥启动：INTERNAL_AUTH_SECRET=live-test-secret npx tsx src/index.ts
  2) EDU_LIVE_API_URL=http://127.0.0.1:8400 INTERNAL_AUTH_SECRET=live-test-secret uv run pytest -q tests/test_live_api.py
这里只做只读调用和"应被拒绝"的调用，不写库，可重复运行。
"""
import base64
import hashlib
import hmac
import json
import os
import time

import httpx
import pytest

from education_agent.tools.context import verify_context
from education_agent.tools.contracts import TOOL_SPECS
from education_agent.tools.runtime import ToolRuntime
from education_agent.tools.spec import RunBudget

URL = os.environ.get("EDU_LIVE_API_URL")
SECRET = os.environ.get("INTERNAL_AUTH_SECRET")
pytestmark = pytest.mark.skipif(not (URL and SECRET), reason="需要 EDU_LIVE_API_URL 和 INTERNAL_AUTH_SECRET")

LI = "00000000-0000-0000-0000-0000000000b2"
WANG = "00000000-0000-0000-0000-0000000000b3"
LI_ACTIVE_ENROLLMENT = "a3961f0d-a792-4973-bd94-a08fac1c2ea0"
WANG_ENROLLMENT = "00000000-0000-0000-0000-000000000503"


def issue(actor_id: str, role: str = "student", secret: str | None = None, ttl: int = 60):
    """充当 BFF：签发工作证。这里用 Python 自己签，同时也验证了"Python 签的 TS 认得"。"""
    payload = {"actorId": actor_id, "role": role, "requestId": "live-1", "exp": int(time.time()) + ttl}
    b = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    sig = base64.urlsafe_b64encode(hmac.new((secret or SECRET).encode(), b.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    ctx = verify_context(f"{b}.{sig}", secret or SECRET)
    assert ctx is not None
    return ctx


@pytest.fixture
async def rt():
    async with httpx.AsyncClient(base_url=URL) as http:
        yield ToolRuntime(TOOL_SPECS, http)


def ids(res) -> set[str]:
    return {x["enrollmentId"] for x in res.data["items"]}


async def test_each_student_only_sees_own_enrollments(rt):
    li = await rt.call("getMyEnrollment", {}, issue(LI), RunBudget())
    wang = await rt.call("getMyEnrollment", {}, issue(WANG), RunBudget())
    assert li.ok and wang.ok
    assert LI_ACTIVE_ENROLLMENT in ids(li) and WANG_ENROLLMENT not in ids(li)
    assert WANG_ENROLLMENT in ids(wang) and LI_ACTIVE_ENROLLMENT not in ids(wang)


async def test_reading_own_enrollment_works_and_someone_elses_is_not_found(rt):
    mine = await rt.call("getMySchedule", {"enrollmentId": LI_ACTIVE_ENROLLMENT}, issue(LI), RunBudget())
    assert mine.ok
    theirs = await rt.call("getMySchedule", {"enrollmentId": WANG_ENROLLMENT}, issue(LI), RunBudget())
    assert (theirs.ok, theirs.error_code) == (False, "NOT_FOUND")


async def test_token_signed_with_wrong_secret_is_rejected_by_the_real_api(rt):
    res = await rt.call("getMyEnrollment", {}, issue(LI, secret="not-the-real-secret"), RunBudget())
    assert res.ok is False


async def test_agent_channel_cannot_confirm_or_use_teacher_endpoints():
    # 不经过工具（白名单本来就没有这些工具），直接用 Agent 的工作证打业务 API：第二道防线必须也拦得住。
    headers = {"X-Actor-Context": issue(LI).token}
    async with httpx.AsyncClient(base_url=URL, headers=headers) as http:
        confirm = await http.post("/api/v1/applications/00000000-0000-0000-0000-000000000999/confirm", json={})
        teacher = await http.get("/api/v1/teacher/applications")
    assert confirm.status_code == 403
    assert teacher.status_code == 403

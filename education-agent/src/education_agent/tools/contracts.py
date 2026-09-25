"""固定工具契约（design.md §6）。学生 Agent 只有这些工具，没有 approve/confirm/refund，也没有任意 HTTP/SQL。

设计要点：
- 参数模型里没有任何"是谁"的字段：没有 studentId/actorId/userId。身份由运行时注入的 RunContext 决定。
- 每个工具只是"把一个业务 API 调用包成模型可用的函数"，授权判断仍然在业务 API（它会再次按 actor 校验）。
- searchKnowledge/findReplaySegments/getPrerequisiteLessons 属于 M4/M5，requestHandoff 属于 T-22，此处不含。
"""
from typing import Literal
from uuid import UUID

from pydantic import Field

from .client import BusinessApi
from .spec import ToolArgs, ToolOutput, ToolSpec


class NoArgs(ToolArgs):
    pass


class EnrollmentArgs(ToolArgs):
    enrollmentId: UUID


class PrepareApplicationArgs(ToolArgs):
    type: Literal["transfer", "refund"]
    enrollmentId: UUID
    reason: str = Field(min_length=1, max_length=2000)
    targetCohortId: UUID | None = None


class ApplicationStatusArgs(ToolArgs):
    applicationId: UUID | None = None  # 不给就列出我自己的申请


async def _current_offering(api: BusinessApi, _: NoArgs) -> ToolOutput:
    return ToolOutput(await api.get("/catalog/current"))


async def _my_enrollment(api: BusinessApi, _: NoArgs) -> ToolOutput:
    return ToolOutput(await api.get("/me/enrollments"))


async def _my_schedule(api: BusinessApi, a: EnrollmentArgs) -> ToolOutput:
    return ToolOutput(await api.get(f"/me/enrollments/{a.enrollmentId}/schedule"))


async def _my_progress(api: BusinessApi, a: EnrollmentArgs) -> ToolOutput:
    return ToolOutput(await api.get(f"/me/enrollments/{a.enrollmentId}/progress"))


async def _transfer_targets(api: BusinessApi, a: EnrollmentArgs) -> ToolOutput:
    return ToolOutput(await api.get("/cohorts/transfer-targets", params={"enrollmentId": str(a.enrollmentId)}))


async def _prepare_application(api: BusinessApi, a: PrepareApplicationArgs) -> ToolOutput:
    draft = await api.post(
        "/applications/drafts",
        {
            "type": a.type,
            "enrollmentId": str(a.enrollmentId),
            "reason": a.reason,
            "targetCohortId": str(a.targetCohortId) if a.targetCohortId else None,
        },
    )
    # 确认卡（confirmationId 等）只给 UI，不给模型：模型的产出止于"草稿"，提交只能由用户在界面上确认（AC-004）。
    return ToolOutput(
        data={"applicationId": draft["id"], "revision": draft["revision"], "status": draft["status"], "summary": draft["summary"]},
        artifacts={"confirmation": draft["confirmation"]},
    )


async def _application_status(api: BusinessApi, a: ApplicationStatusArgs) -> ToolOutput:
    if a.applicationId is None:
        page = await api.get("/me/applications")
        return ToolOutput({"items": [_status_view(x) for x in page["items"]]})
    return ToolOutput(_status_view(await api.get(f"/applications/{a.applicationId}")))


def _status_view(app: dict) -> dict:
    # 只取回答"申请到哪一步了"所需的字段；executionStatus 必须带上——退费批准≠已到账（AC-009）。
    return {k: app.get(k) for k in ("id", "type", "status", "executionStatus", "revision", "summary")}


TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec("getCurrentOffering", "查询当前招生期的课程、开课时间与价格。", NoArgs, _current_offering),
    ToolSpec("getMyEnrollment", "查询我已有的报名（班期、状态）。", NoArgs, _my_enrollment),
    ToolSpec("getMySchedule", "查询某个报名对应班期的课表。", EnrollmentArgs, _my_schedule),
    ToolSpec("getMyProgress", "查询某个报名的学习进度（仅为记录的完成情况，不代表掌握程度）。", EnrollmentArgs, _my_progress),
    ToolSpec("getTransferTargets", "查询某个报名可以申请转入的班期（不承诺批准）。", EnrollmentArgs, _transfer_targets),
    ToolSpec(
        "prepareApplication",
        "为我起草一份转班或退费申请草稿。只生成草稿，不会提交；需要我本人在界面上确认后才会提交。",
        PrepareApplicationArgs,
        _prepare_application,
    ),
    ToolSpec("getApplicationStatus", "查询我的申请进度；不给 applicationId 则列出我的全部申请。", ApplicationStatusArgs, _application_status),
)

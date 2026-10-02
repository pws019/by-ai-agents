"""固定工具契约（design.md §6）。学生 Agent 只有这些工具，没有 approve/confirm/refund，也没有任意 HTTP/SQL。

设计要点：
- 参数模型里没有任何"是谁"的字段：没有 studentId/actorId/userId。身份由运行时注入的 RunContext 决定。
- 每个工具只是"把一个业务 API 调用包成模型可用的函数"，授权判断仍然在业务 API（它会再次按 actor 校验）。
- findReplaySegments/getPrerequisiteLessons 属于 T-28/M5，requestHandoff 属于 T-22，此处不含。
- searchKnowledge（T-27）比其它工具多两个依赖（embedder、向量库），不是单靠 `(api, args)` 就能跑的
  纯业务 API 包装，所以不在下面 TOOL_SPECS 这个"建图时就能确定、不依赖外部资源"的静态元组里，
  由 `build_search_knowledge_spec` 在真正起服务时（main.py）按需注入依赖后单独构造，
  再跟 TOOL_SPECS 拼在一起喂给 ToolRuntime——这样不用为了多两个参数把所有既有测试用的
  TOOL_SPECS 静态元组改成一个工厂函数。
"""
from typing import Literal
from uuid import UUID

from pydantic import Field

from ..embedding.base import Embedder
from ..ingestion.vector_store import VectorStore
from ..retrieval.search import search_knowledge
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


class SearchKnowledgeArgs(ToolArgs):
    query: str = Field(min_length=1, max_length=300)


_SEARCH_KNOWLEDGE_DESCRIPTION = (
    "在我当前班期的课程资料（字幕/讲义）里搜索知识点，返回原文片段、所属课次及真实时间位置；"
    "没有检索到相关内容会明确说明找不到，绝不编造片段。"
)


async def _search_knowledge_not_configured(api: BusinessApi, a: SearchKnowledgeArgs) -> ToolOutput:
    """TOOL_SPECS 里的占位版：没有接 embedder/向量库时的默认行为（比如只测别的工具、不需要
    起 Qdrant/embedding 服务的场景）。"没找到"在这里是诚实的回答，不是在撒谎掩盖"其实没接好"——
    真正起服务时 main.py 会用 build_search_knowledge_spec 构造的版本覆盖掉这一条（ToolRuntime
    按工具名去重，后面的覆盖前面的，见 runtime.py），模型看到的工具清单（schemas()）两种情况下
    都包含 searchKnowledge，不会因为还没接向量库就让图里的 QUERY_TOOLS 白名单校验失败。"""
    return ToolOutput({"found": False, "citations": []})


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
    ToolSpec("searchKnowledge", _SEARCH_KNOWLEDGE_DESCRIPTION, SearchKnowledgeArgs, _search_knowledge_not_configured),
)


def build_search_knowledge_spec(embedder: Embedder, store: VectorStore, dsn: str) -> ToolSpec:
    """embedder/store/dsn 在服务启动时才构造好（main.py），跟其它工具在模块加载时就能确定的
    TOOL_SPECS 不是同一个生命周期，所以单独用工厂函数包一层闭包：main.py 用
    `TOOL_SPECS + (build_search_knowledge_spec(...),)` 拼出真正会用的工具集合，靠
    ToolRuntime 构造时"后面的同名工具覆盖前面的"这条规则，把上面的占位版换成真正接了
    embedder/向量库的版本。"""

    async def _search_knowledge(api: BusinessApi, a: SearchKnowledgeArgs) -> ToolOutput:
        result = await search_knowledge(embedder=embedder, store=store, dsn=dsn, api=api, query=a.query)
        if not result.has_evidence:
            # AC-018：没搜到就明确说没搜到，不把这件事交给模型自由发挥去编一个。
            return ToolOutput({"found": False, "citations": []})
        return ToolOutput(
            data={
                "found": True,
                "citations": [
                    {"lessonId": c.lesson_id, "lessonTitle": c.lesson_title, "text": c.content, "startMs": c.start_ms, "endMs": c.end_ms}
                    for c in result.citations
                ],
            },
            # T-28：citation/replay.card 事件只给 UI，不给模型——跟确认卡同一个理由，model_view()
            # 不包含 artifacts，模型看不到 sourceId/segmentId 这些事件专用字段，省得它复述出来当成
            # 可以编造播放地址的依据。字段集合精确等于 contracts/education/events.schema.json 的
            # citation payload（additionalProperties: false，多一个少一个键都会在事件校验里炸）；
            # 讲义没有时间轴时 startSeconds/endSeconds 必须是 null，不能编一个 0。
            artifacts={
                "citations": [
                    {
                        "sourceId": c.source_id,
                        "sourceVersion": c.source_version,
                        "title": c.lesson_title,
                        "segmentId": c.segment_id,
                        "startSeconds": None if c.start_ms is None else c.start_ms / 1000,
                        "endSeconds": None if c.end_ms is None else c.end_ms / 1000,
                    }
                    for c in result.citations
                ],
            },
        )

    return ToolSpec("searchKnowledge", _SEARCH_KNOWLEDGE_DESCRIPTION, SearchKnowledgeArgs, _search_knowledge)

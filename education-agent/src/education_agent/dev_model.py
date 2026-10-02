"""开发用的确定性"假模型"（EDUCATION_MODE=mock）。

用途：让前端开发和浏览器端到端不依赖真实模型/GPU。它按关键词决定调哪些工具、回答什么，回答内容由工具返回的数据拼出来。
它不是"一个聪明的模型"，通过它只能证明"编排和界面是对的"，**不能**说明真实模型的分类、选工具和措辞是否正确——
两种模式的结果必须分开报告（design.md）。

行为（都是关键词规则，读的是本轮用户消息之后的工具结果）：
- 分类：明确要人工（转人工/找老师…）→ handoff；要办理"退费/转班/换班"→ application；询问已有申请状态或其它 → query
  （见 is_application_request）。
- query：课表 → 先查报名再查该报名的课表；进度 → 先查报名再查进度；可转班期 → 先查报名再查转班目标；
  申请状态 → 查我的申请；招生/价格 → 查当前招生；其它 → 查报名。
- application：先查报名；转班再查转班目标；然后起草（prepareApplication）。草稿一出现循环就会停下等确认（不由本模型控制）。
- 任何工具返回了错误：给一句固定的道歉话术，不重试。
"""
import asyncio
import json
from typing import Any

from .model.base import Message, ModelReply, OnText, ToolCall

APPLICATION_WORDS = ("退费", "转班", "换班")
STATUS_WORDS = ("怎么样", "进度", "状态", "到哪", "批了", "批准")
HANDOFF_WORDS = ("转人工", "人工客服", "找老师", "找真人", "真人客服")
CONTENT_WORDS = ("讲了什么", "讲的是什么", "内容是什么", "笔记", "回放")


def is_application_request(text: str) -> bool:
    """要办理转班/退费。"询问已有申请的状态"（如"我的退费申请怎么样了"）虽然也带这些词，但只是查询，绝不能因此去起草。"""
    asks_status = any(w in text for w in STATUS_WORDS) and ("申请" in text or any(w in text for w in APPLICATION_WORDS))
    return any(w in text for w in APPLICATION_WORDS) and not asks_status


class DemoModel:
    def __init__(self, stream_delay: float = 0.03, chunk_size: int = 3):
        self._delay = stream_delay  # 每段之间的停顿：让界面上"逐字出现"肉眼可见，也便于复现"中途断线"
        self._chunk = chunk_size

    async def chat(self, messages: list[Message], tools: list[dict], on_text: OnText | None = None) -> ModelReply:
        if not tools:
            return ModelReply(text=_classify(_last_user_text(messages)))

        turn = _Turn(messages)
        step = _application_step(turn) if turn.is_application else _query_step(turn)
        if isinstance(step, ToolCall):
            return ModelReply(tool_calls=(step,))
        return await self._say(step, on_text)

    async def _say(self, text: str, on_text: OnText | None) -> ModelReply:
        if on_text is not None:
            for i in range(0, len(text), self._chunk):
                on_text(text[i : i + self._chunk])
                if self._delay:
                    await asyncio.sleep(self._delay)
        return ModelReply(text=text)


# ---- 本轮的上下文 -------------------------------------------------------------------------

class _Turn:
    """本轮（最后一条用户消息之后）已经发生了什么：调用过哪些工具、各返回了什么。"""

    def __init__(self, messages: list[Message]):
        last_user = max(i for i, m in enumerate(messages) if m["role"] == "user")
        self.text = messages[last_user]["content"]
        self.is_application = is_application_request(self.text)
        self.calls_in_history = sum(len(m.get("tool_calls", [])) for m in messages if m["role"] == "assistant")

        names = {c["id"]: c["name"] for m in messages[last_user:] if m["role"] == "assistant" for c in m.get("tool_calls", [])}
        self.results: dict[str, dict] = {}
        for m in messages[last_user:]:
            if m["role"] == "tool" and m["tool_call_id"] in names:
                self.results[names[m["tool_call_id"]]] = json.loads(m["content"])

    def call(self, name: str, args: dict[str, Any]) -> ToolCall:
        # 工具调用 id 必须在整个会话历史里唯一，所以按"历史里已有的调用数"编号。
        return ToolCall(id=f"demo-{self.calls_in_history + 1}", name=name, args=args)

    def data(self, name: str) -> Any:
        return self.results[name]["data"]

    @property
    def failed(self) -> bool:
        return any(not r.get("ok") for r in self.results.values())


def _last_user_text(messages: list[Message]) -> str:
    return next(m["content"] for m in reversed(messages) if m["role"] == "user")


def _classify(text: str) -> str:
    # 明确要人工优先于其它意图："我要转人工处理退费"是在找人，不是在起草退费。
    if any(w in text for w in HANDOFF_WORDS):
        return "handoff"
    return "application" if is_application_request(text) else "query"


def _active_enrollment(turn: _Turn) -> dict | None:
    items = turn.data("getMyEnrollment").get("items", [])
    return next((e for e in items if e.get("status") == "active"), None)


# ---- query 分支 ---------------------------------------------------------------------------

def _query_step(turn: _Turn) -> ToolCall | str:
    if turn.failed:
        return "抱歉，查询时出了点问题，请稍后再试。"
    t = turn.text

    if any(w in t for w in ("招生", "价格", "多少钱", "开班")):
        return _offering_text(turn.data("getCurrentOffering")) if "getCurrentOffering" in turn.results else turn.call("getCurrentOffering", {})
    if "申请" in t or any(w in t for w in APPLICATION_WORDS):  # 走到这里的"申请/退费/转班"都是在问状态
        return _applications_text(turn.data("getApplicationStatus")) if "getApplicationStatus" in turn.results else turn.call("getApplicationStatus", {})
    if any(w in t for w in CONTENT_WORDS):  # 问课程内容/回放，T-27 加的工具，不走报名链路
        return turn.call("searchKnowledge", {"query": t}) if "searchKnowledge" not in turn.results else _knowledge_text(turn.data("searchKnowledge"))

    wanted = next((tool for words, tool in (
        (("课表", "课程表", "上课", "下节课"), "getMySchedule"),
        (("进度", "学到哪"), "getMyProgress"),
        (("可转", "转入", "班期"), "getTransferTargets"),
    ) if any(w in t for w in words)), None)

    if "getMyEnrollment" not in turn.results:
        return turn.call("getMyEnrollment", {})
    enrollment = _active_enrollment(turn)
    if wanted is None:
        return _enrollments_text(turn.data("getMyEnrollment"))
    if enrollment is None:
        return "你目前没有在读的报名。"
    if wanted not in turn.results:
        return turn.call(wanted, {"enrollmentId": enrollment["enrollmentId"]})
    data = turn.data(wanted)
    return {"getMySchedule": _schedule_text, "getMyProgress": _progress_text, "getTransferTargets": _targets_text}[wanted](data)


# ---- application 分支 ---------------------------------------------------------------------

def _application_step(turn: _Turn) -> ToolCall | str:
    if "prepareApplication" in turn.results:
        # 草稿产生时循环已经停下，不会再问模型；走到这里说明起草被业务 API 拒绝了（如已有进行中的同类申请）。
        return "这个报名已经有一份进行中的同类申请了，请先到“我的申请”里处理。"
    if turn.failed:
        return "抱歉，办理时出了点问题，请稍后再试。"

    if "getMyEnrollment" not in turn.results:
        return turn.call("getMyEnrollment", {})
    enrollment = _active_enrollment(turn)
    if enrollment is None:
        return "你目前没有在读的报名，无法办理。"

    kind = "refund" if "退费" in turn.text else "transfer"
    args: dict[str, Any] = {"type": kind, "enrollmentId": enrollment["enrollmentId"], "reason": turn.text.strip()[:2000]}
    if kind == "refund":
        return turn.call("prepareApplication", args)

    if "getTransferTargets" not in turn.results:
        return turn.call("getTransferTargets", {"enrollmentId": enrollment["enrollmentId"]})
    targets = turn.data("getTransferTargets").get("items", [])
    if not targets:
        return "目前没有可以转入的班期，暂时无法起草转班申请。"
    return turn.call("prepareApplication", {**args, "targetCohortId": targets[0]["cohortId"]})


# ---- 回答文本（由工具返回的数据拼出）-------------------------------------------------------

def _enrollments_text(data: dict) -> str:
    items = data.get("items", [])
    if not items:
        return "你目前还没有报名。"
    parts = [f"{e['cohort']['name']}（{'在读' if e['status'] == 'active' else '已结束'}）" for e in items]
    return f"你共有 {len(items)} 个报名：" + "、".join(parts) + "。"


def _schedule_text(data: dict) -> str:
    lessons = data.get("items", [])
    if not lessons:
        return "这个班期还没有排课。"
    titles = "、".join(f"「{l['title']}」" for l in lessons[:3])
    return f"这个班期共 {len(lessons)} 节课，前几节是：{titles}。"


def _progress_text(data: dict) -> str:
    items = data.get("items", [])
    done = sum(1 for p in items if p.get("status") == "completed")
    doing = sum(1 for p in items if p.get("status") == "in_progress")
    return f"目前记录显示：已完成 {done} 节，进行中 {doing} 节。（这只是记录的完成情况，不代表掌握程度。）"


def _targets_text(data: dict) -> str:
    items = data.get("items", [])
    if not items:
        return "目前没有可以转入的班期。"
    return "可以申请转入的班期有：" + "、".join(t["name"] for t in items) + "。（是否批准要等老师处理。）"


def _knowledge_text(data: dict) -> str:
    # AC-018：没搜到就老实说没搜到，不替模型编一句"可能在第几课"之类的猜测。
    if not data.get("found"):
        return "没有找到相关的课程内容。"
    quotes = "；".join(f"「{c['lessonTitle']}」提到：{c['text']}" for c in data.get("citations", []))
    return f"根据课程内容，{quotes}"


def _offering_text(data: dict) -> str:
    return f"当前招生：{data['title']}，价格 {data['priceCents'] / 100:.0f} 元。"


def _applications_text(data: dict) -> str:
    items = data.get("items", [])
    if not items:
        return "你目前没有申请记录。"
    kinds = {"transfer": "转班", "refund": "退费"}
    statuses = {"draft": "草稿", "submitted": "已提交", "needs_info": "需补充信息", "awaiting_student_confirmation": "等你确认新方案",
                "approved": "已批准", "rejected": "未通过", "withdrawn": "已撤回"}
    return "你的申请：" + "；".join(f"{kinds.get(a['type'], a['type'])}（{statuses.get(a['status'], a['status'])}）" for a in items) + "。"

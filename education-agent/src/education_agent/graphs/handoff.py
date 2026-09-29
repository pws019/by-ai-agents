"""转人工的交接摘要：由确定性代码从对话历史里拼出，**不经过模型**。

requirements F-006：摘要包含问题、已核验事实、相关申请、工具失败和待处理事项；不可包含猜测事实。
"已核验"在这里的意思只有两种来源：
  1. 工具的成功返回——那是业务 API 的事实；
  2. 学员自己说的话——原话引用，不改写、不推断。
助手（模型）说过的文字一律不进摘要：那是模型的表述，不是核验过的事实，写进去就等于把猜测交给老师。
工具消息的内容取自 ToolResult.model_view()，本来就不含确认卡和凭证，所以这里也不会带出它们。

摘要的每一节都会出现；没有内容的写"无"。这样老师能区分"没有相关申请"和"忘了写"。
"""
import json
from typing import Any

from ..model.base import Message

# 学员主动请求转人工时，交给 BFF 的原因。固定文案，不取自模型输出。
REASON_STUDENT_REQUEST = "学员主动请求转人工"

MAX_QUOTES = 3  # 最多引用学员最近几句话
QUOTE_CHARS = 200
MAX_LIST_ITEMS = 5

_APPLICATION_TYPE = {"transfer": "转班", "refund": "退费"}
_ENROLLMENT_STATUS = {"active": "在读", "ended": "已结束"}


def build_handoff_summary(messages: list[Message], reason: str) -> str:
    calls = {c["id"]: c["name"] for m in messages if m["role"] == "assistant" for c in m.get("tool_calls", [])}

    facts: list[str] = []
    applications: dict[str, str] = {}  # 申请 id → 一行描述；同一张申请后出现的覆盖先出现的（取最新状态）
    failures: list[str] = []
    for m in messages:
        if m["role"] != "tool":
            continue
        name = calls.get(m.get("tool_call_id", ""), "未知工具")
        payload = _parse(m["content"])
        if payload is None:
            continue
        if not payload.get("ok"):
            code = (payload.get("error") or {}).get("code") or "UNKNOWN"
            failures.append(f"{name}：{code}")
            continue
        data = payload.get("data") or {}
        if name in ("getApplicationStatus", "prepareApplication"):
            for app in _applications_in(name, data):
                applications[app[0]] = app[1]
        else:
            facts.append(_fact(name, data))

    quotes = [_quote(m["content"]) for m in messages if m["role"] == "user" and m.get("content")][-MAX_QUOTES:]

    return "\n".join(
        [
            "【学员诉求】",
            *_bullets([f"“{q}”" for q in quotes]),
            "【已核验事实】",
            *_bullets(_dedupe(facts)),
            "【相关申请】",
            *_bullets(list(applications.values())),
            "【工具失败】",
            *_bullets(_dedupe(failures)),
            "【待处理】",
            f"- {reason}，等待老师接管。",
        ]
    )


def _fact(tool: str, data: dict[str, Any]) -> str:
    """把一次成功的工具调用写成一行事实。只用返回数据里确实存在的字段；认不出结构就只写"查询过"，不猜。"""
    items = data.get("items") if isinstance(data.get("items"), list) else None
    if tool == "getMyEnrollment" and items is not None:
        parts = [f"{(e.get('cohort') or {}).get('name', '未知班期')}（{_ENROLLMENT_STATUS.get(e.get('status'), e.get('status', '状态未知'))}）" for e in items[:MAX_LIST_ITEMS]]
        return f"报名 {len(items)} 个：{'、'.join(parts)}" if parts else "报名：无"
    if tool == "getMySchedule" and items is not None:
        return f"课表共 {len(items)} 节课"
    if tool == "getMyProgress" and items is not None:
        return f"学习进度记录 {len(items)} 条"
    if tool == "getTransferTargets" and items is not None:
        names = [str(t.get("name")) for t in items[:MAX_LIST_ITEMS] if t.get("name")]
        return f"可转入班期 {len(items)} 个" + (f"：{'、'.join(names)}" if names else "")
    return f"已查询 {tool}"


def _applications_in(tool: str, data: dict[str, Any]) -> list[tuple[str, str]]:
    """从 getApplicationStatus（单张或列表）和 prepareApplication 的返回里取出申请，写成 (id, 一行描述)。"""
    if tool == "prepareApplication":
        rows = [{"id": data.get("applicationId"), "status": data.get("status"), "revision": data.get("revision"),
                 "type": (data.get("summary") or {}).get("type")}]
    elif isinstance(data.get("items"), list):
        rows = data["items"]
    else:
        rows = [data]
    out = []
    for r in rows:
        app_id = r.get("id")
        if not isinstance(app_id, str):
            continue
        label = _APPLICATION_TYPE.get(r.get("type"), "")
        line = f"{label}申请，状态 {r.get('status', '未知')}"
        if r.get("executionStatus"):
            line += f"，执行 {r['executionStatus']}"
        if r.get("revision") is not None:
            line += f"，第 {r['revision']} 版"
        out.append((app_id, f"{line}（id {app_id[:8]}）"))
    return out


def _parse(content: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(content)
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _quote(text: str) -> str:
    text = " ".join(text.split())  # 折叠换行和连续空白，让摘要每条一行
    return text if len(text) <= QUOTE_CHARS else text[:QUOTE_CHARS] + "…"


def _bullets(lines: list[str]) -> list[str]:
    return [f"- {line}" for line in lines] if lines else ["- 无"]


def _dedupe(lines: list[str]) -> list[str]:
    return list(dict.fromkeys(lines))

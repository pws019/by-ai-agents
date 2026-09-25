"""学员服务图（外层）。固定流程，模型只在其中的特定环节发挥：

    load_authorized_context → route ─┬─ query        ─┐
                                     └─ application  ─┴→ respond ─┬─ (无需确认) → END
                                                                  └─ (有确认卡) → await_confirmation → verify_outcome → END

- load_authorized_context：纯代码。重置本轮的临时字段，检查工作证是否有效。
- route：让模型把用户意图归到有限的几类之一（模糊的分类，正是模型擅长的）。输出被限定在白名单里，认不出就走 query。
  分类的目的不只是"分流"，更是**最小权限**：query 分支根本拿不到 prepareApplication，
  即使学员在对话里诱导模型起草申请，它在这个分支里也调用不到。
- query / application：各自运行一个内层 ReAct 循环（loop.py），只暴露本分支的工具子集。
- respond：纯代码。需要固定话术的情形（确认卡、预算耗尽、登录过期）由代码给出，不让模型即兴发挥。
- await_confirmation：只做一件事——interrupt，把"话术 + 确认卡"交给调用方，然后停在这里，等学员在界面上确认。
  恢复时本节点会从头重跑，所以 interrupt 之前不做任何有副作用的事。
- verify_outcome：恢复后运行，纯代码。**不相信恢复信号里说了什么**，而是重新向业务 API 读取申请的最新事实再回话
  （"确认"文本不是授权：真正的确认是学员在界面上对业务 API 的那次 POST，Agent 全程没有确认的能力）。

约定（T-20 需要遵守）：
- 恢复信号（Command(resume=...)）只是"叫醒图"，它的内容不参与任何决定。
- 线程 id 必须由已校验的 actor 派生（例如 "{actorId}:{会话id}"）。图的输入在节点运行之前就已写入 checkpoint，
  所以"别人往我的线程里发消息"无法在图内阻止，只能靠调用方保证线程属于该 actor。
- 挂起时学员没点确认、而是发了新消息：LangGraph 把它当作新的一轮从头运行，旧的挂起被丢弃；草稿仍留在业务库里，可随时在界面确认。

状态里只有可 JSON 序列化的普通数据。RunContext（含签名 token）和 RunBudget 通过 LangGraph 的 context= 通道
按次传入：它不会写进 checkpoint，恢复时可以换一份新的（见 progress.md T-19 设计决定的实测）。
"""
import operator
from dataclasses import dataclass
from typing import Annotated, TypedDict

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import interrupt

from ..model.base import ChatModel, Message
from ..tools.context import RunContext
from ..tools.runtime import ToolRuntime
from ..tools.spec import RunBudget
from .loop import run_tool_loop

QUERY_TOOLS = {"getCurrentOffering", "getMyEnrollment", "getMySchedule", "getMyProgress", "getTransferTargets", "getApplicationStatus"}
APPLICATION_TOOLS = {"getMyEnrollment", "getTransferTargets", "prepareApplication", "getApplicationStatus"}

BRANCHES = ("query", "application")
DEFAULT_BRANCH = "query"

ROUTE_PROMPT = (
    "你是学员服务的意图分类器。根据对话判断学员最新一条消息的意图，只输出下面其中一个词，不要输出别的：\n"
    "query：查询课程、课表、进度、已有申请的状态等信息\n"
    "application：想申请转班或退费"
)
QUERY_PROMPT = "你是学员服务助手。只使用提供的工具查询信息并如实回答；工具没有给出的信息不要编造。"
APPLICATION_PROMPT = (
    "你是学员服务助手，正在帮学员起草转班或退费申请。先用工具了解报名和可选班期，"
    "信息足够时调用 prepareApplication 生成草稿。你不能提交申请：提交必须由学员本人在界面上确认。"
)

REPLY_NEEDS_CONFIRMATION = "我已为你起草好申请草稿。它还没有提交，需要你在界面上核对并确认后才会正式提交。"
REPLY_BUDGET_EXHAUSTED = "这个问题需要的查询步骤太多，我先停在这里。请把问题说得更具体一些再试一次。"
REPLY_AUTH_EXPIRED = "登录状态已过期，请重新发送一次消息。"
REPLY_EMPTY = "抱歉，我没能给出有效的回答，请换个说法再试一次。"
REPLY_STILL_DRAFT = "我还没有看到你的确认，申请目前仍是草稿，没有提交。你可以随时在界面上核对并确认。"
REPLY_DRAFT_CHANGED = "这份草稿的内容在起草之后有更新，之前那张确认卡已经不适用了。请在界面上核对最新内容后再确认。"
REPLY_APPLICATION_NOT_FOUND = "我没能找到这份申请，请到\u201c我的申请\u201d里查看。"
REPLY_STATUS_UNAVAILABLE = "暂时无法查询这份申请的状态，请稍后到\u201c我的申请\u201d里查看。"

# 申请已离开草稿之后的状态说明（状态名来自业务 API）。
STATUS_TEXT = {
    "submitted": "已提交，等待老师处理",
    "needs_info": "老师需要你补充信息",
    "awaiting_student_confirmation": "老师给出了新的方案，等你确认",
    "approved": "已批准",
    "rejected": "未通过",
    "withdrawn": "已撤回",
}
# 批准不等于已执行（AC-009）：有执行状态时一并说明，不把"已批准"说成"已到账/已完成"。
EXECUTION_TEXT = {"not_started": "尚未开始执行", "pending": "正在执行", "completed": "已执行完成", "failed": "执行失败"}


class GraphState(TypedDict, total=False):
    messages: Annotated[list[Message], operator.add]  # 对话历史，节点只返回"新增的"，由 reducer 追加
    branch: str
    stop_reason: str
    reply: str
    confirmation: dict | None  # 确认卡：给 UI/图用，不进入 messages（不让模型看到）；verify_outcome 之后清空


@dataclass(frozen=True)
class RunScope:
    """一次运行专属的、不应被持久化的东西。"""

    ctx: RunContext
    budget: RunBudget


def build_student_graph(model: ChatModel, tools: ToolRuntime, checkpointer: BaseCheckpointSaver | None = None):
    query_tools = tools.restricted_to(QUERY_TOOLS)
    application_tools = tools.restricted_to(APPLICATION_TOOLS)

    async def load_authorized_context(state: GraphState, runtime: Runtime[RunScope]) -> GraphState:
        # 每轮重置临时字段：状态跨轮保留，上一轮的确认卡/结束原因不能带到这一轮。
        fresh: GraphState = {"branch": "", "stop_reason": "", "reply": "", "confirmation": None}
        if runtime.context.ctx.is_expired():
            return {**fresh, "stop_reason": "auth_expired"}
        return fresh  # M4 起，这里还要取出学员有权访问的班期/内容范围，供检索过滤使用

    async def route(state: GraphState) -> GraphState:
        # 只把"文字往来"给分类模型：历史里的工具调用/结果对分类没有帮助，还要求接口在没有 tools 的情况下接受 tool 消息。
        reply = await model.chat([_system(ROUTE_PROMPT), *_text_turns(state["messages"])], [])
        label = reply.text.strip().lower()
        return {"branch": label if label in BRANCHES else DEFAULT_BRANCH}

    def branch_node(branch_tools: ToolRuntime, prompt: str):
        async def node(state: GraphState, runtime: Runtime[RunScope]) -> GraphState:
            # system 提示每次现拼，不存进历史：它是代码里的常量，存了只会随历史膨胀，也会让改提示词无法生效。
            result = await run_tool_loop(
                model=model, tools=branch_tools, ctx=runtime.context.ctx, budget=runtime.context.budget,
                messages=[_system(prompt), *state["messages"]],
            )
            return {
                "messages": result.new_messages, "stop_reason": result.stop,
                "reply": result.text, "confirmation": result.confirmation,
            }
        return node

    async def respond(state: GraphState) -> GraphState:
        stop, reply = state["stop_reason"], state["reply"]
        if stop == "answered" and reply.strip():
            return {}  # 最终回答和对应的 assistant 消息已经由循环写好
        text = {
            "needs_confirmation": REPLY_NEEDS_CONFIRMATION,
            "budget_exhausted": REPLY_BUDGET_EXHAUSTED,
            "auth_expired": REPLY_AUTH_EXPIRED,
        }.get(stop, REPLY_EMPTY)
        return {"reply": text, "messages": [{"role": "assistant", "content": text}]}

    async def await_confirmation(state: GraphState) -> GraphState:
        # 恢复时本节点从头重跑：interrupt 之前只读状态，不做任何有副作用的事。
        # 返回值（恢复信号）故意丢弃：它只是"叫醒"，不是授权，见 verify_outcome。
        interrupt({
            "type": "need_confirmation",
            "reply": state["reply"],
            "confirmation": state["confirmation"],
        })
        return {}

    async def verify_outcome(state: GraphState, runtime: Runtime[RunScope]) -> GraphState:
        card = state["confirmation"]
        # 复用 ToolRuntime：同样的身份注入（这次用的是恢复时新传入的工作证）、预算、超时和错误收口。
        res = await application_tools.call(
            "getApplicationStatus", {"applicationId": card["applicationId"]}, runtime.context.ctx, runtime.context.budget
        )
        text = _outcome_text(res.ok, res.error_code, res.data, card["revision"])
        return {"reply": text, "messages": [{"role": "assistant", "content": text}], "stop_reason": "resolved", "confirmation": None}

    def after_respond(state: GraphState) -> str:
        return "await_confirmation" if state["stop_reason"] == "needs_confirmation" else END

    def after_authorize(state: GraphState) -> str:
        return "respond" if state["stop_reason"] == "auth_expired" else "route"

    g = StateGraph(GraphState, context_schema=RunScope)
    g.add_node("load_authorized_context", load_authorized_context)
    g.add_node("route", route)
    g.add_node("query", branch_node(query_tools, QUERY_PROMPT))
    g.add_node("application", branch_node(application_tools, APPLICATION_PROMPT))
    g.add_node("respond", respond)
    g.add_node("await_confirmation", await_confirmation)
    g.add_node("verify_outcome", verify_outcome)

    g.add_edge(START, "load_authorized_context")
    g.add_conditional_edges("load_authorized_context", after_authorize, ["route", "respond"])
    g.add_conditional_edges("route", lambda s: s["branch"], list(BRANCHES))
    g.add_edge("query", "respond")
    g.add_edge("application", "respond")
    g.add_conditional_edges("respond", after_respond, ["await_confirmation", END])
    g.add_edge("await_confirmation", "verify_outcome")
    g.add_edge("verify_outcome", END)
    return g.compile(checkpointer=checkpointer)


def _system(text: str) -> Message:
    return {"role": "system", "content": text}


def _text_turns(messages: list[Message]) -> list[Message]:
    return [m for m in messages if m["role"] in ("user", "assistant") and m["content"] and not m.get("tool_calls")]


def _outcome_text(ok: bool, error_code: str | None, data: dict | None, drafted_revision: int) -> str:
    """恢复后根据业务 API 返回的最新事实给出话术。"""
    if not ok:
        return {"NOT_FOUND": REPLY_APPLICATION_NOT_FOUND, "AUTH_EXPIRED": REPLY_AUTH_EXPIRED}.get(error_code, REPLY_STATUS_UNAVAILABLE)
    assert data is not None
    status = data["status"]
    if status == "draft":
        # 仍是草稿：要么学员没确认；要么草稿被改过，原来的确认卡已失效（revision 变了）。
        return REPLY_DRAFT_CHANGED if data["revision"] != drafted_revision else REPLY_STILL_DRAFT
    text = f"你的申请{STATUS_TEXT.get(status, '状态已更新')}。"
    execution = data.get("executionStatus")
    if status == "approved" and execution:
        text += f"（{EXECUTION_TEXT.get(execution, execution)}）"
    return text

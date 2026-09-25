"""学员服务图（外层）。固定流程，模型只在其中的特定环节发挥：

    load_authorized_context → route ─┬─ query        ─┐
                                     └─ application  ─┴→ respond → END

- load_authorized_context：纯代码。重置本轮的临时字段，检查工作证是否有效。
- route：让模型把用户意图归到有限的几类之一（模糊的分类，正是模型擅长的）。输出被限定在白名单里，认不出就走 query。
  分类的目的不只是"分流"，更是**最小权限**：query 分支根本拿不到 prepareApplication，
  即使学员在对话里诱导模型起草申请，它在这个分支里也调用不到。
- query / application：各自运行一个内层 ReAct 循环（loop.py），只暴露本分支的工具子集。
- respond：纯代码。需要固定话术的情形（确认卡、预算耗尽、登录过期）由代码给出，不让模型即兴发挥。

状态里只有可 JSON 序列化的普通数据。RunContext（含签名 token）和 RunBudget 通过 LangGraph 的 context= 通道
按次传入：它不会写进 checkpoint，恢复时可以换一份新的（见 progress.md T-19 设计决定的实测）。
"""
import operator
from dataclasses import dataclass
from typing import Annotated, TypedDict

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime

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


class GraphState(TypedDict, total=False):
    messages: Annotated[list[Message], operator.add]  # 对话历史，节点只返回"新增的"，由 reducer 追加
    branch: str
    stop_reason: str
    reply: str
    confirmation: dict | None  # 确认卡：给 UI/图用，不进入 messages（不让模型看到）


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

    def after_authorize(state: GraphState) -> str:
        return "respond" if state["stop_reason"] == "auth_expired" else "route"

    g = StateGraph(GraphState, context_schema=RunScope)
    g.add_node("load_authorized_context", load_authorized_context)
    g.add_node("route", route)
    g.add_node("query", branch_node(query_tools, QUERY_PROMPT))
    g.add_node("application", branch_node(application_tools, APPLICATION_PROMPT))
    g.add_node("respond", respond)

    g.add_edge(START, "load_authorized_context")
    g.add_conditional_edges("load_authorized_context", after_authorize, ["route", "respond"])
    g.add_conditional_edges("route", lambda s: s["branch"], list(BRANCHES))
    g.add_edge("query", "respond")
    g.add_edge("application", "respond")
    g.add_edge("respond", END)
    return g.compile(checkpointer=checkpointer)


def _system(text: str) -> Message:
    return {"role": "system", "content": text}


def _text_turns(messages: list[Message]) -> list[Message]:
    return [m for m in messages if m["role"] in ("user", "assistant") and m["content"] and not m.get("tool_calls")]

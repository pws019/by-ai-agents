"""内层 ReAct 循环：模型提出工具调用 → ToolRuntime 执行 → 结果回填 → 模型继续，直到给出最终回答。

这是一个"普通函数"，不依赖 LangGraph：图的节点调用它，它自己不知道图的存在。这样它可以被单独测试，
也方便以后和 create_agent 做对照。

保证的性质（每一条都有对应测试）：
- 一定会结束：每一轮要么没有工具调用（结束），要么至少调用一次 ToolRuntime，而 ToolRuntime 每次调用都消耗预算，
  预算耗尽后循环立即停止。所以最多循环 max_calls 轮，不需要另设"最大轮数"。
- 模型每提出一个 tool_call，历史里就一定有一条对应的 tool 消息（哪怕是被跳过/被拒绝的），
  否则下一次请求会被模型接口当作非法历史拒绝。
- 一出现确认卡就立刻停下，不再让模型继续说话或继续调用：模型的产出止于"草稿"（AC-004）。
"""
import json
from dataclasses import dataclass
from typing import Literal

from ..model.base import ChatModel, Message
from ..tools.context import RunContext
from ..tools.runtime import ToolRuntime
from ..tools.spec import RunBudget

StopReason = Literal["answered", "needs_confirmation", "budget_exhausted", "auth_expired"]

# 这两种错误之后，继续让模型调用工具毫无意义（后续每次调用都会同样失败），直接停下。
_FATAL_CODES: dict[str, StopReason] = {"BUDGET_EXCEEDED": "budget_exhausted", "AUTH_EXPIRED": "auth_expired"}


@dataclass(frozen=True)
class LoopResult:
    new_messages: list[Message]  # 本次循环新增的消息（assistant / tool），不含传入的历史
    stop: StopReason
    text: str = ""  # stop == "answered" 时的最终回答
    confirmation: dict | None = None  # stop == "needs_confirmation" 时的确认卡，只给 UI/图，从不进入 messages


async def run_tool_loop(
    *, model: ChatModel, tools: ToolRuntime, ctx: RunContext, budget: RunBudget, messages: list[Message]
) -> LoopResult:
    history = list(messages)
    new: list[Message] = []

    def add(m: Message) -> None:
        history.append(m)
        new.append(m)

    while True:
        reply = await model.chat(history, tools.schemas())

        assistant: Message = {"role": "assistant", "content": reply.text}
        if reply.tool_calls:
            assistant["tool_calls"] = [{"id": c.id, "name": c.name, "args": c.args} for c in reply.tool_calls]
        add(assistant)

        if not reply.tool_calls:
            return LoopResult(new, "answered", text=reply.text)

        confirmation: dict | None = None
        stop: StopReason | None = None
        for call in reply.tool_calls:
            if confirmation is not None:
                # 同一条回复里已经产生了确认卡：其余调用不再执行（否则可能起草出第二份草稿），
                # 但仍要给一条 tool 消息，保证历史合法。
                add(_tool_message(call.id, {"ok": False, "error": {"code": "SKIPPED"}}))
                continue

            result = await tools.call(call.name, call.args, ctx, budget)
            add(_tool_message(call.id, result.model_view()))  # model_view：确认卡与错误细节都不在里面

            if "confirmation" in result.artifacts:
                confirmation = result.artifacts["confirmation"]
            if result.error_code in _FATAL_CODES:
                stop = stop or _FATAL_CODES[result.error_code]

        if confirmation is not None:
            return LoopResult(new, "needs_confirmation", confirmation=confirmation)
        if stop is not None:
            return LoopResult(new, stop)


def _tool_message(call_id: str, payload: dict) -> Message:
    return {"role": "tool", "content": json.dumps(payload, ensure_ascii=False), "tool_call_id": call_id}

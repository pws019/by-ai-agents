"""T-04 spike：工具 → 中断 → 重启 → 恢复。

节点只做最小的事，目的是让"哪些代码在恢复时重跑"可被观察：
每个节点进入时调用 log(thread_id, node)，日志存在 Postgres，进程重启后仍在。
"""
from collections.abc import Awaitable, Callable
from typing import TypedDict

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

Log = Callable[[str, str], Awaitable[None]]


class SpikeState(TypedDict, total=False):
    summary: str
    decision: str
    outcome: str


def build_graph(checkpointer: BaseCheckpointSaver, log: Log):
    def thread_id(config) -> str:
        return config["configurable"]["thread_id"]

    async def draft(state: SpikeState, config) -> SpikeState:
        await log(thread_id(config), "draft")
        # 模拟工具调用：真实系统里这里是"调业务 API 起草申请"，必须幂等。
        return {"summary": "转班草稿：从 A 班转到 B 班（合成数据）"}

    async def confirm(state: SpikeState, config) -> SpikeState:
        # 注意：恢复时本节点从头重跑，所以这行日志会出现两次。
        # interrupt 之前不能做不可幂等的写入。
        await log(thread_id(config), "confirm:enter")
        decision = interrupt({"summary": state["summary"]})
        await log(thread_id(config), "confirm:resumed")
        return {"decision": decision}

    async def finalize(state: SpikeState, config) -> SpikeState:
        await log(thread_id(config), "finalize")
        return {"outcome": "executed" if state["decision"] == "confirm" else "cancelled"}

    g = StateGraph(SpikeState)
    g.add_node("draft", draft)
    g.add_node("confirm", confirm)
    g.add_node("finalize", finalize)
    g.add_edge(START, "draft")
    g.add_edge("draft", "confirm")
    g.add_edge("confirm", "finalize")
    g.add_edge("finalize", END)
    return g.compile(checkpointer=checkpointer)

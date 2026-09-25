"""工具契约的类型：一个工具由什么构成、执行结果长什么样。"""
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict

from .client import BusinessApi


class ToolArgs(BaseModel):
    """所有工具参数模型的基类。extra="forbid"：模型多传任何字段（比如 studentId、actorId）都直接校验失败，
    而不是被悄悄忽略——"被忽略"意味着这条契约的边界靠运气，"被拒绝"才是显式的边界，也能在日志里看到模型试过什么。
    """

    model_config = ConfigDict(extra="forbid")


@dataclass(frozen=True)
class ToolOutput:
    """处理函数的返回值。data 给模型看；artifacts 只给 UI/图（比如确认卡），不会进入模型可见的结果。"""

    data: dict[str, Any]
    artifacts: dict[str, Any] = field(default_factory=dict)


Handler = Callable[[BusinessApi, Any], Awaitable[ToolOutput]]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    args_model: type[ToolArgs]
    handler: Handler
    timeout_s: float = 5.0


@dataclass(frozen=True)
class ToolResult:
    ok: bool
    data: dict[str, Any] | None = None
    error_code: str | None = None
    artifacts: dict[str, Any] = field(default_factory=dict)

    def model_view(self) -> dict[str, Any]:
        """模型能看到的结果：成功给 data，失败只给错误码和固定文案。artifacts（确认卡等）永远不在里面。"""
        if self.ok:
            return {"ok": True, "data": self.data}
        return {"ok": False, "error": {"code": self.error_code}}


@dataclass
class RunBudget:
    """一次 Agent 运行内允许的工具调用总次数（design.md：服务端限制总调用次数）。可变对象，由调用方按 run 创建。"""

    max_calls: int = 8
    used: int = 0

"""模型层的接口与类型。图和节点只依赖这里，不依赖任何具体的模型库（LangChain、httpx……）。

消息用"OpenAI 风格的普通字典"，而不是 LangChain 的消息类：
    {"role": "system" | "user", "content": str}
    {"role": "assistant", "content": str, "tool_calls": [{"id": str, "name": str, "args": dict}]}   # tool_calls 可省
    {"role": "tool", "content": str, "tool_call_id": str}
原因：消息历史会进入图状态、被 checkpoint 持久化。普通字典天然可 JSON 序列化，
不会把某个库的类型和版本永久地写进数据库；也让换实现不需要动图和测试。
"""
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

Message = dict[str, Any]


@dataclass(frozen=True)
class ToolCall:
    """模型"提出"的一次工具调用。此时什么都还没执行——执行与否、以谁的身份执行，是 ToolRuntime 的事。"""

    id: str
    name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class ModelReply:
    """模型的一次回复：要么是给用户的文本，要么带着一些工具调用（也可能两者都有）。"""

    text: str = ""
    tool_calls: tuple[ToolCall, ...] = ()


OnText = Callable[[str], None]


class ChatModel(Protocol):
    async def chat(self, messages: list[Message], tools: list[dict], on_text: OnText | None = None) -> ModelReply:
        """tools 就是 ToolRuntime.schemas() 的返回值（name/description/parameters）。传空列表表示这一轮不允许调工具。

        on_text：给了就逐段回调模型正在生成的文本（用于流式输出），不给就等完整结果。
        无论哪种，返回的都是完整的 ModelReply——流式只是"边生成边通知"，不改变返回值。
        """
        ...

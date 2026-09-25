"""mock 模型：按预先写好的脚本依次回复，并记录每次收到了什么。

只用于验证"编排是否正确"（图怎么走、工具怎么调、确认怎么中断）。它通过不代表真实模型也能做对——
两种模式的结果必须分开报告（design.md）。
"""
from .base import Message, ModelReply


class ScriptedModel:
    def __init__(self, replies: list[ModelReply]):
        self._replies = list(replies)
        self.calls: list[tuple[list[Message], list[dict]]] = []  # 每次收到的 (messages, tools)，供测试断言

    async def chat(self, messages: list[Message], tools: list[dict]) -> ModelReply:
        self.calls.append((list(messages), list(tools)))
        if not self._replies:
            # 脚本用完还被调用，说明被测代码比预期多调了一次模型：让它大声失败，而不是悄悄返回空回复。
            raise AssertionError("ScriptedModel 的脚本已用完，但又被调用了一次")
        return self._replies.pop(0)

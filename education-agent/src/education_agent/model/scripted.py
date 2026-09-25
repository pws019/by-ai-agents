"""mock 模型：按预先写好的脚本依次回复，并记录每次收到了什么。

只用于验证"编排是否正确"（图怎么走、工具怎么调、确认怎么中断）。它通过不代表真实模型也能做对——
两种模式的结果必须分开报告（design.md）。
"""
from .base import Message, ModelReply, OnText


class ScriptedModel:
    def __init__(self, replies: list[ModelReply], chunk_size: int = 4):
        self._replies = list(replies)
        self._chunk_size = chunk_size  # 流式时每段多少个字符；默认取小值，让测试总能覆盖"多段"的情形
        self.calls: list[tuple[list[Message], list[dict]]] = []  # 每次收到的 (messages, tools)，供测试断言
        self.streamed: list[bool] = []  # 每次调用时调用方是否要求流式

    async def chat(self, messages: list[Message], tools: list[dict], on_text: OnText | None = None) -> ModelReply:
        self.calls.append((list(messages), list(tools)))
        self.streamed.append(on_text is not None)
        if not self._replies:
            # 脚本用完还被调用，说明被测代码比预期多调了一次模型：让它大声失败，而不是悄悄返回空回复。
            raise AssertionError("ScriptedModel 的脚本已用完，但又被调用了一次")
        reply = self._replies.pop(0)
        if on_text is not None:
            for i in range(0, len(reply.text), self._chunk_size):
                on_text(reply.text[i : i + self._chunk_size])
        return reply

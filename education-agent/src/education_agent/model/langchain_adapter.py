"""真实模型：用 LangChain 的 ChatOpenAI 连任何 OpenAI 兼容端点（微调后的 Qwen 也这样对外提供）。

LangChain 只存在于这个文件里：进来时把普通字典消息转成 LangChain 消息，出去时把结果转回 ModelReply。
图状态、checkpoint、测试都看不到 LangChain 的类型。
"""
import json

import httpx
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI

from .base import Message, ModelReply, OnText, ToolCall

# 模型给出的工具参数不是合法 JSON 时，LangChain 把它放进 invalid_tool_calls 而不是 tool_calls。
# 我们不能悄悄丢掉它（模型会以为自己调用过了），也不能用空参数去调（会误调用无参工具）。
# 所以转成一个带此标记键的 ToolCall：ToolArgs 是 extra="forbid"，ToolRuntime 会把它判为 INVALID_ARGS，
# 模型随后收到错误并可以重试——复用了已有的失败通路，不需要新的特殊分支。
UNPARSABLE_ARGS_KEY = "__unparsable_arguments__"


def create_langchain_model(
    base_url: str,
    api_key: str,
    model: str,
    *,
    temperature: float = 0.0,
    http_async_client: httpx.AsyncClient | None = None,
) -> "LangChainChatModel":
    """注意：langchain-openai 默认会注入自定义 transport，关闭 httpx 对系统代理的自动识别。
    如果开发环境走代理，传入自己配置好的 http_async_client。"""
    llm = ChatOpenAI(
        model=model, base_url=base_url, api_key=api_key, temperature=temperature, http_async_client=http_async_client
    )
    return LangChainChatModel(llm)


class LangChainChatModel:
    def __init__(self, llm: BaseChatModel):
        self._llm = llm

    async def chat(self, messages: list[Message], tools: list[dict], on_text: OnText | None = None) -> ModelReply:
        llm = self._llm.bind_tools([_as_openai_tool(t) for t in tools]) if tools else self._llm
        lc_messages = [_to_langchain(m) for m in messages]
        if on_text is None:
            ai: AIMessage = await llm.ainvoke(lc_messages)
        else:
            ai = await _stream_and_merge(llm, lc_messages, on_text)
        bad = _ids_with_unparsable_args(ai)
        calls = [
            ToolCall(id=c["id"], name=c["name"], args={UNPARSABLE_ARGS_KEY: True} if c["id"] in bad else c["args"])
            for c in ai.tool_calls
        ]
        calls += [
            ToolCall(id=c.get("id") or "", name=c.get("name") or "", args={UNPARSABLE_ARGS_KEY: True})
            for c in ai.invalid_tool_calls
        ]
        return ModelReply(text=ai.text, tool_calls=tuple(calls))


def _as_openai_tool(schema: dict) -> dict:
    return {
        "type": "function",
        "function": {"name": schema["name"], "description": schema["description"], "parameters": schema["parameters"]},
    }


def _to_langchain(m: Message) -> BaseMessage:
    role = m["role"]
    if role == "system":
        return SystemMessage(m["content"])
    if role == "user":
        return HumanMessage(m["content"])
    if role == "assistant":
        calls = [{"id": c["id"], "name": c["name"], "args": c["args"], "type": "tool_call"} for c in m.get("tool_calls", [])]
        return AIMessage(content=m["content"], tool_calls=calls)
    if role == "tool":
        return ToolMessage(content=m["content"], tool_call_id=m["tool_call_id"])
    raise ValueError(f"未知的消息角色: {role}")


async def _stream_and_merge(llm, messages: list[BaseMessage], on_text: OnText) -> AIMessage:
    """逐块读取模型输出：文本块立刻回调；所有块用 + 合并成一条完整消息（工具调用的参数也是分块到达的，合并后才是完整 JSON）。"""
    merged = None
    async for chunk in llm.astream(messages):
        if chunk.text:
            on_text(chunk.text)
        merged = chunk if merged is None else merged + chunk
    return merged if merged is not None else AIMessage(content="")


def _ids_with_unparsable_args(ai: AIMessage) -> set[str]:
    """流式合并后的 tool_calls 会把坏掉的 JSON 参数宽松地解析成 {}（实测），这样一个无参工具（如 getMyEnrollment）
    就会被"空参数"悄悄调用。合并消息里的 tool_call_chunks 还保留着拼接后的原始参数字符串，据此重新校验：
    非空且不是合法 JSON 对象的，都算不可解析。非流式路径没有 tool_call_chunks，LangChain 已把坏参数放进 invalid_tool_calls。
    """
    bad: set[str] = set()
    for chunk in getattr(ai, "tool_call_chunks", None) or []:
        raw = chunk.get("args") or ""
        if not raw.strip():
            continue  # 无参调用常见的空字符串，等价于 {}
        try:
            ok = isinstance(json.loads(raw), dict)
        except ValueError:
            ok = False
        if not ok and chunk.get("id"):
            bad.add(chunk["id"])
    return bad

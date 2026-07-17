from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str = Field(..., description="用户本轮的输入内容")
    system: str | None = Field(None, description="覆盖默认 system prompt，一般不需要传")
    max_new_tokens: int = Field(256, ge=1, le=2048)
    temperature: float = Field(
        0.0, ge=0.0, le=2.0, description="默认 0 走贪婪解码，保证客服话术稳定收敛，不随机发散"
    )
    top_p: float = Field(0.9, ge=0.0, le=1.0)


class ChatResponse(BaseModel):
    reply: str
    model_id: str


# ---- OpenAI /v1/chat/completions 兼容协议 ----
# 给 @ai-sdk/openai-compatible（Mastra 用它接入自定义模型服务）这类客户端用，
# 字段命名严格照抄 OpenAI 的 Chat Completions API，不要按自己习惯改名。


class OpenAIChatMessage(BaseModel):
    role: str
    content: str


class OpenAIChatCompletionRequest(BaseModel):
    model: str | None = None
    messages: list[OpenAIChatMessage]
    max_tokens: int = Field(256, ge=1, le=2048)
    temperature: float = Field(
        0.0, ge=0.0, le=2.0, description="默认 0 走贪婪解码，保证客服话术稳定收敛，不随机发散"
    )
    top_p: float = Field(0.9, ge=0.0, le=1.0)
    stream: bool = False

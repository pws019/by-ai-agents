from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str = Field(..., description="用户本轮的输入内容")
    system: str | None = Field(None, description="覆盖默认 system prompt，一般不需要传")
    max_new_tokens: int = Field(256, ge=1, le=2048)
    temperature: float = Field(0.7, ge=0.0, le=2.0)
    top_p: float = Field(0.9, ge=0.0, le=1.0)


class ChatResponse(BaseModel):
    reply: str
    model_id: str

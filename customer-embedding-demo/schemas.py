from pydantic import BaseModel, Field


class EmbedRequest(BaseModel):
    inputs: str | list[str] = Field(description="单条文本或多条文本，兼容 TEI 的 /embed 请求格式")


class OpenAIEmbeddingRequest(BaseModel):
    input: str | list[str] = Field(description="单条文本或多条文本，兼容 /v1/embeddings")
    model: str | None = None


class OpenAIEmbeddingItem(BaseModel):
    object: str = "embedding"
    index: int
    embedding: list[float]


class OpenAIEmbeddingResponse(BaseModel):
    object: str = "list"
    model: str
    data: list[OpenAIEmbeddingItem]


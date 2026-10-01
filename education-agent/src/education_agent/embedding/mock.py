"""mock embedding（EDUCATION_MODE=mock）：不调用任何真实模型，用内容的 sha256 确定性地
生成一个固定维度的向量。只用于验证索引任务本身的编排是否正确（分片怎么落库、哪些要重新
嵌入、怎么激活/撤回/重跑），不代表真实向量的检索质量——跟 dev_model.py 对 ChatModel 是同一个关系。

"确定性"是这里唯一要紧的性质：同样的文本任何时候都产出同样的向量，这样"content_hash 没变
就复用旧向量"这条优化在测试里才能被断言出差异（复用 vs 重新计算，两条路径必须得到同一个结果，
否则测试没法区分"真的复用了"和"重新算出来但刚好跟原来一样"）。真实语义相似度不是它的目标。
"""
import hashlib

from .base import Embedder


class MockEmbedder:
    def __init__(self, dimension: int = 8):
        self.dimension = dimension
        self.calls: list[str] = []  # 记录真正调用过 embed 的文本，供测试断言"这段内容是不是被跳过了"

    async def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.extend(texts)
        return [self._vector(t) for t in texts]

    def _vector(self, text: str) -> list[float]:
        digest = hashlib.sha256(text.encode("utf-8")).digest()  # 32 字节
        raw = (digest * (self.dimension // len(digest) + 1))[: self.dimension]  # 凑够 dimension 个字节
        return [(b - 127.5) / 127.5 for b in raw]  # 缩放到 [-1, 1]

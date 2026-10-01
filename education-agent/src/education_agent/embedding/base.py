"""Embedding 层的接口。索引任务（T-26）和检索（T-27）都只依赖这里，不依赖具体是哪家模型。

跟 model/base.py 的 ChatModel 是同一个理由：mock 和 real 两种实现必须能互换而不改调用方，
两种模式下跑出的索引/检索结果也必须分开报告，不能把 mock 的召回率当真实效果。
"""
from typing import Protocol


class Embedder(Protocol):
    dimension: int  # 这个实现产出的向量维度；建 Qdrant collection 时需要，且全程固定不变

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """按输入顺序一一对应返回向量。空列表输入返回空列表，不发请求。"""
        ...

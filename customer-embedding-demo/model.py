from typing import Iterable

import torch
from sentence_transformers import SentenceTransformer

from config import DEVICE, MAX_LENGTH, MODEL_PATH, NORMALIZE_EMBEDDINGS

model: SentenceTransformer | None = None


def get_device() -> str:
    """选择 embedding 模型运行设备。

    优先级：
    1. EMBEDDING_DEVICE 显式指定
    2. NVIDIA CUDA
    3. Apple Silicon MPS
    4. CPU
    """
    if DEVICE:
        return DEVICE
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model() -> None:
    """懒加载 Qwen3-Embedding-0.6B。

    第一次启动时如果本地没有模型，sentence-transformers 会从 Hugging Face
    或已配置的镜像缓存下载。生产部署时建议把 EMBEDDING_MODEL_PATH 指向预下载的本地目录。
    """
    global model

    if model is not None:
        return

    model = SentenceTransformer(MODEL_PATH, device=get_device())
    model.max_seq_length = MAX_LENGTH


def embed_texts(texts: Iterable[str]) -> list[list[float]]:
    """文本转向量。

    入库时传入 Markdown chunk，查询时传入用户问题。
    返回的二维数组和输入文本一一对应：
    texts[0] -> embeddings[0]
    texts[1] -> embeddings[1]
    """
    load_model()
    assert model is not None

    embeddings = model.encode(
        list(texts),
        normalize_embeddings=NORMALIZE_EMBEDDINGS,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    return embeddings.astype(float).tolist()


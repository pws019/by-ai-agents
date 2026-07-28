import os
from pathlib import Path

DEFAULT_MODEL_PATH = (
    Path(__file__).resolve().parents[1]
    / "customer-service-qlora"
    / "_local_infer"
    / "models"
    / "Qwen3-Embedding-0.6B"
)

MODEL_PATH = os.getenv("EMBEDDING_MODEL_PATH", str(DEFAULT_MODEL_PATH))
MODEL_ID = os.getenv("EMBEDDING_MODEL_ID", "Qwen/Qwen3-Embedding-0.6B")
DEVICE = os.getenv("EMBEDDING_DEVICE", "")
MAX_LENGTH = int(os.getenv("EMBEDDING_MAX_LENGTH", "8192"))
NORMALIZE_EMBEDDINGS = os.getenv("EMBEDDING_NORMALIZE", "true").lower() != "false"

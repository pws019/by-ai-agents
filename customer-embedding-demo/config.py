import os

MODEL_PATH = os.getenv("EMBEDDING_MODEL_PATH", "Qwen/Qwen3-Embedding-0.6B")
MODEL_ID = os.getenv("EMBEDDING_MODEL_ID", "Qwen/Qwen3-Embedding-0.6B")
DEVICE = os.getenv("EMBEDDING_DEVICE", "")
MAX_LENGTH = int(os.getenv("EMBEDDING_MAX_LENGTH", "8192"))
NORMALIZE_EMBEDDINGS = os.getenv("EMBEDDING_NORMALIZE", "true").lower() != "false"


import json
import shutil
from pathlib import Path

import ml_dtypes
import numpy as np
from safetensors.numpy import save_file, load_file

SRC = Path("/Users/whitesmith/Projects/by-ai-agents/customer-service-qlora/saves/qwen3-8b-qlora-sft-v1")
DST = Path("/Users/whitesmith/Projects/by-ai-agents/customer-service-qlora/saves/qwen3-8b-qlora-sft-v1-bf16")

DST.mkdir(parents=True, exist_ok=True)

tensors_in = load_file(SRC / "adapter_model.safetensors")
tensors_out = {}
for name, t in tensors_in.items():
    assert t.dtype == np.float32, f"{name} is {t.dtype}, expected float32"
    tensors_out[name] = t.astype(ml_dtypes.bfloat16)

save_file(tensors_out, DST / "adapter_model.safetensors")

# copy every other file untouched (config/tokenizer/logs/etc.)
for item in SRC.iterdir():
    if item.name == "adapter_model.safetensors":
        continue
    if item.is_dir():
        shutil.copytree(item, DST / item.name, dirs_exist_ok=True)
    else:
        shutil.copy2(item, DST / item.name)

orig_size = (SRC / "adapter_model.safetensors").stat().st_size
new_size = (DST / "adapter_model.safetensors").stat().st_size
print(f"original fp32: {orig_size/1024/1024:.1f} MB")
print(f"converted bf16: {new_size/1024/1024:.1f} MB")
print(f"tensor count: {len(tensors_out)}")

用来验证生成的qlora模型，启动一个http来验证。


大概逻辑
![alt text](image.png)
![alt text](image-1.png)
# 使用py编写工具函数
- 使用FastApi
- 使用torch库

import torch
from fastapi import FastAPI
from pydantic import BaseModel, Field
from peft import PeftModel
from transformers import AutoModelForCausalLM

等等

app = fastapi();

/chat
/health
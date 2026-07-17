# 云主机 QLoRA 训练操作手册

记录从 SSH 登录一台全新的优云智算（compshare.cn）GPU 实例开始，到跑完 QLoRA 训练、拿到验证
结果为止的完整步骤。这是根据两次真实跑通的经验整理的，踩过的坑都在"注意"里标出来了，
照着走可以避免重复踩坑。

适用场景：实例规格类似 RTX 4090 24GB + 50GB 系统盘 + 64GB 内存，全新开机、没有装过任何环境。

---

## 0. 前置准备

在控制台"实例列表"里点开机实例的「登录」按钮，选择 SSH 方式，拿到：
- 连接命令，形如 `ssh -p <端口> root@<域名或IP>`
- 一次性密码

## 1. 首次登录 + 配置密钥登录（免得每次都要输密码）

```bash
# 1.1 先用密码验证能不能连通（会提示交互式输入密码，用 expect 脚本处理）
expect -c '
set timeout 20
spawn ssh -o StrictHostKeyChecking=accept-new -p <端口> root@<域名> "echo CONNECTED"
expect { "password:" { send "<密码>\r" } }
expect eof
'

# 1.2 如果本机还没有专用密钥，生成一个（只需要做一次，之后每台新实例复用同一个公钥）
ssh-keygen -t ed25519 -f ~/.ssh/compshare_qwen_qlora -N "" -C "qwen-qlora-compshare"

# 1.3 把公钥塞进新实例的 authorized_keys（同样需要一次性密码）
PUB=$(cat ~/.ssh/compshare_qwen_qlora.pub)
expect -c "
set timeout 20
spawn ssh -o StrictHostKeyChecking=accept-new -p <端口> root@<域名> \"mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$PUB' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_ADDED\"
expect { \"password:\" { send \"<密码>\r\" } }
expect eof
"

# 1.4 更新本机 ~/.ssh/config 里的 compshare-qwen 别名（每换一台新实例都要改 HostName/Port）
#     Host compshare-qwen
#         HostName <新实例域名>
#         Port <新实例端口>
#         User root
#         IdentityFile ~/.ssh/compshare_qwen_qlora
#         IdentitiesOnly yes
#         StrictHostKeyChecking accept-new

# 1.5 验证
ssh compshare-qwen "echo ALIAS_WORKS && nvidia-smi -L && df -h / && free -h"
```

**注意**：每台新开的实例，域名/端口/密码都会变，第 1.4 步的 ssh config 一定要跟着更新，
不要复用上一台实例的连接信息。

## 2. 同步项目文件（不要用 git clone！）

**注意（重要坑）**：这个平台的实例访问 `github.com` 会直接连接超时（大概率是网络环境限制），
`git clone` 不管是 HTTPS 还是找 Gitee 镜像都容易失败或卡住。**正确做法是本机有 GitHub 访问权限，
本机 clone/准备好文件，再用 `tar` 通过 SSH 管道直接传过去，完全不依赖云主机自己联网拉取。**

```bash
# 2.1 同步项目里训练需要的部分：data/（训练数据）+ customer-service-qlora/（配置和 README）
#     注意排除本机可能存在的大文件目录（saves/ 训练产物、_local_infer/ 本机推理临时环境），
#     否则会把几个 GB 甚至十几 GB 的东西也传上去，浪费时间和带宽
cd /path/to/by-ai-agents
tar -czf - data customer-service-qlora \
  --exclude='customer-service-qlora/_local_infer' \
  --exclude='customer-service-qlora/saves' \
  --exclude='customer-service-qlora/LLaMA-Factory' \
  | ssh compshare-qwen "mkdir -p /root/by-ai-agents && tar -xzf - -C /root/by-ai-agents"

# 2.2 macOS 自带的 tar 是 libarchive/bsdtar，--exclude 语法有时不完全生效，
#     传完之后务必上远程核实一下实际大小，confirming 排除真的生效了：
ssh compshare-qwen "du -sh /root/by-ai-agents/customer-service-qlora/* 2>/dev/null"
#     如果发现排除没生效、传了不该传的大文件，直接在远程删掉重传，别让它传完再说
ssh compshare-qwen "find /root/by-ai-agents -name '._*' -delete"  # 清理 macOS 的 AppleDouble 残留文件

# 2.3 校验数据条数对不对
ssh compshare-qwen "python3 -c \"import json; print('sft', len(json.load(open('/root/by-ai-agents/data/customer_service_zh_sft.json')))); print('mock', len(json.load(open('/root/by-ai-agents/data/customer_service_zh_mock.json'))))\""
```

## 3. 装 Python 3.11 环境（不要用 apt 的 python3.11！）

**注意（重要坑）**：Ubuntu 22.04 apt 源里的 `python3.11` 包实际上是 **3.11.0rc1**（发布候选版，
不是正式版），缺少后来补的标准库属性（比如 `sys.get_int_max_str_digits`），会导致
torch/transformers 加载链路直接崩溃报 `AttributeError`。**正确做法是用 Miniconda 装一个正经的
Python 3.11.x**。

```bash
# 3.1 用清华镜像装 Miniconda（国内直连，很快）
ssh compshare-qwen "cd /root && wget -q https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-latest-Linux-x86_64.sh -O miniconda.sh && bash miniconda.sh -b -p /root/miniconda3 && /root/miniconda3/bin/conda --version"

# 3.2 配置 conda 用清华镜像源（不然拉包很慢）
ssh compshare-qwen "cat > ~/.condarc <<'EOF'
channels:
  - https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/free
  - https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main
  - defaults
show_channel_urls: true
EOF"

# 3.3 建一个干净的 Python 3.11 环境
ssh compshare-qwen "source /root/miniconda3/etc/profile.d/conda.sh && conda create -y -n qlora python=3.11"
```

## 4. 装 LLaMA-Factory

**注意（同样是 GitHub 被墙的坑）**：`git clone https://github.com/hiyouga/LLaMA-Factory.git`
在云主机上大概率会超时。做法和第 2 步一样：本机 clone，tar 传过去。

```bash
# 4.1 本机 clone（用完可以删，不用保留在项目里，体积小，重新 clone 很快）
cd /path/to/scratch/dir
git clone --depth 1 https://github.com/hiyouga/LLaMA-Factory.git

# 4.2 传到云主机（排除 .git，不需要版本历史）
tar -czf - --exclude='.git' LLaMA-Factory | ssh compshare-qwen "tar -xzf - -C /root/by-ai-agents/customer-service-qlora"

# 4.3 用清华 PyPI 镜像装 LLaMA-Factory + 依赖
#     注意：新版本 LLaMA-Factory 的 pyproject.toml 已经没有 metrics/bitsandbytes 这两个
#     setuptools extras 了，得单独装 requirements/ 目录下对应的 txt
ssh compshare-qwen "source /root/miniconda3/etc/profile.d/conda.sh && conda activate qlora && \
cd /root/by-ai-agents/customer-service-qlora/LLaMA-Factory && \
pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple && \
pip install -e . -r requirements/metrics.txt -r requirements/bitsandbytes.txt"

# 4.4 验证安装
ssh compshare-qwen "source /root/miniconda3/etc/profile.d/conda.sh && conda activate qlora && \
llamafactory-cli version && python3 -c \"
import torch
print('torch:', torch.__version__)
print('cuda available:', torch.cuda.is_available())
print('gpu:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none')
import bitsandbytes as bnb
print('bitsandbytes:', bnb.__version__)
\""
```

期望输出：`torch` 是 2.x + cu1xx，`cuda available: True`，GPU 显示 RTX 4090，
bitsandbytes 版本号正常打印，没有报错。

## 5. 下载基座模型 Qwen3-8B

**注意**：这个平台的实例一般有一个共享模型缓存目录 `/model/ModelScope/Qwen/`，可以先看看
里面有没有现成的 `Qwen3-8B`（纯文本非量化版）。如果没有（目前两次开机都没有，只有 14B/32B/VL
等其他型号），就自己用 modelscope 下载，不依赖共享缓存：

```bash
# 5.1 先查一下共享缓存有没有现成的（有的话可以省下载时间，直接跳到第6步，
#     把 yaml 里 model_name_or_path 指向 /model/ModelScope/Qwen/Qwen3-8B）
ssh compshare-qwen "ls /model/ModelScope/Qwen/ | grep -i '^Qwen3-8B$'"

# 5.2 没有的话，自己下载（modelscope.cn 在国内直连很快，不需要额外配镜像）
ssh compshare-qwen "source /root/miniconda3/etc/profile.d/conda.sh && conda activate qlora && \
pip install -q modelscope && mkdir -p /root/models && \
nohup modelscope download --model Qwen/Qwen3-8B --local_dir /root/models/Qwen3-8B > /root/models/download.log 2>&1 &"

# 5.3 盯着进度（模型约 16-17GB，5 个分片文件）
ssh compshare-qwen "tail -5 /root/models/download.log | tr '\r' '\n' | tail -10; du -sh /root/models/Qwen3-8B"

# 5.4 下载完成的判断标志：日志里出现 "Snapshot ready at ..."，并且目录下能看到
#     5 个 model-0000X-of-00005.safetensors + config.json + tokenizer 相关文件
```

## 6. 准备训练配置 yaml

训练用的 yaml（`qwen3_8b_qlora_sft.yaml`）已经在 `customer-service-qlora/` 目录里，跟着
第 2 步一起同步过去了。核心字段（对应学习手册 5.5/5.6 节定的起步参数）：

```yaml
model_name_or_path: /root/models/Qwen3-8B   # 或共享缓存路径
finetuning_type: lora
lora_rank: 16
lora_alpha: 32
lora_dropout: 0.05
lora_target: q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj
quantization_bit: 4
quantization_method: bnb
dataset: customer_service_zh_sft
dataset_dir: /root/by-ai-agents/data
template: qwen3_nothink
cutoff_len: 2048
per_device_train_batch_size: 1
gradient_accumulation_steps: 8
learning_rate: 2.0e-4
num_train_epochs: 3.0
bf16: true
gradient_checkpointing: true
```

如果模型换了路径（比如用共享缓存而不是自己下载的），记得改 `model_name_or_path`。

**建议先跑一次冒烟测试**（复制一份 yaml，把 `max_samples` 改小、加一行 `max_steps: 5`，
`output_dir` 换成 `saves/smoke-test`），确认模型能加载、4bit 量化能跑通、显存不爆、
adapter 能正常导出之后，再跑正式训练，避免正式训练几十分钟后才发现配置有问题。

## 7. 跑训练

```bash
ssh compshare-qwen "source /root/miniconda3/etc/profile.d/conda.sh && conda activate qlora && \
cd /root/by-ai-agents/customer-service-qlora && \
nohup llamafactory-cli train qwen3_8b_qlora_sft.yaml > train.log 2>&1 &"

# 盯进度
ssh compshare-qwen "tail -5 /root/by-ai-agents/customer-service-qlora/train.log | tr '\r' '\n' | tail -10"

# 判断训练完成：日志出现 '***** train metrics *****'，
# saves/<output_dir>/ 下能看到 adapter_config.json + adapter_model.safetensors
```

参考速度（8B + QLoRA 4bit + RTX 4090，460~480 条数据、3 epoch）：约 170-180 步，
单步 4 秒左右，总耗时 11-12 分钟。

## 8. 用 mock 测试集做预测验证

准备一份 predict 用的 yaml（同样已经同步过去），关键字段：

```yaml
model_name_or_path: /root/models/Qwen3-8B
adapter_name_or_path: /root/by-ai-agents/customer-service-qlora/saves/<训练产物目录>
quantization_bit: 4
quantization_method: bnb
do_predict: true
finetuning_type: lora
eval_dataset: customer_service_zh_mock
dataset_dir: /root/by-ai-agents/data
template: qwen3_nothink
predict_with_generate: true
max_new_tokens: 256
```

```bash
ssh compshare-qwen "source /root/miniconda3/etc/profile.d/conda.sh && conda activate qlora && \
cd /root/by-ai-agents/customer-service-qlora && \
nohup llamafactory-cli train qwen3_8b_qlora_predict_mock.yaml > predict_mock.log 2>&1 &"

ssh compshare-qwen "tail -30 /root/by-ai-agents/customer-service-qlora/predict_mock.log | tr '\r' '\n' | tail -20"
```

跑完会看到 ROUGE-1/ROUGE-2/ROUGE-L/BLEU-4 指标，以及
`saves/<predict输出目录>/generated_predictions.jsonl` 里每条数据的 `label`（参考答案）和
`predict`（模型实际生成），可以拉回本机人工抽查几条。

**注意（数据格式的坑）**：如果数据集里有的条目带 `history` 字段、有的不带，predict 阶段的
`datasets.map` 会报 `KeyError: 'history'`（训练阶段不会报，只有 predict 阶段的代码路径不一样）。
生成数据时统一给每条都补上 `"history": []`，可以避免这个问题。

## 9. 把训练产物同步回本机

```bash
# 9.1 只需要 adapter_config.json + adapter_model.safetensors + tokenizer 相关文件即可，
#     不需要 checkpoint-xxx/ 子目录（里面是训练中间存档，含 optimizer.pt 等只用于断点续训
#     的大文件，部署/推理用不上）
scp -r compshare-qwen:/root/by-ai-agents/customer-service-qlora/saves/<训练产物目录> \
  /path/to/by-ai-agents/customer-service-qlora/saves/

# 9.2 本机清理掉不需要的 checkpoint 子目录
rm -rf /path/to/.../saves/<训练产物目录>/checkpoint-*
```

**注意（标准步骤，不是可选项）**：LLaMA-Factory 默认把 `adapter_model.safetensors` 存成
**fp32**（每参数 4 字节），实际训练时 `compute_dtype` 本来就是 bf16，fp32 存盘不会带来任何
额外精度收益，纯粹是多占一倍空间。**每次训练完、同步回本机之后，都要转换成 bf16**（体积减半，
对推理效果无损）：

```bash
# 9.3 转换成 bf16（本机跑，只需要 ml_dtypes + safetensors 的 numpy 接口，不需要装 torch）
pip install --user safetensors numpy ml_dtypes
python3 - <<'PYEOF'
from pathlib import Path
import shutil
import ml_dtypes
import numpy as np
from safetensors.numpy import save_file, load_file

SRC = Path("/path/to/.../saves/<训练产物目录>")
DST = Path("/path/to/.../saves/<训练产物目录>-bf16")
DST.mkdir(parents=True, exist_ok=True)

tensors_in = load_file(SRC / "adapter_model.safetensors")
tensors_out = {name: t.astype(ml_dtypes.bfloat16) for name, t in tensors_in.items()}
save_file(tensors_out, DST / "adapter_model.safetensors")

for item in SRC.iterdir():
    if item.name == "adapter_model.safetensors":
        continue
    if item.is_dir():
        shutil.copytree(item, DST / item.name, dirs_exist_ok=True)
    else:
        shutil.copy2(item, DST / item.name)

print("原始 fp32:", (SRC / "adapter_model.safetensors").stat().st_size / 1024 / 1024, "MB")
print("转换后 bf16:", (DST / "adapter_model.safetensors").stat().st_size / 1024 / 1024, "MB")
PYEOF
```

原始 fp32 版本不要删，保留作为备份，bf16 版本作为实际使用/提交的版本。

**注意**：`adapter_model.safetensors` 通常有 100+ MB，超过 GitHub 单文件 100MB 限制，
不要直接 `git add` 提交，记得在 `.gitignore` 里排除（本项目已经配置好了）。

## 10. 收尾

- 确认 mock 集预测效果符合预期后，去控制台把实例**关机**，避免继续计费。
- 如果这次训练是为了替换旧版本，记得同步更新 `docs/task.md` 里的进度记录。

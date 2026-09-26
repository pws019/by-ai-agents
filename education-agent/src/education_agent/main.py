"""Agent 服务入口：python -m education_agent.main（或 npm run edu:agent）。

模式（EDUCATION_MODE）：
- mock（默认）：确定性的开发用假模型，不需要 GPU/真实模型。只能证明编排和界面是对的，不能证明真实模型的效果。
- real：OpenAI 兼容端点（微调后的 Qwen 也这样对外提供），需要 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME。
两种模式的结果必须分开报告。
"""
import asyncio
import os
from collections.abc import Mapping
from dataclasses import dataclass

import httpx
import uvicorn

from .checkpoint import open_checkpointer
from .dev_model import DemoModel
from .graphs.student_graph import build_student_graph
from .model.base import ChatModel
from .model.langchain_adapter import create_langchain_model
from .server import create_app
from .tools.contracts import TOOL_SPECS
from .tools.runtime import ToolRuntime


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Settings:
    mode: str
    internal_secret: str
    business_api_url: str
    host: str
    port: int
    model_base_url: str = ""
    model_api_key: str = ""
    model_name: str = ""


def load_settings(env: Mapping[str, str]) -> Settings:
    """读取并校验配置。缺什么就在启动时明说，而不是运行到一半才出错。"""
    mode = env.get("EDUCATION_MODE", "mock")
    if mode not in ("mock", "real"):
        raise ConfigError(f"EDUCATION_MODE 只能是 mock 或 real，收到: {mode!r}")

    secret = env.get("INTERNAL_AUTH_SECRET", "")
    if not secret:
        # 空密钥意味着"永远拒绝所有工作证"（校验函数的既定行为），服务起来了也什么都做不了，不如启动就失败。
        raise ConfigError("INTERNAL_AUTH_SECRET 未设置（BFF 与 Agent 必须使用同一个密钥）")

    fields = {"model_base_url": "MODEL_BASE_URL", "model_api_key": "MODEL_API_KEY", "model_name": "MODEL_NAME"}
    model = {k: env.get(v, "") for k, v in fields.items()}
    if mode == "real":
        missing = [fields[k] for k, v in model.items() if not v]
        if missing:
            raise ConfigError(f"real 模式需要: {', '.join(missing)}")

    try:
        port = int(env.get("AGENT_PORT", "8500"))
    except ValueError as e:
        raise ConfigError("AGENT_PORT 必须是整数") from e
    return Settings(
        mode=mode, internal_secret=secret, business_api_url=env.get("BUSINESS_API_URL", "http://127.0.0.1:8400"),
        host=env.get("AGENT_HOST", "127.0.0.1"), port=port, **model,
    )


def build_model(settings: Settings) -> ChatModel:
    if settings.mode == "mock":
        return DemoModel()
    return create_langchain_model(settings.model_base_url, settings.model_api_key, settings.model_name)


async def serve(settings: Settings) -> None:
    async with httpx.AsyncClient(base_url=settings.business_api_url) as http, open_checkpointer() as saver:
        graph = build_student_graph(build_model(settings), ToolRuntime(TOOL_SPECS, http), saver)
        config = uvicorn.Config(create_app(graph, settings.internal_secret), host=settings.host, port=settings.port, log_level="info")
        await uvicorn.Server(config).serve()


def main() -> None:
    try:
        settings = load_settings(os.environ)
    except ConfigError as e:
        raise SystemExit(f"配置错误: {e}") from e
    print(f"education-agent 启动：mode={settings.mode} 监听 {settings.host}:{settings.port} 业务 API={settings.business_api_url}")
    asyncio.run(serve(settings))


if __name__ == "__main__":
    main()

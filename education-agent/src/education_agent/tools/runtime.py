"""工具运行时：模型提出"调用工具 X，参数 Y"，这里决定能不能执行、以谁的身份执行、执行多久、总共执行几次。

这是 T-18 的核心机制，由学员手写 `call`。其余部分（契约、客户端、上下文校验）已经就绪，见同目录其它文件。
"""
import httpx

from .client import BusinessApi
from .context import RunContext
from .spec import RunBudget, ToolResult, ToolSpec


class ToolRuntime:
    def __init__(self, specs: tuple[ToolSpec, ...], http: httpx.AsyncClient):
        # 白名单就是这张表：不在里面的名字，哪怕业务 API 真有对应端点，也不可能被调用。
        self._specs = {s.name: s for s in specs}
        self._http = http

    def schemas(self) -> list[dict]:
        """给模型看的工具清单（名字、描述、参数 JSON Schema）。RunContext 不在其中——模型不知道也不需要知道"我是谁"。"""
        return [
            {"name": s.name, "description": s.description, "parameters": s.args_model.model_json_schema()}
            for s in self._specs.values()
        ]

    async def call(self, name: str, raw_args: dict, ctx: RunContext, budget: RunBudget) -> ToolResult:
        """
        TODO（学员手写）。约束见 tests/test_tool_runtime.py；这里列出需要你逐条做出的判断：

        1. 每次调用（包括最终失败的）先记入 budget；超过 max_calls 直接返回 BUDGET_EXCEEDED，且不发任何 HTTP 请求。
           想清楚：参数校验失败、未知工具名的尝试要不要也算进预算？（测试里的立场是"都算"，想改就写出理由。）
        2. ctx 已过期 → AUTH_EXPIRED（不发请求）。想清楚：为什么是运行时检查，而不是只在构造 RunContext 时检查一次？
        3. name 不在白名单 → UNKNOWN_TOOL。
        4. 用 spec.args_model 校验 raw_args；多余字段（如 studentId）和类型错误 → INVALID_ARGS。
           想清楚：校验失败时，pydantic 的错误详情要不要原样返回给模型？（提示：里面会带上模型传入的值。）
        5. 用 ctx 构造 BusinessApi（timeout 取 spec.timeout_s），调用 spec.handler(api, 已校验的 args)。
        6. 整个 handler 受 spec.timeout_s 约束，超时 → TIMEOUT。想清楚：httpx 自己的 timeout 和 asyncio 的超时各管什么？
        7. BusinessApiError → 保留业务错误码给模型（如 NOT_FOUND）；status>=500 统一成 UPSTREAM_ERROR。
           其它未预期异常 → INTERNAL，绝不能把异常文本、堆栈、token 放进返回值。
        8. 成功 → ToolResult(ok=True, data=output.data, artifacts=output.artifacts)。

        返回值永远是 ToolResult，不抛异常给调用方：工具失败是模型需要看到并处理的"结果"，不是让整个图崩溃的事故。
        """
        raise NotImplementedError("T-18 学员手写")

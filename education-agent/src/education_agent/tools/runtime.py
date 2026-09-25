"""工具运行时：模型提出"调用工具 X，参数 Y"，这里决定能不能执行、以谁的身份执行、执行多久、总共执行几次。

这是 T-18 的核心机制。契约、客户端、上下文校验见同目录其它文件。
"""
import asyncio

import httpx
from pydantic import ValidationError

from .client import BusinessApi, BusinessApiError
from .context import RunContext
from .spec import RunBudget, ToolResult, ToolSpec


class ToolRuntime:
    def __init__(self, specs: tuple[ToolSpec, ...], http: httpx.AsyncClient):
        # 白名单就是这张表：不在里面的名字，哪怕业务 API 真有对应端点，也不可能被调用。
        self._specs = {s.name: s for s in specs}
        self._http = http

    def restricted_to(self, names: set[str]) -> "ToolRuntime":
        """只保留指定工具的运行时，共用同一个 HTTP 连接池。图里不同分支拿到不同的子集（最小权限）：
        不在子集里的工具，模型既看不到，即使硬要调用也会走 UNKNOWN_TOOL——限制是"被强制"的，而不只是"没告诉它"。"""
        missing = names - self._specs.keys()
        if missing:
            raise ValueError(f"不存在的工具: {sorted(missing)}")  # 建图时就失败，避免拼写错误悄悄变成"少了一个工具"
        return ToolRuntime(tuple(s for s in self._specs.values() if s.name in names), self._http)

    def schemas(self) -> list[dict]:
        """给模型看的工具清单（名字、描述、参数 JSON Schema）。RunContext 不在其中——模型不知道也不需要知道"我是谁"。"""
        return [
            {"name": s.name, "description": s.description, "parameters": s.args_model.model_json_schema()}
            for s in self._specs.values()
        ]

    async def call(self, name: str, raw_args: dict, ctx: RunContext, budget: RunBudget) -> ToolResult:
        """执行模型提出的一次工具调用。

        整体是一条"关卡流水线"：前面的关卡（预算、过期、白名单、参数）任何一关不过，都在发出 HTTP 请求之前
        返回，业务 API 完全不会看到这次请求；全部通过后才真正执行。

        返回值永远是 ToolResult，绝不向调用方抛异常：工具失败是模型需要看到并处理的"结果"
        （它可以换个参数重试，或者告诉用户），不是让整个 Agent 图崩溃的事故。
        """
        # ── 1. 预算 ────────────────────────────────────────────────────────────────────
        # 先计数、后判断，且放在最前面：所有"尝试"都算数，包括后面会被拒绝的（未知工具、参数错误）。
        # 原因：模型陷入"发错调用 → 收到错误 → 再发错调用"的死循环时，如果只有成功才计数，预算永远
        # 不会耗尽，循环停不下来。放最前面还保证了预算耗尽后，后面所有关卡都不再执行（省掉无谓工作）。
        budget.used += 1
        if budget.used > budget.max_calls:
            return ToolResult(ok=False, error_code="BUDGET_EXCEEDED")

        # ── 2. 工作证是否过期 ──────────────────────────────────────────────────────────
        # 在"调用发生的这一刻"检查，而不是只在构造 RunContext 时查一次：一次 run 里可能有多轮
        # 工具调用，前面的几轮可能已经把 60 秒的有效期用完了；不在这里查，过期的证到了业务 API
        # 才被拒，白白多一次网络往返，而且错误会被当成 UPSTREAM_ERROR，语义不对。
        # 这只是快速失败；真正的校验永远在业务 API 那边（它会再验一次签名和过期）。
        if ctx.is_expired():
            return ToolResult(ok=False, error_code="AUTH_EXPIRED")

        # ── 3. 白名单 ──────────────────────────────────────────────────────────────────
        # self._specs 是构造时固定下来的字典。不在里面的名字（比如业务 API 里真实存在的
        # approveApplication）没有任何路径能走到 handler，这是"模型能做什么"的第一道硬边界。
        spec = self._specs.get(name)
        if spec is None:
            return ToolResult(ok=False, error_code="UNKNOWN_TOOL")

        # ── 4. 参数校验 ────────────────────────────────────────────────────────────────
        # model_validate 按 args_model 检查类型；ToolArgs 设了 extra="forbid"，所以模型多传的
        # studentId/actorId 等字段会在这里被拒绝，而不是悄悄忽略。
        # 只返回固定的 INVALID_ARGS，不把 pydantic 的错误详情带回去：详情里会含有模型传入的原始值，
        # 如果那是一段提示词注入的文本，把它原样回填给模型等于帮它把攻击文本再喂一遍。
        try:
            args = spec.args_model.model_validate(raw_args)
        except ValidationError:
            return ToolResult(ok=False, error_code="INVALID_ARGS")

        # ── 5. 绑定身份并执行 ──────────────────────────────────────────────────────────
        # 身份就在这一行进入：BusinessApi 用 ctx 的 token 构造，之后 handler 发出的每个请求都会
        # 自动带上 X-Actor-Context。handler 拿到的只有这个已绑定的对象，没有"换一个人"的入口。
        # 每次调用新建一个实例（很轻量，底层连接池 self._http 是共享的），避免不同 actor 之间串用。
        api = BusinessApi(self._http, ctx, spec.timeout_s)

        try:
            # ── 6. 整体超时 ────────────────────────────────────────────────────────────
            # 两层超时各管一段：BusinessApi 里传给 httpx 的 timeout 管"单个 HTTP 请求"（连接/读取）；
            # 这里的 wait_for 管"整个 handler"，因为一个工具可能连着发好几个请求，
            # 每个都没超时，加起来也可能太久。超时时 wait_for 会取消 handler 里还在跑的请求。
            output = await asyncio.wait_for(spec.handler(api, args), timeout=spec.timeout_s)

        except (asyncio.TimeoutError, httpx.TimeoutException):
            # 上面 wait_for 的超时，或 httpx 自己的超时，对模型来说是同一件事。
            return ToolResult(ok=False, error_code="TIMEOUT")

        except BusinessApiError as e:
            # ── 7. 错误翻译 ────────────────────────────────────────────────────────────
            # 业务码（NOT_FOUND、FORBIDDEN 等）本来就是面向调用方设计的，保留给模型，
            # 这样它能据此决定"告诉用户没找到"还是"换个参数"。5xx 是对方内部出问题，
            # 具体原因对模型没用，统一成 UPSTREAM_ERROR。
            # BusinessApiError 里本来就只保留了状态码和错误码，所以这里不会带出响应体。
            if e.status >= 500:
                return ToolResult(ok=False, error_code="UPSTREAM_ERROR")
            return ToolResult(ok=False, error_code=e.code)

        except Exception:
            # 兜底：任何没预料到的异常（网络断开、handler 里的 bug 等）。
            # 故意不读、不记录异常对象本身：异常文本里可能带着 token、内部地址或堆栈。
            # 只给模型一个固定的 INTERNAL。（生产里应把异常记到服务端日志，用 requestId 关联，
            # 那是日志/可观测性的事，不在这个函数里。）
            return ToolResult(ok=False, error_code="INTERNAL")

        # ── 8. 成功 ────────────────────────────────────────────────────────────────────
        # data 给模型看；artifacts（如确认卡）只随 ToolResult 交给调用方（图/UI），
        # model_view() 不会包含它，所以模型永远拿不到 confirmationId。
        return ToolResult(ok=True, data=output.data, artifacts=output.artifacts)

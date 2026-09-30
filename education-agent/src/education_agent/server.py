"""Agent 服务的 HTTP 入口。只给 BFF（education-api）调用，浏览器不直连（design.md）。

POST /internal/runs，请求头带 BFF 签发的 X-Actor-Context，响应是 SSE 事件流：
    id: <eventId>
    event: <type>
    data: {"eventId", "conversationId", "runId", "type", "payload"}

事件的形状以 contracts/education/events.schema.json 为准（测试里直接用它校验）。事件类型：message.delta、tool.status、
application.confirmation、message.completed、run.error。message.completed 一定是最后一个正常事件，带完整文本，客户端以它为准；
run.error 之后不会再有事件。

与契约唯一的差别：契约要求 message.completed 带 messageId，但助手消息是 BFF 落库后才有 id，所以 Agent 这一跳只带 text，
由 BFF 落库后补上 messageId 再转发给浏览器。

身份与线程（T-19 的约定在这里落地）：
- 身份只来自验过签的工作证，请求体里没有任何"我是谁"的字段。
- 线程 id 是 "{actorId}:{conversationId}"，由工作证派生，调用方无法指定别人的线程。
- 每次请求新建 RunScope（工作证 + 预算）：恢复时用的是这次请求带来的新工作证，checkpoint 里没有旧的。
"""
import json
import logging
from collections.abc import AsyncIterator
from typing import Any
from uuid import UUID

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse, StreamingResponse
from langgraph.types import Command
from pydantic import BaseModel, Field, model_validator

from .checkpoint_cleanup import prune_thread_checkpoints
from .graphs.student_graph import RunScope
from .tools.context import verify_context
from .tools.spec import RunBudget

log = logging.getLogger("education_agent.server")

RUN_ERROR_MESSAGE = "服务暂时出错，请稍后重试。"


class RunRequest(BaseModel):
    conversationId: UUID
    text: str | None = Field(default=None, min_length=1, max_length=4000)
    resume: bool = False  # 学员已在界面上处理了确认卡：叫醒被挂起的图去读最新事实。内容不参与任何决定。

    @model_validator(mode="after")
    def exactly_one_of_text_or_resume(self):
        if (self.text is None) == (not self.resume):
            raise ValueError("text 与 resume 必须二选一")
        return self


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code}}, status_code=status)


def create_app(graph, secret: str, checkpoint_dsn: str | None = None) -> FastAPI:
    """checkpoint_dsn：给了才会在每次运行后清理这个线程的旧 checkpoint（见 checkpoint_cleanup.py，
    已知局限第 2 层）。测试用的 InMemorySaver 没有这张表可清，留空即可——是否清理由调用方显式决定，
    不去反射 graph.checkpointer 的具体类型。
    """
    app = FastAPI(title="education-agent")

    @app.post("/internal/runs")
    async def run(body: RunRequest, x_actor_context: str | None = Header(default=None)):
        ctx = verify_context(x_actor_context or "", secret)
        if ctx is None:
            return _error(401, "UNAUTHENTICATED")  # 缺失、被篡改、过期一律同一个结果

        thread_id = f"{ctx.actor_id}:{body.conversationId}"
        config = {"configurable": {"thread_id": thread_id}}

        if body.resume and not (await graph.aget_state(config)).next:
            # 这个会话没有挂起的确认可恢复。放在开流之前判断，让调用方拿到普通的 409 而不是一个空的事件流。
            return _error(409, "NOT_AWAITING_CONFIRMATION")

        graph_input: Any = Command(resume=True) if body.resume else {"messages": [{"role": "user", "content": body.text}]}
        events = _stream_run(graph, graph_input, config, RunScope(ctx, RunBudget()), str(body.conversationId), ctx.request_id, checkpoint_dsn)
        return StreamingResponse(
            events, media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app


async def _stream_run(
    graph, graph_input, config, scope: RunScope, conversation_id: str, run_id: str, checkpoint_dsn: str | None = None
) -> AsyncIterator[str]:
    seq = 0

    def frame(type_: str, payload: dict) -> str:
        nonlocal seq
        seq += 1
        envelope = {"eventId": str(seq), "conversationId": conversation_id, "runId": run_id, "type": type_, "payload": payload}
        return f"id: {seq}\nevent: {type_}\ndata: {json.dumps(envelope, ensure_ascii=False)}\n\n"

    try:
        async for event in graph.astream(graph_input, config, context=scope, stream_mode="custom"):
            yield frame(event["type"], {k: v for k, v in event.items() if k != "type"})

        state = await graph.aget_state(config)
        for task in state.tasks:
            for interrupt in task.interrupts:
                if interrupt.value.get("type") == "need_confirmation":
                    yield frame("application.confirmation", interrupt.value["confirmation"])
        yield frame("message.completed", {"text": state.values["reply"]})
    except Exception:
        # 只把固定的错误码给调用方；细节（可能含内部地址、凭证）只进服务端日志，用 runId 关联。
        log.exception("run failed runId=%s", run_id)
        yield frame("run.error", {"code": "INTERNAL", "message": RUN_ERROR_MESSAGE})
    finally:
        # 只保留能恢复所需的最新一条 checkpoint（见 checkpoint_cleanup.py）；失败只记日志，
        # 绝不能让清理这件运维层面的事影响已经成功/已经上报过的这次响应。
        if checkpoint_dsn is not None:
            try:
                await prune_thread_checkpoints(checkpoint_dsn, config["configurable"]["thread_id"])
            except Exception:
                log.exception("checkpoint prune failed runId=%s", run_id)

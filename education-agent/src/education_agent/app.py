from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.types import Command
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel

from .config import CHECKPOINT_SCHEMA, DATABASE_URL
from .spike_graph import build_graph


@asynccontextmanager
async def lifespan(app: FastAPI):
    # checkpointer 的表建在连接的 search_path 第一个 schema 里（库本身没有 schema 参数）。
    # 连接参数沿用库自带 from_conn_string 的设置：autocommit、prepare_threshold=0、dict_row。
    async with AsyncConnectionPool(
        DATABASE_URL,
        kwargs={
            "autocommit": True,
            "prepare_threshold": 0,
            "row_factory": dict_row,
            "options": f"-c search_path={CHECKPOINT_SCHEMA}",
        },
        open=False,
    ) as pool:
        checkpointer = AsyncPostgresSaver(pool)
        await checkpointer.setup()  # 幂等：已建表则跳过
        async with pool.connection() as conn:
            await conn.execute(
                "CREATE TABLE IF NOT EXISTS spike_log ("
                "id bigserial PRIMARY KEY, thread_id text, node text, at timestamptz DEFAULT now())"
            )

        async def log(thread_id: str, node: str) -> None:
            async with pool.connection() as conn:
                await conn.execute(
                    "INSERT INTO spike_log (thread_id, node) VALUES (%s, %s)", (thread_id, node)
                )

        app.state.pool = pool
        app.state.graph = build_graph(checkpointer, log)
        yield


app = FastAPI(title="education-agent (T-04 spike)", lifespan=lifespan)


class ResumeBody(BaseModel):
    type: str
    value: str

class StartBody(BaseModel):
    reason: str | None = None


def _cfg(task_id: str) -> dict:
    return {"configurable": {"thread_id": task_id}}


async def _snapshot(task_id: str) -> dict:
    snap = await app.state.graph.aget_state(_cfg(task_id))
    if not snap.created_at:
        raise HTTPException(404, "unknown task")
    return {
        "taskId": task_id,
        "next": list(snap.next),  # 非空 = 还没跑完（停在这些节点）
        "pendingInterrupt": [i.value for t in snap.tasks for i in t.interrupts],
        "values": snap.values,
    }


@app.post("/spike/{task_id}/start")
async def start(task_id: str, body: StartBody | None = None):
    dict1 = {}
    if(body != None and body.reason != None):
        dict1["reason"] = body.reason
    await app.state.graph.ainvoke(dict1, _cfg(task_id))
    return await _snapshot(task_id)


@app.post("/spike/{task_id}/resume")
async def resume(task_id: str, body: ResumeBody):
    snap = await _snapshot(task_id)
    pendingInterrupt = snap["pendingInterrupt"]
    if not snap["next"]:
        raise HTTPException(409, "task already finished")
    # if pendingInterrupt[0] == 'draft' and body.type != 'need_reason':
    #     raise HTTPException(409, "type error")
    # if snap["next"] == 'draft' and body.type != 'need_confirm':
    #     raise HTTPException(409, "type error")
    if len(pendingInterrupt) == 0:
        raise HTTPException(409, "type error")
    if pendingInterrupt[0]["type"] != body.type:
        raise HTTPException(409, "type error")

    await app.state.graph.ainvoke(Command(resume=body.value), _cfg(task_id))
    return await _snapshot(task_id)


@app.get("/spike/{task_id}")
async def get_task(task_id: str):
    return await _snapshot(task_id)


@app.get("/spike/{task_id}/log")
async def get_log(task_id: str):
    async with app.state.pool.connection() as conn:
        cur = await conn.execute(
            "SELECT node FROM spike_log WHERE thread_id = %s ORDER BY id", (task_id,)
        )
        return [r["node"] for r in await cur.fetchall()]

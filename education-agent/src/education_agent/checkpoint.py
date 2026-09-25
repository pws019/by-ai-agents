from contextlib import asynccontextmanager

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import CHECKPOINT_SCHEMA, DATABASE_URL


@asynccontextmanager
async def open_checkpointer(dsn: str = DATABASE_URL):
    """打开 Postgres checkpointer。表建在连接 search_path 的第一个 schema 里（库本身没有 schema 参数），
    连接参数沿用库自带 from_conn_string 的设置：autocommit、prepare_threshold=0、dict_row。"""
    async with AsyncConnectionPool(
        dsn,
        kwargs={
            "autocommit": True,
            "prepare_threshold": 0,
            "row_factory": dict_row,
            "options": f"-c search_path={CHECKPOINT_SCHEMA}",
        },
        open=False,
    ) as pool:
        saver = AsyncPostgresSaver(pool)
        await saver.setup()  # 幂等：已建表则跳过
        yield saver

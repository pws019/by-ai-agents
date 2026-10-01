"""knowledge_* 表的 SQLAlchemy Core 类型映射——跟 education-api 的 `db/schema.ts` 是同一个角色：
真正的表结构、约束、索引永远以 education-api 的 `.sql` migration（0010/0011）为准，这里只是
给 `db.py` 写查询用的类型化视图，不负责建表、不执行迁移。改了 migration 记得回来同步这份映射，
两边字段类型/是否可空必须一致，但这件事本来就得手动做（schema.ts 头部注释也是同样的提醒）。
"""
from sqlalchemy import Column, ForeignKey, Integer, MetaData, Table, Text, text, TIMESTAMP
from sqlalchemy.dialects.postgresql import UUID as PgUuid

from ..config import APP_SCHEMA

metadata = MetaData(schema=APP_SCHEMA)

# Postgres 的 uuid 列必须映射成 UUID 类型，不能用 Text：uuid 和 text 之间没有隐式比较运算符，
# 用 Text 会在 `WHERE id = %(id)s` 这类查询里报 "operator does not exist: uuid = text"。
# as_uuid=False 让它在 Python 这边就是普通字符串，跟现有代码（Document/Segment/Job 的 id 字段
# 都是 str）保持一致，不用在每个调用点再套一层 str(...)。
UuidStr = PgUuid(as_uuid=False)
# 三张表的 id 都是 `DEFAULT gen_random_uuid()`（见 migration）；告诉 SQLAlchemy 这一点，
# 插入时不用显式给 id 也不会报"主键列没有默认值"的警告——数据库本来就会自己生成。
UUID_DEFAULT = text("gen_random_uuid()")

lessons = Table(
    "lessons", metadata,
    Column("id", UuidStr, primary_key=True),
    Column("cohort_id", UuidStr, nullable=False),
)

knowledge_documents = Table(
    "knowledge_documents", metadata,
    Column("id", UuidStr, primary_key=True, server_default=UUID_DEFAULT),
    Column("lesson_id", UuidStr, ForeignKey("lessons.id"), nullable=False),
    Column("kind", Text, nullable=False),
    Column("source_name", Text, nullable=False),
    Column("source_hash", Text, nullable=False),
    Column("source_url", Text),
    Column("source_title", Text),
    Column("recorded_at", TIMESTAMP(timezone=True)),
    Column("version", Integer, nullable=False),
    Column("visibility", Text, nullable=False),
    Column("activated_at", TIMESTAMP(timezone=True)),
    Column("revoked_at", TIMESTAMP(timezone=True)),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False),
)

knowledge_segments = Table(
    "knowledge_segments", metadata,
    Column("id", UuidStr, primary_key=True, server_default=UUID_DEFAULT),
    Column("document_id", UuidStr, ForeignKey("knowledge_documents.id"), nullable=False),
    Column("position", Integer, nullable=False),
    Column("content", Text, nullable=False),
    Column("content_hash", Text, nullable=False),
    Column("start_ms", Integer),
    Column("end_ms", Integer),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False),
)

knowledge_index_jobs = Table(
    "knowledge_index_jobs", metadata,
    Column("id", UuidStr, primary_key=True, server_default=UUID_DEFAULT),
    Column("document_id", UuidStr, ForeignKey("knowledge_documents.id"), nullable=False),
    Column("kind", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("attempts", Integer, nullable=False),
    Column("last_error", Text),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False),
    Column("updated_at", TIMESTAMP(timezone=True), nullable=False),
)

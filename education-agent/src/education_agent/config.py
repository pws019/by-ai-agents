import os

# 开发默认值与 infra/education/.env.example 一致；真实环境用 EDUCATION_DATABASE_URL 覆盖。
DATABASE_URL = os.environ.get(
    "EDUCATION_DATABASE_URL",
    "postgresql://edu:dev-only-change-me@localhost:5433/education",
)

# checkpoint 表放独立 schema，与业务表（app）隔离。
CHECKPOINT_SCHEMA = "agent_checkpoint"

# 业务表所在 schema；knowledge_documents/knowledge_segments/knowledge_index_jobs 由
# education-api 的 migration 建表（T-25/T-26），education-agent 直接读写同一个 Postgres 实例，
# 跟 checkpoint_cleanup.py 的做法一致——没有必要为了"谁建的表"专门开一层 HTTP。
APP_SCHEMA = "app"

# 开发默认值对应 infra/education/.env.example 的 QDRANT_HTTP_PORT；真实环境用 EDUCATION_QDRANT_URL 覆盖。
QDRANT_URL = os.environ.get("EDUCATION_QDRANT_URL", "http://127.0.0.1:6335")
KNOWLEDGE_COLLECTION = "knowledge_segments"

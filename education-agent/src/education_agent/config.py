import os

# 开发默认值与 infra/education/.env.example 一致；真实环境用 EDUCATION_DATABASE_URL 覆盖。
DATABASE_URL = os.environ.get(
    "EDUCATION_DATABASE_URL",
    "postgresql://edu:dev-only-change-me@localhost:5433/education",
)

# checkpoint 表放独立 schema，与业务表（app）隔离。
CHECKPOINT_SCHEMA = "agent_checkpoint"

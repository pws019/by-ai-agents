-- 业务事实与 Agent checkpoint 使用同一实例、不同 schema（design.md §3：checkpoint 独立 schema，且不是事实源）
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS agent_checkpoint;

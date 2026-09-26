-- 记录一张申请草稿是"在哪次 Agent 运行里起草的"。来源由业务 API 从已验签的内部工作证里读取（requestId 就是 runId），
-- 不是工具参数、也不是模型说的，所以模型无法伪造；通过 run 可以反查到会话，
-- 断线重连后 GET /conversations/:id/messages 才能找回这个会话里待确认的草稿。
ALTER TABLE applications ADD COLUMN source_run_id uuid REFERENCES runs(id);
CREATE INDEX applications_source_run_idx ON applications (source_run_id) WHERE source_run_id IS NOT NULL;

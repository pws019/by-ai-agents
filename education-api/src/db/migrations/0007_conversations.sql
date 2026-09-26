-- 会话、消息、运行（run）。业务库里保存的是"产品可见的历史"（UI、老师接管、断线后查询都读它）；
-- Agent 自己的 checkpoint 是图的内部状态，两者不合并。

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  mode text NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot', 'queued', 'human', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_owner_idx ON conversations (owner_id, created_at DESC);
CREATE TRIGGER conversations_touch BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 一次 Agent 运行：学员发一条消息（message），或学员在界面确认后让 Agent 恢复（resume）。
-- lease_until 是"租约"：运行中的一方要定期续租；租约过期意味着执行它的 BFF/Agent 大概率已经崩溃，
-- 新的运行可以把它标记为失败并接管，否则会话会永远卡在"生成中"。
CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  kind text NOT NULL CHECK (kind IN ('message', 'resume')),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  error_code text,
  lease_until timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'running') = (finished_at IS NULL))
);
-- "同一个会话同一时刻至多一个运行中的 run"由数据库保证，而不是应用层先查再写：
-- 两个并发请求同时通过"先查"这一步是完全可能的，唯一索引才是真正的仲裁者。
CREATE UNIQUE INDEX runs_one_running_per_conversation ON runs (conversation_id) WHERE status = 'running';

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'teacher', 'system')),
  content text NOT NULL,
  client_message_id text,
  run_id uuid REFERENCES runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 人发的消息（学员、老师）带 clientMessageId（由客户端生成，用于重试去重）；助手/系统消息不带。
  CHECK ((role IN ('user', 'teacher')) = (client_message_id IS NOT NULL))
);
-- 同一会话里同一个 clientMessageId 只能出现一次：重复提交（网络重试、连点）在这里被挡住。
CREATE UNIQUE INDEX messages_client_message_unique ON messages (conversation_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at, id);
-- 一个 run 至多产出一条助手消息：即使"完成"被重复触发，也不会写出第二条。
CREATE UNIQUE INDEX messages_one_assistant_per_run ON messages (run_id) WHERE role = 'assistant';

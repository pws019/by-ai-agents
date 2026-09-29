-- 转人工：一次"学员请求老师接管"的经过。
-- conversations.mode（bot / queued / human）回答"此刻谁在应答"，handoffs 记录"这次接管是怎么发生的"
-- （谁请求、谁接管、摘要、版本）。两者永远在同一个事务里一起变：
--   请求接管  bot    -> queued   插入一条 queued 的 handoff
--   老师接管  queued -> human    handoff 变 claimed
--   结束接管  human  -> bot      handoff 变 released
-- 状态转换全部靠"带条件的 UPDATE"仲裁（WHERE mode = ... / WHERE status = ... AND revision = ...），
-- 应用层不做先查后写：两位老师同时接管同一条，只有一个 UPDATE 能命中。

CREATE TABLE handoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  status          text NOT NULL CHECK (status IN ('queued', 'claimed', 'released')),
  teacher_id      uuid REFERENCES users(id),
  reason          text,
  -- 交接摘要：由 Agent 用确定性代码从已核验的工具结果里拼出，不含猜测（requirements F-006）。
  -- 学员在界面上直接点"转人工"时没有 Agent 参与，这里为 NULL。
  summary         text,
  revision        integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  claimed_at      timestamptz,
  released_at     timestamptz,
  -- 状态和字段互相印证：排队中没有老师、没有接管时间；接管过就一定有老师和接管时间；结束的一定有结束时间。
  CHECK ((status = 'queued') = (teacher_id IS NULL)),
  CHECK ((status = 'queued') = (claimed_at IS NULL)),
  CHECK ((status = 'released') = (released_at IS NOT NULL))
);

-- 同一会话同一时刻最多一条"进行中"的接管（排队或已接管）：重复请求由数据库挡住，而不是应用层先查再写。
CREATE UNIQUE INDEX handoffs_one_active_per_conversation ON handoffs (conversation_id) WHERE status IN ('queued', 'claimed');
-- 老师的待接管队列按时间排序读取。
CREATE INDEX handoffs_active_queue_idx ON handoffs (status, created_at) WHERE status IN ('queued', 'claimed');
CREATE TRIGGER handoffs_touch BEFORE UPDATE ON handoffs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

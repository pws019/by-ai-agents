-- 申请闭环：申请、审计事件、确认卡、幂等记录。
-- 审批状态与执行状态是两条独立的轴：批准 != 执行完成。

CREATE TABLE applications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id         uuid NOT NULL REFERENCES users (id),
  enrollment_id      uuid NOT NULL REFERENCES enrollments (id),
  type               text NOT NULL CHECK (type IN ('transfer', 'refund')),
  reason             text NOT NULL,
  target_cohort_id   uuid REFERENCES cohorts (id),                 -- 目标未知时为 NULL，由老师提出后学员确认
  status             text NOT NULL CHECK (status IN (
                       'draft', 'submitted', 'needs_info', 'awaiting_student_confirmation',
                       'approved', 'rejected', 'withdrawn')),
  execution_status   text NOT NULL DEFAULT 'not_started'
                       CHECK (execution_status IN ('not_started', 'pending', 'completed', 'failed')),
  proposal           jsonb,
  revision           integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  confirmed_revision integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (confirmed_revision IS NULL OR confirmed_revision <= revision),
  -- 只有已批准的申请才可能进入执行流程
  CHECK (execution_status = 'not_started' OR status = 'approved')
);
-- 同一报名、同一类型，同一时间只允许一张"未结束"的申请（不同幂等键的重复申请也拦得住）
CREATE UNIQUE INDEX applications_one_open_per_enrollment_type
  ON applications (enrollment_id, type)
  WHERE status NOT IN ('approved', 'rejected', 'withdrawn');
CREATE INDEX applications_student_id_idx ON applications (student_id);
CREATE TRIGGER applications_touch BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 追加式审计：事件只能新增，不能改、不能删。
CREATE TABLE application_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications (id),
  actor_id       uuid NOT NULL REFERENCES users (id),
  event_type     text NOT NULL,
  revision       integer NOT NULL,
  details        jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_events_application_id_idx ON application_events (application_id, created_at);

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% 是追加式表，不允许 %', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER application_events_append_only
  BEFORE UPDATE OR DELETE ON application_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- 确认卡：绑定申请内容（payload_hash）与版本，一次性使用，可过期、可被新卡作废。
CREATE TABLE confirmations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id),
  application_id uuid NOT NULL REFERENCES applications (id),
  payload_hash   text NOT NULL,
  revision       integer NOT NULL,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- 每张申请同一时间只有一张有效确认卡
CREATE UNIQUE INDEX confirmations_one_active_per_application
  ON confirmations (application_id) WHERE used_at IS NULL AND revoked_at IS NULL;

-- 幂等记录：同一 (操作人, 操作, key) 只能出现一次；同 key 不同请求内容由应用层比对 request_hash 拒绝。
CREATE TABLE idempotency_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     uuid NOT NULL REFERENCES users (id),
  operation    text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  result_id    uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, operation, key)
);

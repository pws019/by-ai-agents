-- 转班历史与回放权益。依赖 applications，所以放在其后。

CREATE TABLE enrollment_changes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id  uuid NOT NULL REFERENCES enrollments (id),
  from_cohort_id uuid NOT NULL REFERENCES cohorts (id),
  to_cohort_id   uuid NOT NULL REFERENCES cohorts (id),
  -- 一张申请最多产生一条转班记录：重复执行批准时，第二次会被这里拦住
  application_id uuid NOT NULL UNIQUE REFERENCES applications (id),
  teacher_id     uuid NOT NULL REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (from_cohort_id <> to_cohort_id)
);

-- 回放权益独立成表：授权查询不只依赖当前报名，转班后旧权益可被撤销（revoked_at）。
CREATE TABLE replay_entitlements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id            uuid NOT NULL REFERENCES users (id),
  cohort_id             uuid NOT NULL REFERENCES cohorts (id),
  source_application_id uuid REFERENCES applications (id),
  source_order_id       uuid REFERENCES orders (id),
  revoked_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(source_application_id, source_order_id) >= 1)   -- 权益必须能追溯来源
);
CREATE INDEX replay_entitlements_student_cohort_idx ON replay_entitlements (student_id, cohort_id);

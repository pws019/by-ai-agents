-- 订单、报名、学习进度。金额一律用整数"分"，不用浮点。

CREATE TABLE orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     uuid NOT NULL REFERENCES users (id),
  cohort_id      uuid NOT NULL REFERENCES cohorts (id),
  policy_id      uuid NOT NULL REFERENCES policies (id),
  paid_cents     bigint NOT NULL CHECK (paid_cents >= 0),
  refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  source         text NOT NULL CHECK (source IN ('seed', 'manual')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- 已退金额不能超过已付金额：即使应用代码有 bug，库也不会记出"多退"
  CHECK (refunded_cents <= paid_cents)
);
CREATE INDEX orders_student_id_idx ON orders (student_id);
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE enrollments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES users (id),
  order_id   uuid NOT NULL UNIQUE REFERENCES orders (id),   -- 一张订单对应一条报名；转班改的是报名的班期
  cohort_id  uuid NOT NULL REFERENCES cohorts (id),
  status     text NOT NULL CHECK (status IN ('active', 'transferred', 'ended')),
  revision   integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enrollments_student_id_idx ON enrollments (student_id);
CREATE TRIGGER enrollments_touch BEFORE UPDATE ON enrollments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 学习进度由老师手工录入或导入，不代表知识掌握程度。
CREATE TABLE learning_progress (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES users (id),
  lesson_id  uuid NOT NULL REFERENCES lessons (id),
  status     text NOT NULL CHECK (status IN ('not_started', 'in_progress', 'completed')),
  source     text NOT NULL CHECK (source IN ('manual', 'import')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, lesson_id)
);
CREATE TRIGGER learning_progress_touch BEFORE UPDATE ON learning_progress FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

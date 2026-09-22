-- 课程目录：课程 -> 版本 -> 班期 -> 课次。发布后的新版本替代而不是覆盖旧版本。

CREATE TABLE courses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  archived   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER courses_touch BEFORE UPDATE ON courses FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE course_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses (id),
  version      integer NOT NULL CHECK (version > 0),
  outline      jsonb NOT NULL DEFAULT '{}',
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, version),
  -- 供 cohorts 做复合外键：保证班期的 course_id 与其课程版本所属课程一致
  UNIQUE (id, course_id)
);
CREATE TRIGGER course_versions_touch BEFORE UPDATE ON course_versions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 政策文本：历史订单引用它，所以订单存在时不能删除（外键默认 RESTRICT）。
CREATE TABLE policies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version      integer NOT NULL UNIQUE CHECK (version > 0),
  text         text NOT NULL,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER policies_touch BEFORE UPDATE ON policies FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE cohorts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id         uuid NOT NULL REFERENCES courses (id),
  course_version_id uuid NOT NULL,
  name              text NOT NULL,
  start_at          timestamptz,                                -- 未知时为 NULL，不编造
  price_cents       bigint CHECK (price_cents >= 0),            -- 未知时为 NULL
  currency          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  is_current_sale   boolean NOT NULL DEFAULT false,
  status            text NOT NULL CHECK (status IN ('upcoming', 'running', 'ended')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (course_version_id, course_id) REFERENCES course_versions (id, course_id)
);
-- 每门课程最多一个当期在售班期
CREATE UNIQUE INDEX cohorts_one_current_sale ON cohorts (course_id) WHERE is_current_sale;
CREATE TRIGGER cohorts_touch BEFORE UPDATE ON cohorts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE lessons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id        uuid NOT NULL REFERENCES cohorts (id),
  title            text NOT NULL,
  position         integer NOT NULL CHECK (position > 0),
  replay_asset_key text,                                        -- 没有回放时为 NULL
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cohort_id, position)
);
CREATE TRIGGER lessons_touch BEFORE UPDATE ON lessons FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

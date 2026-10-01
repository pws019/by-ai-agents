-- 索引任务、发布激活、撤回与失败重跑（T-26）。索引本身（embedding → Qdrant）由
-- education-agent/src/education_agent/ingestion/ 用 psycopg 直接读写这两张表；这里只定义
-- 状态落在哪、不变量由谁保证，不含任何 TS 侧业务逻辑。
--
-- "发布/撤回" 是独立于"导入"的动作（design.md §6）：导入（T-25）只产生一个新 version，
-- 不代表它可以被检索到；必须先建完索引、确认完整，再激活，查询才会用它。
-- 同一 lesson 任意时刻最多一个 activated 版本——这是 AC-016 的关键不变量：
-- 新版本激活与旧版本撤回必须在同一个事务里原子发生，不存在"同时两个都能查到"的窗口。
--
-- "旧版本即使未物理清除也不能返回"：activated_at/revoked_at 是唯一的真相来源，查询
-- （T-27）必须据此过滤，不能只信 Qdrant 里还有没有点位——物理清理是 knowledge_index_jobs
-- 里一条独立的 cleanup 任务，异步重试，不阻塞撤回立即生效。
ALTER TABLE knowledge_documents
  ADD COLUMN visibility   text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN revoked_at   timestamptz,
  -- 没激活过不该有撤回时间；撤回之后不该再是激活状态——避免状态字段自己互相矛盾。
  ADD CONSTRAINT knowledge_documents_revoked_after_activated
    CHECK (revoked_at IS NULL OR activated_at IS NULL);

-- 同一 lesson 最多一个 activated 版本，数据库强制，不依赖应用层"先查后写"。
CREATE UNIQUE INDEX knowledge_documents_one_active ON knowledge_documents (lesson_id) WHERE activated_at IS NOT NULL;

-- 索引/清理任务表。kind='index' 对应"构建新版本索引→检查完成"；kind='cleanup' 对应撤回后
-- 异步物理清除旧向量。两种任务都可能失败重跑，所以统一一张表、同一套状态机，
-- 而不是给清理另起一套机制（design.md §8："数据库任务/outbox" 而非消息队列）。
CREATE TABLE knowledge_index_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES knowledge_documents (id),
  kind         text NOT NULL CHECK (kind IN ('index', 'cleanup')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- 一个 document 版本的索引只需要一条任务记录；重跑是更新这一行，不是插入新行，
  -- 这样"失败重跑无重复数据"在任务表自己这层就先成立。
  UNIQUE (document_id, kind)
);
CREATE INDEX knowledge_index_jobs_pending_idx ON knowledge_index_jobs (kind, status);
CREATE TRIGGER knowledge_index_jobs_touch BEFORE UPDATE ON knowledge_index_jobs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

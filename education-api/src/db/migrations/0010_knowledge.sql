-- 字幕/讲义导入（T-25）。"更新资料"在这里是重新导入一整份、生成新 version，
-- 不是原地编辑某个 segment——跟 course_versions/policies 是同一个惯例（改动=新版本，
-- 不是 UPDATE），AC-016 要的也是"旧片段不可检索"而不是"物理删除"，留给 T-26 做撤回标记。
--
-- source_hash / content_hash 现在就存，但这一步不基于它们做检索/索引判断（那是 T-26 的事），
-- 只在导入时用 source_hash 判断"这份文件跟这节课当前最新版本完全一样，别再造一条新 version 出来"；
-- content_hash 留给 T-26 判断"新版本里哪些片段内容没变，向量可以直接复用，不用重新跑一遍模型"。

CREATE TABLE knowledge_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id    uuid NOT NULL REFERENCES lessons (id),
  kind         text NOT NULL CHECK (kind IN ('srt', 'vtt', 'markdown')),
  source_name  text NOT NULL,   -- 原始文件名，只为排查用，不参与唯一性
  source_hash  text NOT NULL,   -- 原始文件内容的 sha256，判断"是不是同一份文件又传了一次"
  -- VTT 头部 NOTE 注释解出来的来源信息（真实数据里是分享链接/原始标题/录制时间）；
  -- SRT/Markdown 没有这类头部，这三列恒为 NULL。
  source_url   text,
  source_title text,
  recorded_at  timestamptz,
  version      integer NOT NULL CHECK (version > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lesson_id, version)
);
CREATE INDEX knowledge_documents_lesson_latest_idx ON knowledge_documents (lesson_id, version DESC);

CREATE TABLE knowledge_segments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES knowledge_documents (id),
  position     integer NOT NULL CHECK (position >= 0),  -- 在文档内的顺序，从 0 开始
  content      text NOT NULL,
  content_hash text NOT NULL,  -- content 的 sha256，供 T-26 做跨版本的"没变就不重新嵌入"判断
  start_ms     integer,        -- 字幕才有；讲义没有时间轴，NULL——不允许编造
  end_ms       integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, position),
  CHECK ((start_ms IS NULL) = (end_ms IS NULL)),
  CHECK (start_ms IS NULL OR end_ms >= start_ms)
);
CREATE INDEX knowledge_segments_document_idx ON knowledge_segments (document_id, position);

-- 支持学员删除自己的会话（硬删除，物理从库里去掉，不是软删除）。
-- runs/messages/handoffs 是会话的纯子记录，离开会话没有独立意义：删会话连带把它们删掉。
-- applications.source_run_id 不是子记录——它是"这张申请是哪次 Agent 运行起草的"这条可追溯性的链接
-- （见 0008 的注释），申请本身是业务记录，不能因为学员删了当时的聊天会话就消失；会话删除后这条
-- 链接改成 NULL（申请还在，只是找不到当时是哪次运行起草的了），而不是跟着级联删除或者挡住删除。

ALTER TABLE runs DROP CONSTRAINT runs_conversation_id_fkey;
ALTER TABLE runs ADD CONSTRAINT runs_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;

ALTER TABLE messages DROP CONSTRAINT messages_conversation_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;

ALTER TABLE messages DROP CONSTRAINT messages_run_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;

ALTER TABLE handoffs DROP CONSTRAINT handoffs_conversation_id_fkey;
ALTER TABLE handoffs ADD CONSTRAINT handoffs_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;

ALTER TABLE applications DROP CONSTRAINT applications_source_run_id_fkey;
ALTER TABLE applications ADD CONSTRAINT applications_source_run_id_fkey
  FOREIGN KEY (source_run_id) REFERENCES runs(id) ON DELETE SET NULL;

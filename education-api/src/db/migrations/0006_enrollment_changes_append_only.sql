-- enrollment_changes 记录的是"这份报名什么时候被转了班、因为哪张申请"，跟 application_events
-- 一样是不该被事后改动的审计事实——补上同一个 forbid_change() 触发器（0004 已经定义过），
-- 不再只靠"代码里从来不写 UPDATE/DELETE"这种约定，数据库层面直接拒绝。
CREATE TRIGGER enrollment_changes_append_only
  BEFORE UPDATE OR DELETE ON enrollment_changes FOR EACH ROW EXECUTE FUNCTION forbid_change();

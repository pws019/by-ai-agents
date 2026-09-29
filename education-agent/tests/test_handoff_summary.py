"""交接摘要（graphs/handoff.py）：确定性代码，从对话历史里拼出，不经过模型。

要保护的是 requirements F-006 的"不可包含猜测事实"：
  - 事实只来自工具的成功返回；学员的话原样引用；模型说过的话一律不进摘要；
  - 每一节都出现，没内容写"无"；
  - 认不出的数据结构只写"已查询 X"，不编细节；格式坏掉的消息不能让摘要构造崩溃（转人工不能因为摘要出错而失败）。
"""
import json

from education_agent.graphs.handoff import REASON_STUDENT_REQUEST, build_handoff_summary


def user(text: str) -> dict:
    return {"role": "user", "content": text}


def assistant(text: str = "", *calls: tuple[str, str]) -> dict:
    m: dict = {"role": "assistant", "content": text}
    if calls:
        m["tool_calls"] = [{"id": cid, "name": name, "args": {}} for cid, name in calls]
    return m


def tool_ok(call_id: str, data: dict) -> dict:
    return {"role": "tool", "tool_call_id": call_id, "content": json.dumps({"ok": True, "data": data}, ensure_ascii=False)}


def tool_err(call_id: str, code: str) -> dict:
    return {"role": "tool", "tool_call_id": call_id, "content": json.dumps({"ok": False, "error": {"code": code}})}


def summarize(messages: list[dict], reason: str = REASON_STUDENT_REQUEST) -> str:
    return build_handoff_summary(messages, reason)


def test_every_section_is_present_and_empty_ones_say_none():
    s = summarize([user("我想找老师")])
    for title in ("【学员诉求】", "【已核验事实】", "【相关申请】", "【工具失败】", "【待处理】"):
        assert title in s
    assert "“我想找老师”" in s
    # 三个没有内容的节都明确写"无"，而不是省略——老师能区分"没有"和"忘了写"。
    assert s.count("- 无") == 3
    assert REASON_STUDENT_REQUEST in s


def test_only_the_last_three_student_messages_are_quoted_whitespace_collapsed_and_truncated():
    msgs = [user("第一句"), user("第二句"), user("第三句"), user("第四\n\n句   带空白"), user("很长" * 200)]
    s = summarize(msgs)
    assert "第一句" not in s and "第二句" not in s
    assert "“第三句”" in s and "“第四 句 带空白”" in s
    long_line = next(line for line in s.splitlines() if line.startswith("- “很长"))
    assert long_line.endswith("…”") and len(long_line) < 260


def test_assistant_words_never_enter_the_summary():
    # 模型的话是它的表述，不是核验过的事实：哪怕它说得很肯定，也不能被当成事实交给老师。
    msgs = [
        user("我的退费怎么样了"),
        assistant("我猜你的退费已经批准并且钱已经退回了"),
        user("我要转人工"),
    ]
    s = summarize(msgs)
    assert "已经批准" not in s and "钱已经退回" not in s
    assert "“我的退费怎么样了”" in s and "“我要转人工”" in s


def test_verified_facts_come_from_successful_tool_results():
    msgs = [
        user("我想看看进度"),
        assistant("", ("c1", "getMyEnrollment"), ("c2", "getMySchedule"), ("c3", "getMyProgress"), ("c4", "getTransferTargets")),
        tool_ok("c1", {"items": [{"cohort": {"name": "AI 全栈春季班"}, "status": "active"}]}),
        tool_ok("c2", {"items": [{"title": "第 1 课"}, {"title": "第 2 课"}]}),
        tool_ok("c3", {"items": [{"lessonId": "L1", "status": "done"}]}),
        tool_ok("c4", {"items": [{"name": "AI 全栈秋季班"}]}),
        assistant("你已经学完第一课"),
    ]
    s = summarize(msgs)
    assert "报名 1 个：AI 全栈春季班（在读）" in s
    assert "课表共 2 节课" in s
    assert "学习进度记录 1 条" in s
    assert "可转入班期 1 个：AI 全栈秋季班" in s
    assert "你已经学完第一课" not in s


def test_unrecognized_shape_only_says_it_was_queried_and_never_invents_details():
    msgs = [assistant("", ("c1", "getCurrentOffering"), ("c2", "getMyEnrollment")), tool_ok("c1", {"whatever": 1}), tool_ok("c2", {"items": "不是列表"})]
    s = summarize(msgs)
    assert "已查询 getCurrentOffering" in s
    assert "已查询 getMyEnrollment" in s


def test_tool_failures_are_listed_with_the_error_code_and_not_counted_as_facts():
    msgs = [assistant("", ("c1", "getMyProgress")), tool_err("c1", "UPSTREAM_ERROR"), tool_err("orphan", "TIMEOUT")]
    s = summarize(msgs)
    assert "getMyProgress：UPSTREAM_ERROR" in s
    assert "未知工具：TIMEOUT" in s  # 找不到对应调用的工具消息也不丢
    facts = s.split("【已核验事实】")[1].split("【相关申请】")[0]
    assert "UPSTREAM_ERROR" not in facts and "- 无" in facts


def test_related_applications_show_latest_state_and_execution_status():
    msgs = [
        assistant("", ("c1", "prepareApplication")),
        tool_ok("c1", {"applicationId": "aaaaaaaa-1111-2222-3333-444444444444", "revision": 1, "status": "draft", "summary": {"type": "refund"}}),
        assistant("", ("c2", "getApplicationStatus")),
        tool_ok("c2", {"id": "aaaaaaaa-1111-2222-3333-444444444444", "type": "refund", "status": "approved", "executionStatus": "pending", "revision": 4}),
    ]
    s = summarize(msgs)
    apps = s.split("【相关申请】")[1].split("【工具失败】")[0]
    assert apps.count("申请") == 1, "同一张申请只保留最新状态"
    assert "退费申请，状态 approved，执行 pending，第 4 版（id aaaaaaaa）" in apps
    assert "draft" not in apps


def test_application_list_result_is_expanded():
    msgs = [
        assistant("", ("c1", "getApplicationStatus")),
        tool_ok("c1", {"items": [
            {"id": "11111111-0000-0000-0000-000000000000", "type": "transfer", "status": "submitted", "revision": 2},
            {"id": "22222222-0000-0000-0000-000000000000", "type": "refund", "status": "draft", "revision": 1},
        ]}),
    ]
    apps = summarize(msgs).split("【相关申请】")[1].split("【工具失败】")[0]
    assert "转班申请，状态 submitted，第 2 版（id 11111111）" in apps
    assert "退费申请，状态 draft，第 1 版（id 22222222）" in apps


def test_malformed_history_never_breaks_the_summary():
    # 转人工不能因为摘要构造出错而失败：坏 JSON、非对象、缺字段都要被容忍。
    msgs = [
        user("转人工"),
        {"role": "tool", "tool_call_id": "c1", "content": "这不是 JSON"},
        {"role": "tool", "tool_call_id": "c2", "content": "[1, 2, 3]"},
        {"role": "tool", "content": json.dumps({"ok": True, "data": {"items": [{"id": None, "status": "x"}]}})},
        assistant("", ("c3", "getApplicationStatus")),
        tool_ok("c3", {"items": [{"status": "draft"}, {"id": 123}]}),
    ]
    s = summarize(msgs)
    assert "“转人工”" in s and "【待处理】" in s

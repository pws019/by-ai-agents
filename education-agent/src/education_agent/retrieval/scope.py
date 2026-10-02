"""学员当前能检索到的 cohort 范围（T-27）。

design.md §6："私人检索先从 API 取得有效 cohort/content 范围"——权威答案只在业务 API 那边，
不是 Python 自己拿 enrollments 表猜。复用 getMyEnrollment 工具已经在用的同一个端点
（GET /me/enrollments），不新开一个专门给检索用的端点。

范围只取 status=="active" 的报名：AC-013 说的"本期"、AC-015 说的"本期学员看不到外班期受限
文本"，都是指学员当前这一期——转班转走之后的旧报名是 status="transferred"，不在范围内；
那个旧班期的回放访问是 replay_entitlements 的事（T-28），不是这里要解决的问题。
"""
from ..tools.client import BusinessApi


async def fetch_cohort_scope(api: BusinessApi) -> set[str]:
    page = await api.get("/me/enrollments")
    return {item["cohort"]["cohortId"] for item in page["items"] if item["status"] == "active"}

# RAG 基线评估（T-29）

对应 design.md §1 的 `evals/education/`："固定数据集、断言、实验配置及报告说明"。

## 这份评估测什么

不是测"检索效果好不好"（召回率、排序质量）——那需要真实课程数据和更大的测试集，`cases.json`
顶部的 `note` 已经写明这里用的是合成数据，不声称完成真实课程检索评估（见
`specs/education-service-agent/tasks.md` 的"风险与停止条件"）。

这里测的是编排正确性能不能稳定复现，三件事：

1. **直接命中**（AC-013）：问题和已发布资料相关，应该搜到、引用正确课次。
2. **无依据明确报告**（AC-018）：问题在已导入资料里完全没有覆盖，应该明确说没找到，不能编答案凑数。
3. **更新资料后新答案可追溯版本**（T-29 验收项本身）：v1 发布→提问→拿到 v1 的引用；导入并发布
   修正过的 v2（原子撤回 v1）→ 再问同样的问题→引用必须指向 v2，不能还停在 v1。这一条不是数据
   集驱动的（跟前两条不同），是 `rag_baseline.py` 里一个独立的多步场景，因为它测的是"版本更新
   之后"这个时间维度，不是单次查询的分类正确性。

## 怎么跑

```bash
cd education-agent
PYTHONPATH=src uv run python -m education_agent.evals.rag_baseline
```

需要本地 Postgres + Qdrant（`npm run edu:infra`）和本地 embedding 服务
（`npm run dev --workspace=customer-embedding-demo`）——跟 `education-agent/tests/test_retrieval.py`
同一组依赖，不是额外发明一套。脚本自己建临时数据库和临时 Qdrant collection，跑完删除，不污染
共享的开发库。

## 报告

每次运行在 `reports/` 下生成一份带 UTC 时间戳的 Markdown 报告（PASS/FAIL 和失败原因）。
脚本以非零退出码报告失败，可以接进 CI，但本仓库目前没有为它接 CI（M4 阶段门槛只要求"先证明
普通 RAG 能运行"，见 tasks.md）。

## 已知局限

- 合成数据，不是真实课程字幕/讲义，不能当作真实检索质量的证据。
- 只有 2 条查询 case，覆盖"命中"和"无依据"两类，没有覆盖排序质量、多候选去重这些更细的维度——
  `search_knowledge` 本身服务端限制候选数、权限过滤等编排正确性已经在 T-27 的
  `tests/test_retrieval.py` 覆盖过，这里不重复测。
- 不含权限/cohort 边界场景（那也是 T-27 测过的），这里的 cohort 范围固定为"已报名"，不是变量。

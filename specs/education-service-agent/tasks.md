# 实施任务与学习计划

架构：monorepo + 前后端分离；先契约、业务数据，再编排/UI，最后真实模型与实验。
共 40 项，119 小时仅为初版实现与验证的粗估，不是学习完成时间或交付保证。各任务估时尚未经过 spike 校准，M0 完成后据实重估。
学习型排期暂按每周 15～20 小时、12～16 周安排，包含讲解、独立练习、故障复现和复盘；不包含不可控的云资源等待。不得为赶排期删减核心学习内容。
学习要求见 learning-plan.md：T/AC 记录实现验收，L 记录学习验收，两者独立。
不得在没有测试证据时勾选。每阶段完成更新 progress.md，记录命令、结果、问题和学习要点。

## M0：基线、契约与开发环境（14h）

- [x] T-01（2h）检查 git 状态与各模块，记录现有运行方式、保留 legacy 基线，不覆盖用户修改。`specs/education-service-agent/progress.md`。验收：明确迁移/保留清单。
- [x] T-02（4h）将 design.md 的 API/SSE 固化为可验证 OpenAPI 与事件 schema。`contracts/education/openapi.yaml`、`events.schema.json`。消费方：education-api、education-agent、customer-frontend、evals。验收：schema 验证通过，状态错误/确认接口有样例。
- [x] T-03（3h）添加开发数据服务与 .env.example，支持 mock/real 模式。`infra/education/compose.yaml`。验收：健康检查通过，重启数据保留；密钥不入库。
- [x] T-04（3h）创建 Python LangGraph/FastAPI 骨架、持久化 checkpoint，完成工具→中断→重启→恢复 spike。`education-agent/pyproject.toml`、`src/`。验收：记录版本及重启恢复测试。
- [x] T-05（2h）接入 workspace 启动脚本，区分 legacy/education 模式，锁依赖。`package.json`、`turbo.json`、新增模块 package.json。验收：默认教育模式不启动旧模型服务。

阶段门槛：T-04 失败则先排查并记录，不悄悄换框架。讲解 HTTP 服务、Agent loop、checkpoint 的区别。

## M1：业务事实与身份（16h）

- [x] T-06（4h）实现核心数据库 migration、状态字段、金额/唯一约束。`education-api/src/db/`。验收：全新数据库迁移与重复执行机制可复现。
- [x] T-07（2h）生成合成 seed：2 个历史/当前 AI 班期、可选未来目标、1 个历史课程、3 学员、2 老师、版本差异。`data/education/seed/`。验收：数据明确标记合成、可重复初始化开发库。
- [x] T-08（3h）登录/session/角色/资源授权、内部服务认证。`education-api/src/auth/`、`education-agent/src/auth/`。验收：AC-002/003 的账户与 API 部分通过。登录/session/资源授权已完成（见 progress.md）；内部服务认证已在 T-18 完成（`education-api/src/auth/internalContext.ts`、`education-agent/src/education_agent/tools/context.py`，含跨语言测试向量与真实联调），整项勾选
- [x] T-09（3h）实现当期、报名、课表、进度、转入目标只读 API。`education-api/src/routes/`。验收：未知事实返回 null/unknown；AC-001 业务查询通过。
- [x] T-10（2h）老师基础维护/导入 API：班期、报名、课次、进度。`education-api/src/routes/teacher.ts`（单文件，未按原计划开 `teacher/` 目录，规模还不到需要拆分的程度）。验收：输入验证和老师权限通过。
- [x] T-11（2h）前端登录、角色路由、我的学习基础页。`customer-frontend/src/education/`。验收：学生只看到本人记录，刷新身份保持。

阶段门槛：模型尚未接入也能通过页面/API 查询正确业务事实。讲解 course/version/cohort 与认证/授权。

## M2：申请闭环，先不用模型（19h）

- [x] T-12（3h）申请草稿、摘要、版本与确认 API。`education-api/src/routes/applications.ts`。验收：AC-004/005/006。
- [x] T-13（3h）补充、撤回、老师提出方案、学员接受/拒绝，校验状态机。`education-api/src/routes/applications.ts`。验收：AC-007/022；拒绝方案不自动执行。
- [x] T-14（4h）老师批准转班事务、权益选项、审计。`education-api/src/routes/applications.ts`。验收：AC-008，并发冲突和事务失败无半成品。outbox 表推迟到 M3/M4/M5（与 T-06 决定一致），本轮范围不含 outbox。
- [x] T-15（3h）退费协商、批准、人工结果登记与金额边界。`education-api/src/routes/applications.ts`。验收：AC-009；重复登记不重复增加退款额。
- [x] T-16（4h）我的申请与老师审批页、确认卡片、时间线。`customer-frontend/src/education/`（原计划的 `src/routes/` 是 legacy 聊天 Demo 的路由目录，教育服务前端页面统一放在 `src/education/`，跟 T-11 已有的目录一致）。验收：学生提交→老师处理→学生查询无需聊天即可完成，浏览器真机走通。补了一个后端小缺口：`GET /teacher/cohorts/transfer-targets`（老师提转班方案选目标班期用，原来只有学员版）。
- [x] T-17（2h）写入后超时、重复 key、不同 key 重复申请、并发审批集成测试。测试加在 `education-api/src/routes/applications.test.ts`（原计划的 `education-api/tests/` 目录没有建：这些场景测的就是 applications.ts 的端点，跟 T-12～15 已有的测试用的是同一套 app/db 启动样板，拆到独立目录只会复制这段样板代码，不拆更符合项目一贯的"不为了分而分"原则，跟 T-10 的目录调整是同一个道理）。验收：AC-006/008/010/022，其中 AC-008/022 在 T-14/T-13 已有直接覆盖，这轮补的是此前完全没有测试碰到过的两处：①`POST /applications/drafts` 面对"不同 Idempotency-Key"和"真并发"时是否还能靠业务唯一约束收敛成一条申请；②`approve` 的 Idempotency-Key 重放分支（AC-010，此前只测过 approve 的 revision 并发冲突，没测过它自己的幂等重试）。

阶段门槛：领域闭环可独立工作。讲解事务、幂等、revision 和业务状态为何不交给 LLM。

## M3：Agent 与人工协作（22h）

- [x] T-18（3h）固定工具契约及可信 actor 注入，参数/超时/预算。`education-agent/src/tools/`。验收：工具不可指定任意用户或审批。
- [x] T-19（4h）实现 route/query/draft/respond 图、任务状态及确认恢复。`education-agent/src/graphs/`。验收：模型输出申请草稿，只有 UI 确认提交；AC-004/011。
- [x] T-20（3h）会话持久化、BFF SSE 与重复消息/并发生成处理。`education-api/src/chat/`。验收：AC-021；断线可查询完成消息。
- [x] T-21（3h）前端脱离 Mastra SDK，新 HTTP/SSE 适配、工具/确认卡片。`customer-frontend/src/lib/`、`hooks/useChat.ts`。验收：聊天申请流程端到端通过。
- [x] T-22（3h）人工队列、claim/release、摘要及机器人暂停。`education-api/src/handoffs/`、`education-agent/src/graphs/`（摘要在 `graphs/handoff.py`）。验收：AC-012，重复接管状态冲突。范围说明：本任务做的是学员明确要求转人工这一个触发与全部后端，老师侧列表接口和前端入口留给 T-23，Agent 自动转人工（证据不足、工具持续失败）未做，见 progress.md T-22 限制。
- [x] T-23（3h）老师会话工作台和学生排队状态。`customer-frontend/src/education/`（`TeacherHandoffsPage.tsx`）。验收：老师接管回复再归还机器人。
- [x] T-24（3h）mock 模型下编排、故障、取消、重启测试。`education-agent/tests/`、`education-api/src/chat/stream.test.ts`、`tests/e2e/T24-M3.md`。验收：AC-010/011/012/021；报告明确 mock。独立服务直连的 4 项 live API 用例仍需环境变量，见报告。

阶段门槛：申请闭环由聊天触发仍保持安全。讲解工具调用、结构化输出、图节点重放和业务事实回查。

## M4：字幕、回放与 RAG（15h）

- [ ] T-25（3h）SRT/VTT/Markdown 导入、分片、稳定 ID 和来源版本。`education-api/src/knowledge/`、`data/education/transcripts/`。验收：时间戳解析正确，讲义不虚构时间。
- [ ] T-26（3h）索引任务、发布激活、撤回/删除与失败重跑。`education-agent/src/ingestion/`。验收：AC-016，旧版本即使未物理清除也不能返回。
- [ ] T-27（3h）权限过滤 RAG、引用及无依据处理，服务端限制候选数。`education-agent/src/retrieval/`。验收：AC-013/015/018。
- [ ] T-28（3h）受控回放入口、引用与回放卡片。`education-api/src/replays/`、`customer-frontend/src/components/`。验收：播放访问再鉴权，合成演示资源明确标注。
- [ ] T-29（3h）资料维护页面、发布状态和 RAG 基线评估。`customer-frontend/src/routes/`、`evals/education/`。验收：更新资料后新答案可追溯版本，记录基线。

阶段门槛：先证明普通 RAG 能运行，再加入图查询。讲解 chunk、召回、重排、引用和权限筛选。

## M5：知识图谱（13h）

- [ ] T-30（3h）Concept 别名、关系草稿/审核、循环检查、来源记录。`education-api/src/knowledge/relations/`。验收：未经审核的边不发布，自环/循环拒绝。
- [ ] T-31（3h）Neo4j 投影与参数化查询，幂等重建、撤回同步。`education-agent/src/graph_store/`。验收：稳定 ID 和来源版本一致，可从事实表重建。
- [ ] T-32（3h）findReplaySegments/getPrerequisiteLessons 与普通 RAG 组合，深度≤2。`education-agent/src/tools/`。验收：AC-014/015/018/019。
- [ ] T-33（2h）知识审核简页、先修顺序与来源展示。`customer-frontend/src/routes/`。验收：老师可审核，学生可理解为何推荐该回放；无需复杂可视化编辑器。
- [ ] T-34（2h）纯 RAG 对比 RAG+图谱，直接定位/先修/无覆盖三类测试。`evals/education/graph/`。验收：报告正确率、引用、延迟和失败例，无虚构收益。

阶段门槛：有真实图查询及对照证据。讲解关系型数据库与图数据库的取舍、投影一致性和图谱能力边界。

## M6：微调、稳定性与面试交付（20h 实现粗估）

拆为三个独立验收单元：M6a=T-35/36（数据与微调）；M6b=T-37/38（追踪、故障、负载与回归）；M6c=T-39/40（复现文档与面试）。分别对应 L-06/07/08，最终演示不能替代前两项验证。

- [ ] T-35（3h）整理教育 SFT 数据、来源/模板族划分、去重与泄漏检查。`data/education/sft/`。验收：独立测试集不进入训练，动态事实不成为记忆目标。
- [ ] T-36（4h）云训练配置、预算说明、基座/提示词/QLoRA 对照。`customer-service-qlora/education/`。验收：真实运行有日志与产物；没资源时标记待运行，不伪造结果。训练等待不含估时。
- [ ] T-37（3h）请求级 traces、版本记录、脱敏、依赖失败和预算测试。`education-api/`、`education-agent/`。验收：一次失败可定位路由/检索/工具/生成。
- [ ] T-38（4h）完整 AC 回归、负载基线、真实模型冒烟及局限记录。`evals/education/reports/`。验收：所有确定性 AC 通过，真实模型与 mock 结果分列。
- [ ] T-39（3h）setup/dev/seed/test/eval 文档、容器启动检查、录制演示脚本。`README.md`、`docs/education/`。验收：新环境按文档复现；不包含私密资料。
- [ ] T-40（3h）实验报告、3 篇设计取舍、面试问答、学习复盘及真实简历草稿。`docs/education/`。验收：陈述有代码/测试/实验依据；不虚构线上业绩。

## 依赖关系

- T-02 是跨端契约基础；T-03→T-04；T-04 是 LangGraph 迁移决策门槛。
- T-06→T-07/08/09/10；T-08/09→T-11。
- T-06/08→T-12→T-13→T-14/15→T-16/17。
- T-04/09/12→T-18→T-19；T-08→T-20→T-21；T-20→T-22→T-23；T-19/21/23→T-24。
- T-06/10→T-25→T-26→T-27→T-28/29；T-18 消费新检索契约。
- T-25/26→T-30→T-31→T-32→T-33/34。
- T-18/19 契约稳定后 T-35→T-36；T-37 的基础 requestId/runId 和工具耗时必须从 M3 开始记录，M6b 补全验证；T-34/36/37→T-38→T-39/40。
- 云资源缺失只阻塞 T-36 的真实运行，不阻塞 UI、业务、图谱和 mock 回归。

## 风险与停止条件

- 没有真实字幕：先用合成样例跑通，不声称完成真实课程检索评估。
- 模型工具格式不稳定：保留原始失败和基座对照，先验证协议再考虑微调。
- 图与向量更新不一致：按 activeVersion 筛选，失败任务可重跑，禁止直接使用旧投影。
- 学习范围过大：按阶段门槛交付，优先 AC；BERT、DSH、复杂图编辑器均不进主线。
- 破坏性数据库操作、付费云资源、公开部署及真实公司数据导入需要具体说明后取得授权。
- 不为每个小步骤请求批准；仅确实缺业务事实或超出授权的动作才询问。

## 评估贯穿开发

M0 建立案例格式和首批期望结果；M1/M2 补权限与状态断言；M3 补工具、恢复和交接；M4 建立 RAG 基线；M5 做图谱对照；M6a 做模型对照；M6b 汇总回归。不得把首次评估推迟到最后。

## 学习型排期参考

| 周次 | 实现与学习重点 | 学习验收 |
|---|---|---|
| 1～2 | M0：契约、Python 服务、LangGraph 验证 | L-00 |
| 3～4 | M1/M2：业务事实、权限、申请事务 | L-01/02 |
| 5～7 | M3：工具、多轮状态、中断恢复、人工协作 | L-03 |
| 8～9 | M4：字幕、检索、重排、引用与评估 | L-04 |
| 10～11 | M5：图谱建模、审核、查询与对照 | L-05 |
| 12～13 | M6a：数据、QLoRA、真实模型对照 | L-06 |
| 14 | M6b：失败定位、负载与回归 | L-07 |
| 15～16 | M6c：独立修改、复盘与面试演示 | L-08 |

上表按 16 周展开。熟悉的 Web 内容可通过独立演示提前验收，缩短至约 12 周；这是初始规划，不保证固定时间掌握。允许调整节奏，不缩减核心学习证据。

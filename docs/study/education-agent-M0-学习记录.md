# 教育学员服务 Agent · M0 学习记录

日期：2026-09-20～21。范围：M0 的 T-01～T-03 及其后的答疑与理解检查。
图与笔记另见 idea-field「教育学员服务 Agent 学习讨论」（M0-1 业务全景、M0-2 申请状态机、M0-3 确认卡时序）。
实现证据以 `specs/education-service-agent/progress.md` 为准，本文只记录学习过程。

## 1. 概念澄清

**OpenAPI 与 OpenAI 无关**，只是名字相近。OpenAPI 是描述 HTTP 接口的标准格式。

| 东西 | 作用 | 类比 |
|---|---|---|
| OpenAPI（`openapi.yaml`） | 接口契约：路径、请求、响应、错误 | 接口文档的标准写法，人和机器都读 |
| Redocly | 检查 OpenAPI 文件自身是否合规 | ESLint |
| JSON Schema（`events.schema.json`） | 描述一段 JSON 应有的结构 | 类型定义 |
| Ajv | 用 JSON Schema 校验真实数据 | 运行时类型检查 |

- "把 API/SSE 固化为可验证契约"：把 design.md 里给人读的接口表，落成机器可检查的文件；改接口必须先改契约。
- `$ref: '#/components/schemas/X'` 指向**同一文件**里 `components.schemas.X`；`paths` 写接口，`components` 放可复用零件。
- **局限（重要）**：目前"可验证"只证明契约自洽——校验对象是手写样例，没有真实后端参与。"后端遵守契约"要到 T-20（BFF SSE）、T-24（Agent 事件）才能用真实事件验证。
- tasks.md 里的 4h 是**实现估时**，不是学习时间。当前没有任何接口被实现，只有契约。

## 2. 业务背景

卖 AI 全栈课，按期开班；先直播后有回放，学员可看**本人班期**回放。转班、退费由学员申请、老师人工处理，系统不自动判断资格或计算金额。Agent 是聊天入口，能查信息、起草申请，**不能批准**。

三条设计主线：
1. 写操作必须确认（学员点确认、老师批准），不交给模型。
2. 修改带版本号（`expectedRevision`），防止拿旧内容执行新操作。
3. 状态由服务端说了算，Agent 只读事实，不是事实源。

## 3. 理解检查题与结论

### Q1：confirm 为什么要带 confirmationId 和 expectedRevision
- 只带 applicationId，无法知道用户看的是哪一版内容，可能"同意的是旧版，执行的是新版"。
- 修改草稿是**同一个 applicationId 的 revision+1**，并签发新确认卡、旧卡作废；不是新建申请（否则违反 AC-006 唯一性）。
- `expectedRevision`：防旧版本内容执行新版本。
- `confirmationId`：服务端下发，绑定 payloadHash，有过期，一次性；证明"用户确实看到了这份内容"，防模型输出"已确认"或文档里的注入指令（AC-017）。
- 接口本身仍要求登录且必须是 owner，"谁都能调"说重了。
- 网络抖动重复点击带同一 Idempotency-Key 会返回第一次的结果，不算失效。
- 旧卡 409 后：透出错误、拉取最新状态、展示最新摘要，**由用户主动重新确认**；不可自动确认新卡。

### Q2：replay.card 为什么不带播放地址
- 事件会被持久化进聊天记录，地址写进去就成了"过期的授权"。
- 转班后旧班期回放权益可能被撤销，点击时必须重新检查（F-001："不仅靠检索时的过滤"）。
- 地址被复制转发会泄露 → 还需短期有效地址或受控播放路由（T-28 时比较两种做法）。

### Q3：申请状态机预测题
1. 学员拒绝老师方案 → 回到 submitted，不执行任何目标（拒绝不是批准；老师可重新提方案或拒绝）。submitted 有两种来源：刚提交、方案被拒后退回。
2. 撤回与批准并发（AC-022）：靠 **expectedRevision + 当前状态 + 事务内锁记录**，与 confirmationId 无关（它只用于学员确认动作）。撤回先到 → revision+1，批准 409；批准先到 → 批准后不可撤回，撤回 409 `INVALID_STATE`。恰好一个成功。
   - 不锁的后果：丢失更新——两请求都读到 submitted/revision=3，各自写入，可能出现"报名已转班、申请显示 withdrawn、审计两条都有"，且不报错。
   - 另一种写法：条件更新 `UPDATE ... WHERE id=? AND revision=3`，看受影响行数，0 行即冲突（T-14 时比较两种）。
3. 退费批准后（approved + pending）：应说"老师已批准退费，具体退款仍在处理中"，不承诺到账时间，绝不能说"已到账"（AC-009）。"登记"在系统里指老师手工录入结果，避免混用。

审批状态与执行状态是**两条独立的轴**：批准 ≠ 执行完成。转班事务内 approved+completed；退费 approved+pending，登记后才 completed。

## 4. 踩坑（实现侧，供 L-00/L-07 复盘）
- Neo4j 镜像把所有 `NEO4J_*` 环境变量当配置，自加 `NEO4J_PASSWORD` 会导致容器启动失败。
- 验证要有"发生过"的证据：一次因 zsh 未拆词导致命令没执行，读回数据不构成重启证据；改用容器 StartedAt 变化。
- `lsof` 里 5433 由 `ssh` 监听是 Colima 端口转发，不是端口冲突。
- 画图工具限制：流程图不支持 `<br/>`、`[( )]` 圆柱节点、`-.文字.->` 虚线标签。

## 5. 学习状态

| 项 | 状态 |
|---|---|
| T-02 理解检查 Q1、Q2 | 通过 |
| 状态机预测 Q1、Q3 | 通过 |
| 状态机预测 Q2 | 首次答偏，讲解后复述通过 |
| L-00 | 未开始（绑定 T-04） |
| L-02 | 已预习，独立练习待做（复现并发审批、预测结果、定位机制） |

下次入口：T-04（LangGraph 骨架 + 工具→中断→重启→恢复 spike）。

## 6. T-04 理解检查（L-00）
- 题1：interrupt 前的节点代码恢复时会重跑；若是"创建申请"会建两份，必须幂等（Idempotency-Key），或把写入放到 interrupt 之后/拆节点。学员答对方向。
- 题2：HTTP 断开只是这次连接没了，任务状态在 checkpoint，重连应查状态而非重发。checkpoint 存图执行状态（State、下一节点、待处理 interrupt），业务事实以业务 API 为准。学员初答把 checkpoint 等同业务流程，已纠正。
- 崩溃时正在跑的节点没有 checkpoint，会从头重跑，这是题1风险来源。
- L-00 独立练习（缺原因则等待补充的分支）待做。

## 7. 读代码后的三问（L-00）
- 按 thread_id 查 checkpoint，search_path 只决定 schema。task_id 在 spike 里直接当 thread_id，正式版是否多一层映射待设计。
- 换成内存存储：重启后 `_snapshot` 里 created_at 为空 → 404，next 断言失败；多 worker 也会各有一份内存。
- 恢复粒度：已完成节点不重跑，被中断节点从第一行整体重跑，`interrupt` 第二次直接返回 resume 值。学员初答"从中断节点开始跑"，已纠正。
- 留给练习的思考：不靠幂等键，能否通过节点拆分让"创建申请"只执行一次（把写入放到 interrupt 之后或独立节点）。

## 8. checkpoint 写入时机与 worker（L-00 追问）
- 实测一个完成任务：`checkpoints` 表 5 行（step -1 输入、0 进入 draft、1 draft 完成、2 confirm 完成、3 finalize 完成）。每个节点跑完写一次，interrupt 不单独产生 checkpoint，而是记在 `checkpoint_writes`（`__interrupt__`、`__resume__`）。恢复 = 最后一条完整 checkpoint + writes。
- worker = 独立操作系统进程（如 `uvicorn --workers N`），各有独立内存；内存存储在多 worker 下也会失败。
- "只执行一次"：放 draft（已完成节点不重跑，但发生在用户确认前）或 interrupt 之后/独立节点；节点边界能缩小重跑范围，但真实写入仍需幂等键。

## 9. L-00 讲明白回答（纠正三处）
- async：`async def` 调用得协程对象，需 await；同步阻塞调用会卡住整个事件循环。服务边界 = 职责边界（Agent 编排，业务事实与权限在业务 API）。
- 模型只提议，工具是后端执行的函数，LangGraph 是编排不是工具；spike 没有模型。
- HTTP 断开可能取消处理协程（如流式响应），可恢复取决于状态已落库；前端重连应查状态。此点待练习中实测。
- 练习：缺 reason 则 interrupt 等待补充，中间 kill -9 后恢复，用 spike_log 说明重跑。学员执行中。

## 10. Python async 与 JS 对比（L-00 补讲）
- 协程 = 可暂停的函数，与 JS generator/async 同源。差异：Python 调用 `async def` 不执行（只得协程对象，忘 await 只有警告）；事件循环需 `asyncio.run` 或由 uvicorn 启动；Promise≈Task，Promise.all≈gather。
- 实验（scratchpad/demo.py）：await 串行 0.4s，gather 并发 0.2s，协程里用 time.sleep 并发失效 0.4s。
- 检查题：10 个请求下阻塞 sleep(5) 第 10 个总耗时约 50s（先等 45s），await asyncio.sleep(5) 全部约 5s。学员答对。补充：阻塞会卡住整个事件循环（含健康检查）；FastAPI 的普通 `def` 会进线程池，`async def` 里不能有阻塞调用。
- L-00「async 与服务边界」讲明白：通过。

## 11. L-00 独立练习结论
- 结构：ask_reason（可 interrupt）→ draft（写操作）→ confirm → finalize。节点边界 = checkpoint 边界，写操作放在被中断节点之后，重跑不会重复写。
- 日志证据：`ask_reason, reason:enter, ask_reason, reason:enter, reason:resumed, draft, confirm:enter`。
- 协议（方案 B）：中断带 type，resume 回传 type+value，服务端与当前 pendingInterrupt 比较，不一致 409；无待处理中断也 409。
- 调试教训：500 先看服务端日志；`.json()` 后丢失 status_code；dict 用 `["k"]`；next 是 list；测试要反向验证（移除保护看是否失败）。
- 仍需：M3 前用等价案例无提示复现；调用图补充 checkpoint 写入点与重跑标注。

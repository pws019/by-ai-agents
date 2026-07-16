# 数据集扩充计划（data-v2）

参考 `data/customer_service_zh_mock.json` 与 `data/customer_service_zh_sft.json` 的字段结构
（instruction / input / output / system / 可选 history），生成新的 `data-v2` 版本：

- `data-v2/customer_service_zh_mock.json`：每个场景贡献 **1 条** mock 测试数据
- `data-v2/customer_service_zh_sft.json`：每个场景贡献 **10 条** 训练数据（含部分多轮 history）

共 48 个场景 → mock 48 条 + sft 480 条（新增部分，不含旧 data 目录数据）。

处理原则：同一场景内的 10 条不是简单换订单号，而是从不同触发点/不同情绪/不同信息完整度切入。

补充原则（2026-07-16 确认）：
- 涉及订单/物流/退款/库存等实时状态的问题，必须引导用户提供订单号等标识或说明会查询系统，不能凭空断言结果（对应架构文档中"API 管实时状态，QLoRA 不记业务知识"的分工）。
- 机器人客服（AI客服）不得冒充人工客服本人，也不能声称已完成人工处理；需要人工介入时，应引导用户申请转接人工客服（该能力后续由项目实现），而不是自称"人工核实"。已同步更新到共享 system 提示词（`_build/common.py`），并回溯修正了 1-12 号场景中一条违规输出。


## 进度
尚未开始生成，逐场景推进后在上方对应勾选框打钩。

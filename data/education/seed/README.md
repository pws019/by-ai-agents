# 合成开发数据（T-07）

`seed-data.json` 是**明确标记为合成**的开发/演示数据，不对应任何真实学员或课程：

- 所有 id 固定为 `00000000-0000-0000-0000-0000000000xx` 形式，一眼可辨认。
- 所有姓名、课程名、班期名都带有「（合成数据）」后缀。
- `orders.source = 'seed'`（区别于未来手工登记的 `'manual'`）。

## 数据集内容

- 2 位教师、3 位学员（登录名见下）。
- 1 门课程 2 个版本（`AI 全栈工程师训练营`：v1 历史大纲 / v2 新增实战模块）+ 1 门已归档历史课程（`Java 后端训练营`，仅 1 个版本）。
- 3 个班期挂在当前课程下：历史班（ended，v1）、当前班（running，v2，当期在售）、预告班（upcoming，v2，无课次，作为未来转入目标）；另有 1 个挂在历史课程下的历史班期。
- 报名/订单覆盖：全款无退款、部分退款（`refunded_cents < paid_cents`，验证 CHECK 边界）。
- 学习进度覆盖 completed / in_progress / not_started 三种状态。

## 如何写入开发库

```bash
cd education-api
npm run migrate   # 先确保表结构是最新的
npm run seed
```

`seed` 用固定 id + `ON CONFLICT (id) DO UPDATE` 写入，**重复执行是安全的**：不会产生重复行，也不会清空库里其它手工数据。时间字段（开课时间等）用相对「现在」的天数偏移计算，历史班/当前班/预告班的时间关系永远成立，不会随日期推移过期。

## 登录

所有合成账号共用同一个开发密码：`edu-dev-pass-001`（明文只出现在这里和 `seed-data.json`，生产环境不会有这种共享密码）。

| 登录名 | 角色 |
|---|---|
| teacher.alice / teacher.bruce | teacher |
| student.chen / student.li / student.wang | student |

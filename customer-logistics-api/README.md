# customer-logistics-api

用 [Hono](https://hono.dev/) 写的 mock 订单/物流查询接口，给 `customer-agents` 里的
`logisticsLookupTool` 调用，契约定义见该工具源码里的注释
（`../customer-agents/src/mastra/tools/logistics-lookup.ts`）。

## 运行

```bash
cd customer-logistics-api
npm install
npm run dev   # 或 npm start，默认监听 8200
```

## 接口

```bash
# 健康检查
curl http://127.0.0.1:8200/health

# 订单基础信息
curl http://127.0.0.1:8200/orders/OD202607170099

# 物流信息（agent 的 logisticsLookupTool 实际调用的接口）
curl http://127.0.0.1:8200/orders/OD202607170099/logistics
```

## mock 数据

`src/data/orders.ts` 里预置了几个覆盖不同状态的订单，方便联调测试：

| 订单号 | 场景 |
|---|---|
| `OD202607170099` | 运输中（in_transit） |
| `OD202607170345` | 已签收（delivered） |
| `OD202607171201` | 待发货，还没有物流记录（pending） |
| `OD202607170520` | 物流异常，长时间无更新（exception） |
| `OD202607170890` | 订单存在但没有物流记录（用来测试"订单存在、查不到物流"这种边界情况，返回 404） |
| 其他任意订单号 | 订单不存在，返回 404 |

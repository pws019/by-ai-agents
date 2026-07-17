import { Hono } from "hono";

import { logistics, orders } from "../data/orders";

export const ordersRoute = new Hono();

// GET /orders/:orderId -> 基础订单信息
ordersRoute.get("/:orderId", (c) => {
  const orderId = c.req.param("orderId");
  const order = orders[orderId];

  if (!order) {
    return c.json({ error: `订单号 ${orderId} 不存在` }, 404);
  }

  return c.json(order);
});

// GET /orders/:orderId/logistics -> 物流信息，契约见 customer-agents 的
// src/mastra/tools/logistics-lookup.ts 里的注释
ordersRoute.get("/:orderId/logistics", (c) => {
  const orderId = c.req.param("orderId");

  if (!orders[orderId]) {
    return c.json({ error: `订单号 ${orderId} 不存在` }, 404);
  }

  const record = logistics[orderId];
  if (!record) {
    return c.json({ error: `订单号 ${orderId} 暂无物流信息` }, 404);
  }

  return c.json(record);
});

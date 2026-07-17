import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { ordersRoute } from "./routes/orders";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.route("/orders", ordersRoute);

const port = Number(process.env.PORT ?? 8200);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`customer-logistics-api listening on http://127.0.0.1:${info.port}`);
});

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { DATABASE_URL } from "./db/config.js";
import { createPool } from "./db/pool.js";

const pool = createPool(DATABASE_URL);
const app = createApp(pool);
const port = Number(process.env.PORT ?? 8400);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`education-api listening on http://127.0.0.1:${info.port}`);
});

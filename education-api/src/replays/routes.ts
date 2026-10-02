import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import type { Db } from "../db/pool.js";
import { errorJson } from "../http/errors.js";
import { fetchReplayAccess } from "./access.js";

export function createReplayRoutes(db: Db): Hono {
  const app = new Hono();

  app.get("/replays/:segmentId/access", requireAuth, async (c) => {
    const actor = c.get("actor")!;
    const access = await fetchReplayAccess(db, actor.id, c.req.param("segmentId")!);
    if (!access) return errorJson(c, 404, "NOT_FOUND", "未找到可播放的回放");
    return c.json(access);
  });

  return app;
}

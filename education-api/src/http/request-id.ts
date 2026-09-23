// 每个请求一个 requestId：ErrorResponse 契约要求携带它，日志/排错也靠它串起一次请求。
import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

export async function withRequestId(c: Context, next: Next) {
  c.set("requestId", randomUUID());
  await next();
}

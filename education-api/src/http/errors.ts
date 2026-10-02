// 统一按契约的 ErrorResponse 形状拼错误体，路由和中间件都用它，不各写各的 JSON 结构。
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "INVALID_STATE"
  | "REVISION_CONFLICT"
  | "STALE_CONFIRMATION"
  | "IDEMPOTENCY_KEY_REUSED"
  | "RUN_IN_PROGRESS"
  | "HANDOFF_ACTIVE"
  | "BUDGET_EXCEEDED"
  | "DEPENDENCY_UNAVAILABLE"
  | "LESSON_BUSY"
  | "INTERNAL";

export function errorJson(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string) {
  return c.json({ error: { code, message, requestId: c.get("requestId") ?? "" } }, status);
}

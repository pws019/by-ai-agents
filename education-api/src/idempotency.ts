// 幂等键的通用实现：同一个 actor 对同一个 operation 用同一个 key 重试，
// 不应该产生第二个副作用。这里只做"声明"和"回填"两件事，具体副作用（业务写入）
// 由调用方在声明成功后自己做——这个模块不知道、也不需要知道业务在写什么。
import type pg from "pg";

const UNIQUE_VIOLATION = "23505";

export type ClaimResult =
  | { kind: "first" }
  | { kind: "replay"; resultId: string | null }
  | { kind: "conflict" }; // 同一个 key 被用在了不同内容的请求上——调用方的 bug 或客户端复用了 key

/**
 * 声明一次操作意图。第一次调用会成功插入一行（unique (actor_id, operation, key) 兜底并发重复声明）；
 * 重试且 requestHash 相同视为同一次请求的重放；requestHash 不同则是 key 被误用，拒绝。
 * 调用方拿到 {kind:"first"} 后才可以真的执行业务写入。
 */
export async function claimIdempotencyKey(
  pool: pg.Pool,
  actorId: string,
  operation: string,
  key: string,
  requestHash: string,
): Promise<ClaimResult> {
  try {
    await pool.query(
      `INSERT INTO idempotency_records (actor_id, operation, key, request_hash) VALUES ($1,$2,$3,$4)`,
      [actorId, operation, key, requestHash],
    );
    return { kind: "first" };
  } catch (err) {
    if ((err as { code?: string })?.code !== UNIQUE_VIOLATION) throw err;
    const { rows } = await pool.query<{ request_hash: string; result_id: string | null }>(
      `SELECT request_hash, result_id FROM idempotency_records WHERE actor_id = $1 AND operation = $2 AND key = $3`,
      [actorId, operation, key],
    );
    const rec = rows[0];
    if (!rec) throw err; // 没有删除路径，理论上不会发生；出现说明假设被打破，宁可让原始错误冒出去
    return rec.request_hash === requestHash ? { kind: "replay", resultId: rec.result_id } : { kind: "conflict" };
  }
}

/** 业务写入完成后回填 result_id，供审计/排查用；调用方通常已经知道结果是什么，不依赖这次回填的返回值。 */
export async function fulfillIdempotencyKey(
  pool: pg.Pool,
  actorId: string,
  operation: string,
  key: string,
  resultId: string,
): Promise<void> {
  await pool.query(
    `UPDATE idempotency_records SET result_id = $1 WHERE actor_id = $2 AND operation = $3 AND key = $4`,
    [resultId, actorId, operation, key],
  );
}

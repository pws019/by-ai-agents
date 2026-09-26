// 会话里"一次运行"的生命周期：开启（含消息去重与单 run 锁）、续租、完成、失败。
// 所有仲裁都交给数据库（唯一索引 + 带条件的 UPDATE），应用层不做"先查后写"。
// 时间一律用数据库的 now()：租约是否过期由同一个时钟判断，不受各个进程时钟偏差影响。
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/pool.js";
import { isUniqueViolation } from "../db/pgError.js";
import { conversations, messages, runs } from "../db/schema.js";

export const RUN_LEASE_SECONDS = 90;

export interface RunView {
  id: string;
  kind: "message" | "resume";
  status: "running" | "completed" | "failed";
  errorCode: string | null;
}

export type StartMessageResult =
  | { kind: "started"; runId: string; userMessageId: string }
  // 同一个 clientMessageId 之前已经提交过：不再新建任何东西，把原来的结果交还给调用方。
  | { kind: "duplicate"; run: RunView; assistantMessage: { id: string; content: string } | null }
  // 这个会话已经有一个运行中的 run（租约未过期）。
  | { kind: "busy"; runId: string | null };

class DuplicateMessage extends Error {}

const leaseExpression = sql`now() + make_interval(secs => ${RUN_LEASE_SECONDS})`;

export async function findOwnedConversation(db: Db, conversationId: string, ownerId: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.ownerId, ownerId)));
  return row ?? null; // 不存在和不是本人的一律 null，调用方统一回 404
}

/**
 * 开启一次"学员发消息"的运行。
 * 1. 先看 clientMessageId 是否已经提交过，是就直接返回原结果。这是快速路径（省掉一次事务），
 *    正确性不依赖它：即使跳过，下面的事务撞上唯一约束后，catch 里同样会回查并识别出重复
 *    ——重复请求拿到原结果，而不是因为"此刻会话里有别的 run 在跑"就被说成忙。
 * 2. 再在一个事务里：把租约已过期的 running run 标记为失败 → 插入新 run（唯一索引仲裁并发）→ 插入用户消息。
 *    任何一步失败整体回滚，不会留下"有 run 没消息"或"有消息没 run"。
 */
export async function startMessageRun(
  db: Db,
  args: { conversationId: string; clientMessageId: string; text: string },
): Promise<StartMessageResult> {
  const existing = await findDuplicate(db, args.conversationId, args.clientMessageId);
  if (existing) return existing;

  try {
    return await db.transaction(async (tx) => {
      const run = await openRun(tx, args.conversationId, "message");
      const [message] = await tx
        .insert(messages)
        .values({
          conversationId: args.conversationId,
          role: "user",
          content: args.text,
          clientMessageId: args.clientMessageId,
          runId: run.id,
        })
        .onConflictDoNothing()
        .returning({ id: messages.id });
      // 第 1 步之后、事务之内，另一个相同 clientMessageId 的请求抢先提交了：整体回滚（含刚建的 run）。
      if (!message) throw new DuplicateMessage();
      return { kind: "started", runId: run.id, userMessageId: message.id } as const;
    });
  } catch (err) {
    if (err instanceof DuplicateMessage || isUniqueViolation(err)) {
      // 并发的重复请求：可能是它抢先建了 run（我们撞上 runs 的唯一索引）或抢先写了消息。
      // 不管撞在哪一处，先看是不是"重复"——是就返回原结果，不是才说"忙"。
      const dup = await findDuplicate(db, args.conversationId, args.clientMessageId);
      if (dup) return dup;
      if (isUniqueViolation(err)) return { kind: "busy", runId: await runningRunId(db, args.conversationId) };
    }
    throw err;
  }
}

/** 开一个 run。调用方必须在事务里；撞上"已有运行中的 run"的唯一索引时抛唯一冲突错误。 */
export async function openRun(tx: Pick<Db, "update" | "insert">, conversationId: string, kind: "message" | "resume") {
  await expireStaleRuns(tx, conversationId);
  const [run] = await tx
    .insert(runs)
    .values({ conversationId, kind, status: "running", leaseUntil: leaseExpression })
    .returning({ id: runs.id });
  return run!;
}

/**
 * 把租约已过期的运行中 run 标记为失败。开新 run 之前要做（否则会话永久"忙"）；读取状态之前也要做
 * （否则客户端会永远看到一个其实早已死掉的"生成中"）。已经不是 running 的 run 不受影响。
 */
export async function expireStaleRuns(tx: Pick<Db, "update">, conversationId: string): Promise<void> {
  await tx
    .update(runs)
    .set({ status: "failed", errorCode: "LEASE_EXPIRED", finishedAt: sql`now()` })
    .where(and(eq(runs.conversationId, conversationId), eq(runs.status, "running"), lt(runs.leaseUntil, sql`now()`)));
}

/** 续租。只有仍在运行中的 run 才能续；返回是否续上（false = 它已经被判失败/已结束，调用方应停止工作）。 */
export async function heartbeat(db: Db, runId: string): Promise<boolean> {
  const rows = await db
    .update(runs)
    .set({ leaseUntil: leaseExpression })
    .where(and(eq(runs.id, runId), eq(runs.status, "running")))
    .returning({ id: runs.id });
  return rows.length === 1;
}

/**
 * 完成一次运行并写入助手消息。返回消息 id；返回 null 表示这个 run 已经不在运行中
 * （租约过期后被别的 run 接管并标记为失败了）——它迟到的结果必须被丢弃，否则会把过期的回答写进新一轮对话。
 * "只有仍在运行中的 run 才能完成"是靠带条件的 UPDATE 保证的，不是先查后写。
 */
export async function completeRun(db: Db, runId: string, text: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .update(runs)
      .set({ status: "completed", finishedAt: sql`now()` })
      .where(and(eq(runs.id, runId), eq(runs.status, "running")))
      .returning({ conversationId: runs.conversationId });
    if (!run) return null;
    const [message] = await tx
      .insert(messages)
      .values({ conversationId: run.conversationId, role: "assistant", content: text, runId })
      .returning({ id: messages.id });
    await tx.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, run.conversationId));
    return message!.id;
  });
}

/** 标记失败（同样只对仍在运行中的 run 生效）。返回是否真的改了。 */
export async function failRun(db: Db, runId: string, errorCode: string): Promise<boolean> {
  const rows = await db
    .update(runs)
    .set({ status: "failed", errorCode, finishedAt: sql`now()` })
    .where(and(eq(runs.id, runId), eq(runs.status, "running")))
    .returning({ id: runs.id });
  return rows.length === 1;
}

export async function latestRun(db: Db, conversationId: string): Promise<RunView | null> {
  await expireStaleRuns(db, conversationId);
  const [row] = await db
    .select({ id: runs.id, kind: runs.kind, status: runs.status, errorCode: runs.errorCode })
    .from(runs)
    .where(eq(runs.conversationId, conversationId))
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(1);
  return row ?? null;
}

async function runningRunId(db: Db, conversationId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.conversationId, conversationId), eq(runs.status, "running")));
  return row?.id ?? null;
}

async function findDuplicate(db: Db, conversationId: string, clientMessageId: string): Promise<StartMessageResult | null> {
  await expireStaleRuns(db, conversationId); // 重试一个早已死掉的 run，应当看到"失败"而不是永远"生成中"
  const [row] = await db
    .select({ id: runs.id, kind: runs.kind, status: runs.status, errorCode: runs.errorCode })
    .from(messages)
    .innerJoin(runs, eq(runs.id, messages.runId))
    .where(and(eq(messages.conversationId, conversationId), eq(messages.clientMessageId, clientMessageId)));
  if (!row) return null;
  const run: RunView = row;
  let assistantMessage: { id: string; content: string } | null = null;
  if (run.status === "completed") {
    const [a] = await db
      .select({ id: messages.id, content: messages.content })
      .from(messages)
      .where(and(eq(messages.runId, run.id), eq(messages.role, "assistant")));
    assistantMessage = a ?? null;
  }
  return { kind: "duplicate", run, assistantMessage };
}

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

export type ConversationMode = "bot" | "queued" | "human" | "closed";

export type StartMessageResult =
  | { kind: "started"; runId: string; userMessageId: string }
  // 同一个 clientMessageId 之前已经提交过：不再新建任何东西，把原来的结果交还给调用方。
  | { kind: "duplicate"; run: RunView; assistantMessage: { id: string; content: string } | null }
  // 这个会话已经有一个运行中的 run（租约未过期）。
  | { kind: "busy"; runId: string | null }
  // 会话正在排队或由老师接管：消息只被记录（老师要看得到），不启动机器人（AC-012）。
  // mode 是"此刻"的会话 mode：重试一条早先记录下来的消息时，会话可能已经回到 bot，
  // 这时依然只返回"已记录"，不会因为机器人回来了就补一次自动回复——那条消息当时是老师在处理的。
  | { kind: "recorded"; mode: ConversationMode; userMessageId: string }
  | { kind: "closed" };

class DuplicateMessage extends Error {}

const leaseExpression = sql`now() + make_interval(secs => ${RUN_LEASE_SECONDS})`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 内部通道带来的 requestId 是否确实是"这个用户自己会话里的一次运行"。是就返回 run id，否则 null。
 * requestId 由 BFF 签名，本来就可信；这里再核对一次归属，是为了让"来源"这个记录永远指向该用户自己的会话
 * （测试或别的调用方用任意字符串做 requestId 时，也只是得不到来源，不会出错）。
 */
export async function findRunOwnedBy(db: Db, runId: string | null, ownerId: string): Promise<string | null> {
  if (!runId || !UUID.test(runId)) return null;
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(conversations, eq(conversations.id, runs.conversationId))
    .where(and(eq(runs.id, runId), eq(conversations.ownerId, ownerId)));
  return row?.id ?? null;
}

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
      // FOR SHARE：与"老师接管 / 结束接管"对 conversations 行的 UPDATE 互斥。读到 bot 的这个事务提交之前，
      // 接管不能把 mode 改成 human——所以"老师接管之后才到达的消息，一定看到 human"，机器人不会抢答。
      // （接管前已经开始的运行不受影响，会照常跑完；这里保证的是"接管之后不会再启动新的运行"。）
      const [conversation] = await tx
        .select({ mode: conversations.mode })
        .from(conversations)
        .where(eq(conversations.id, args.conversationId))
        .for("share");
      if (conversation?.mode === "closed") return { kind: "closed" } as const;
      if (conversation && conversation.mode !== "bot") return recordOnly(tx, args, conversation.mode);

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

export type StartResumeResult =
  | { kind: "started"; runId: string }
  | { kind: "busy"; runId: string | null }
  // 会话正在排队或由老师接管：恢复 Agent 会让机器人开口，此刻不允许（学员在业务 API 上的确认本身不受影响）。
  | { kind: "handoff_active"; mode: ConversationMode };

/** 开启一次"学员已在界面确认，让 Agent 恢复"的运行：没有用户消息，也就没有可去重的 clientMessageId。 */
export async function startResumeRun(db: Db, conversationId: string): Promise<StartResumeResult> {
  try {
    return await db.transaction(async (tx): Promise<StartResumeResult> => {
      const [conversation] = await tx
        .select({ mode: conversations.mode })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for("share");
      if (conversation && conversation.mode !== "bot") return { kind: "handoff_active", mode: conversation.mode };
      const run = await openRun(tx, conversationId, "resume");
      return { kind: "started", runId: run.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { kind: "busy", runId: await runningRunId(db, conversationId) };
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

/** 会话在排队/人工接管中：把学员的消息存下来（无 run），不启动机器人。同一个 clientMessageId 重复提交只存一条。 */
async function recordOnly(
  tx: Pick<Db, "select" | "insert" | "update">,
  args: { conversationId: string; clientMessageId: string; text: string },
  mode: ConversationMode,
): Promise<StartMessageResult> {
  const [inserted] = await tx
    .insert(messages)
    .values({ conversationId: args.conversationId, role: "user", content: args.text, clientMessageId: args.clientMessageId })
    .onConflictDoNothing()
    .returning({ id: messages.id });
  if (inserted) {
    await tx.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, args.conversationId));
    return { kind: "recorded", mode, userMessageId: inserted.id };
  }
  const [existing] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, args.conversationId), eq(messages.clientMessageId, args.clientMessageId)));
  return { kind: "recorded", mode, userMessageId: existing!.id };
}

async function findDuplicate(db: Db, conversationId: string, clientMessageId: string): Promise<StartMessageResult | null> {
  await expireStaleRuns(db, conversationId); // 重试一个早已死掉的 run，应当看到"失败"而不是永远"生成中"
  const [row] = await db
    .select({ messageId: messages.id, runId: runs.id, kind: runs.kind, status: runs.status, errorCode: runs.errorCode })
    .from(messages)
    .leftJoin(runs, eq(runs.id, messages.runId))
    .where(and(eq(messages.conversationId, conversationId), eq(messages.clientMessageId, clientMessageId)));
  if (!row) return null;
  if (row.runId === null) {
    // 这条消息是在排队/人工接管期间只记录、没有启动运行的：重试它不会启动机器人，只是告诉调用方"已记录"。
    const [conversation] = await db.select({ mode: conversations.mode }).from(conversations).where(eq(conversations.id, conversationId));
    return { kind: "recorded", mode: conversation?.mode ?? "bot", userMessageId: row.messageId };
  }
  const run: RunView = { id: row.runId, kind: row.kind!, status: row.status!, errorCode: row.errorCode };
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

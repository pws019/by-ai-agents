// 转人工的数据层：请求接管、老师接管、结束接管、老师发消息。
// 设计与 chat/runs.ts 一致——所有仲裁交给数据库（带条件的 UPDATE + 唯一索引），应用层不做先查后写：
//   - 会话 mode 的每一次变化都写在 WHERE 里（bot→queued 要求当前是 bot，queued→human 要求当前是 queued …），
//     命中 0 行就说明别人抢先了；
//   - handoff 的每一次变化同时带上 status 和 revision 条件；
//   - 会话 mode 与 handoff 状态在同一个事务里一起变，任何一步失败整体回滚，不会出现"会话是 human 但没有接管记录"。
// 失败时才回头读一次，只用来解释"为什么没命中"（不存在 / 状态不对 / 不是你的 / 版本旧了），不参与判断。
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/pool.js";
import { conversations, handoffs, messages } from "../db/schema.js";

export type HandoffRow = typeof handoffs.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 契约里的 Handoff。交接摘要是写给老师看的内部说明：只在老师接口的响应里返回，学员侧不带这个字段
 * （最小暴露：学员没有理由读到"机器人是怎么向老师转述我的"，也不该被它里面的工具错误码等内部信息打扰）。
 */
export function toHandoff(row: HandoffRow, audience: "student" | "teacher") {
  const { summary, ...visible } = {
    id: row.id,
    conversationId: row.conversationId,
    status: row.status,
    teacherId: row.teacherId,
    summary: row.summary,
    reason: row.reason,
    revision: row.revision,
  };
  return audience === "teacher" ? { ...visible, summary } : visible;
}

export type RequestHandoffResult =
  | { kind: "queued"; handoff: HandoffRow } // 新建了一条排队记录
  | { kind: "existing"; handoff: HandoffRow } // 已经有进行中的接管：重复请求返回同一条，不新建
  | { kind: "closed" }; // 会话已关闭，不能再请求接管

/**
 * 学员（或代表学员的 Agent）请求老师接管。会话必须当前是 bot；已经在排队/接管中则幂等地返回原记录。
 * 两个并发请求同时到达：第二个的 UPDATE 会等第一个提交，然后发现 mode 已经不是 bot，走"已有记录"分支。
 */
export async function requestHandoff(
  db: Db,
  args: { conversationId: string; reason?: string | null; summary?: string | null },
): Promise<RequestHandoffResult> {
  return db.transaction(async (tx) => {
    const [flipped] = await tx
      .update(conversations)
      .set({ mode: "queued" })
      .where(and(eq(conversations.id, args.conversationId), eq(conversations.mode, "bot")))
      .returning({ id: conversations.id });
    if (flipped) {
      const [handoff] = await tx
        .insert(handoffs)
        .values({ conversationId: args.conversationId, status: "queued", reason: args.reason ?? null, summary: args.summary ?? null })
        .returning();
      return { kind: "queued", handoff: handoff! } as const;
    }
    const active = await findActiveHandoff(tx, args.conversationId);
    return active ? ({ kind: "existing", handoff: active } as const) : ({ kind: "closed" } as const);
  });
}

export type TransitionResult =
  | { kind: "ok"; handoff: HandoffRow }
  | { kind: "not_found" }
  | { kind: "invalid_state" } // 状态不对：已经被接管 / 已经结束 / 还没被接管
  | { kind: "forbidden" } // 只有接管它的那位老师能结束
  | { kind: "revision_conflict" }; // 状态对，但 revision 已经变了

/** 老师接管一条排队中的记录。两位老师同时接管：只有一个 UPDATE 命中 status = 'queued'，另一个拿到 invalid_state。 */
export async function claimHandoff(db: Db, args: { handoffId: string; teacherId: string; expectedRevision: number }): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(handoffs)
      .set({ status: "claimed", teacherId: args.teacherId, claimedAt: sql`now()`, revision: sql`${handoffs.revision} + 1` })
      .where(and(eq(handoffs.id, args.handoffId), eq(handoffs.status, "queued"), eq(handoffs.revision, args.expectedRevision)))
      .returning();
    if (claimed) {
      await flipConversationMode(tx, claimed.conversationId, "queued", "human");
      return { kind: "ok", handoff: claimed } as const;
    }
    const [current] = await tx.select().from(handoffs).where(eq(handoffs.id, args.handoffId));
    if (!current) return { kind: "not_found" } as const;
    if (current.status !== "queued") return { kind: "invalid_state" } as const;
    return { kind: "revision_conflict" } as const;
  });
}

/** 老师结束接管，会话回到 bot。只有接管它的那位老师能结束（别的老师是 forbidden，不是"状态冲突"）。 */
export async function releaseHandoff(db: Db, args: { handoffId: string; teacherId: string; expectedRevision: number }): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    const [released] = await tx
      .update(handoffs)
      .set({ status: "released", releasedAt: sql`now()`, revision: sql`${handoffs.revision} + 1` })
      .where(
        and(
          eq(handoffs.id, args.handoffId),
          eq(handoffs.status, "claimed"),
          eq(handoffs.teacherId, args.teacherId),
          eq(handoffs.revision, args.expectedRevision),
        ),
      )
      .returning();
    if (released) {
      await flipConversationMode(tx, released.conversationId, "human", "bot");
      return { kind: "ok", handoff: released } as const;
    }
    const [current] = await tx.select().from(handoffs).where(eq(handoffs.id, args.handoffId));
    if (!current) return { kind: "not_found" } as const;
    if (current.status !== "claimed") return { kind: "invalid_state" } as const;
    if (current.teacherId !== args.teacherId) return { kind: "forbidden" } as const;
    return { kind: "revision_conflict" } as const;
  });
}

export type TeacherMessageResult =
  | { kind: "sent"; message: MessageRow }
  | { kind: "duplicate"; message: MessageRow } // 同一个 clientMessageId 之前已经发过：返回原消息，不再写
  | { kind: "not_found" } // 会话不存在
  | { kind: "not_human" } // 会话此刻不在人工接管中（机器人负责，或还在排队）
  | { kind: "forbidden" } // 会话正被另一位老师接管
  | { kind: "id_taken" }; // clientMessageId 已被另一种消息占用

/**
 * 接管中的老师发消息。"这位老师此刻确实是接管人"在同一个事务里用 FOR SHARE 锁住 handoff 行来保证：
 * 与"结束接管"的 UPDATE 互斥，所以不会出现"老师刚结束接管、消息却又写进了 human 会话"。
 */
export async function teacherSendMessage(
  db: Db,
  args: { conversationId: string; teacherId: string; clientMessageId: string; text: string },
): Promise<TeacherMessageResult> {
  return db.transaction(async (tx) => {
    const [conversation] = await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, args.conversationId));
    if (!conversation) return { kind: "not_found" } as const;

    const [claimed] = await tx
      .select()
      .from(handoffs)
      .where(and(eq(handoffs.conversationId, args.conversationId), eq(handoffs.status, "claimed")))
      .for("share");
    if (!claimed) return { kind: "not_human" } as const;
    if (claimed.teacherId !== args.teacherId) return { kind: "forbidden" } as const;

    const [inserted] = await tx
      .insert(messages)
      .values({ conversationId: args.conversationId, role: "teacher", content: args.text, clientMessageId: args.clientMessageId })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      await tx.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, args.conversationId));
      return { kind: "sent", message: inserted } as const;
    }
    const [existing] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, args.conversationId), eq(messages.clientMessageId, args.clientMessageId)));
    return existing?.role === "teacher" ? ({ kind: "duplicate", message: existing } as const) : ({ kind: "id_taken" } as const);
  });
}

/** 会话当前进行中（排队或已接管）的那条 handoff；没有则 null。 */
export async function findActiveHandoff(db: Pick<Db, "select">, conversationId: string): Promise<HandoffRow | null> {
  const [row] = await db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), inArray(handoffs.status, ["queued", "claimed"])));
  return row ?? null;
}

async function flipConversationMode(tx: Tx, conversationId: string, from: "queued" | "human", to: "human" | "bot") {
  const [flipped] = await tx
    .update(conversations)
    .set({ mode: to })
    .where(and(eq(conversations.id, conversationId), eq(conversations.mode, from)))
    .returning({ id: conversations.id });
  // handoff 的状态和会话的 mode 由同一个事务一起变，正常不会走到这里；万一不一致，抛出让整个事务回滚，
  // 而不是留下"handoff 已接管、会话还是 queued"的半成品。
  if (!flipped) throw new Error(`会话 ${conversationId} 的 mode 不是 ${from}，与 handoff 状态不一致`);
}

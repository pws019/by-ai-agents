// Session：登录成功后签发一个随机 token，浏览器只拿到 token，库里只存 token 的 hash。
// 哈希算法选 sha256 而不是 password.ts 里的 scrypt：token 本身已经是 32 字节随机数，
// 猜不出来，不需要"故意变慢"去拖延暴力破解；scrypt 的意义在于密码本身熵不够。
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, gt } from "drizzle-orm";
import type { Db } from "../db/pool.js";
import { sessions, users } from "../db/schema.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天，dev 够用；生产要不要更短另议

export interface SessionUser {
  id: string;
  loginName: string;
  displayName: string;
  role: "student" | "teacher";
}

const sha256Hex = (input: string) => createHash("sha256").update(input).digest("hex");

export async function createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ userId, tokenHash: sha256Hex(token), expiresAt });
  return { token, expiresAt };
}

/**
 * token 有效（未过期、未撤销）就返回对应用户，否则 null。
 * 调用方不需要、也不应该知道"为什么"无效——过期、被撤销、伪造在这里被统一成同一个结果，
 * 避免通过错误信息的差异探测会话状态。
 */
export async function resolveSession(db: Db, token: string): Promise<SessionUser | null> {
  const [row] = await db
    .select({ id: users.id, loginName: users.loginName, displayName: users.displayName, role: users.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
  return row ?? null;
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt)));
}

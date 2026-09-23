// Session：登录成功后签发一个随机 token，浏览器只拿到 token，库里只存 token 的 hash。
// 哈希算法选 sha256 而不是 password.ts 里的 scrypt：token 本身已经是 32 字节随机数，
// 猜不出来，不需要"故意变慢"去拖延暴力破解；scrypt 的意义在于密码本身熵不够。
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天，dev 够用；生产要不要更短另议

export interface SessionUser {
  id: string;
  loginName: string;
  displayName: string;
  role: "student" | "teacher";
}

const sha256Hex = (input: string) => createHash("sha256").update(input).digest("hex");

export async function createSession(pool: pg.Pool, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [
    userId,
    sha256Hex(token),
    expiresAt,
  ]);
  return { token, expiresAt };
}

/**
 * token 有效（未过期、未撤销）就返回对应用户，否则 null。
 * 调用方不需要、也不应该知道"为什么"无效——过期、被撤销、伪造在这里被统一成同一个结果，
 * 避免通过错误信息的差异探测会话状态。
 */
export async function resolveSession(pool: pg.Pool, token: string): Promise<SessionUser | null> {
  const { rows } = await pool.query<SessionUser>(
    `SELECT u.id, u.login_name AS "loginName", u.display_name AS "displayName", u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256Hex(token)],
  );
  return rows[0] ?? null;
}

export async function revokeSession(pool: pg.Pool, token: string): Promise<void> {
  await pool.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [
    sha256Hex(token),
  ]);
}

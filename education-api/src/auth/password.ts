// 密码哈希：scrypt（Node 内置，免依赖）。dev-only 数据用固定强度参数即可，
// 生产前需重新评估 cost 参数（N/r/p）与是否迁移到 argon2。
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LEN = 64;
const SCHEME = "scrypt";

/** 生成 "scheme:saltHex:hashHex" 格式的存储串；每次调用用不同的随机盐。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LEN);
  return `${SCHEME}:${salt.toString("hex")}:${derived.toString("hex")}`;
}

/** 用时间恒定比较校验密码，避免通过响应耗时侧信道泄露哈希是否部分匹配。 */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(":");
  if (scheme !== SCHEME || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

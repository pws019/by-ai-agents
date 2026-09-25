// 内部身份上下文：BFF（education-api）签发、education-agent 校验并原样转发回业务 API。
// 目的是让 Agent 服务"代表某个学员"调用业务 API，同时保证身份只能来自 BFF 已经校验过的
// session，而不是来自浏览器提交的字段，更不是来自模型输出。
//
// 格式：`<payloadB64>.<sigB64>`。签名直接算在 payloadB64 这个字符串上，不是算在解码后的 JSON 上——
// 两种语言的 JSON 序列化（键顺序、空白）不一定一致，对"传输用的字符串"签名就没有规范化问题。
// 密钥是对称的（HMAC），意味着持有密钥的一方（含 Agent）理论上也能签发；开发环境接受这一点，
// 生产要换成非对称签名或按服务分开的密钥（记录在 progress.md 已知局限）。
import { createHmac, timingSafeEqual } from "node:crypto";

export interface InternalContext {
  actorId: string;
  role: "student" | "teacher";
  requestId: string;
}

const sign = (payloadB64: string, secret: string) => createHmac("sha256", secret).update(payloadB64).digest("base64url");

export function signInternalContext(ctx: InternalContext, secret: string, opts?: { ttlSeconds?: number; nowMs?: number }): string {
  const nowSec = Math.floor((opts?.nowMs ?? Date.now()) / 1000);
  const payload = { actorId: ctx.actorId, role: ctx.role, requestId: ctx.requestId, exp: nowSec + (opts?.ttlSeconds ?? 60) };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

/**
 * 校验通过返回上下文，否则 null。过期、被篡改、签名对不上、格式错、角色非法被统一成同一个结果，
 * 调用方不需要也不应该知道具体是哪一种（跟 resolveSession 同样的理由）。
 */
export function verifyInternalContext(token: string, secret: string, nowMs: number = Date.now()): InternalContext | null {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts as [string, string];

  const expected = Buffer.from(sign(payloadB64, secret));
  const actual = Buffer.from(sigB64);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const p = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (typeof p.actorId !== "string" || typeof p.requestId !== "string") return null;
    if (p.role !== "student" && p.role !== "teacher") return null;
    if (!Number.isInteger(p.exp) || p.exp * 1000 <= nowMs) return null;
    return { actorId: p.actorId, role: p.role, requestId: p.requestId };
  } catch {
    return null;
  }
}

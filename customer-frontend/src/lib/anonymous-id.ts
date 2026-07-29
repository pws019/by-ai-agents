import {
  ANONYMOUS_ID_COOKIE_MAX_AGE_DAYS,
  ANONYMOUS_ID_COOKIE_NAME,
} from "./constants";

// resourceId 的来源：不用 IP（共享 IP/NAT 场景会把不同用户合并成一个身份，且 IP 会中途变化），
// 改用浏览器生成的匿名 UUID，存进第一方 Cookie（不用 localStorage：Cookie 能设过期时间，
// 以后接真登录系统时后端也能读到，方便做"匿名会话过户给真实账号"这类操作）。
// 详见 customer-frontend/PRD.md「用户与身份」一节。

function readCookie(name: string): string | null {
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : null;
}

function writeCookie(name: string, value: string, maxAgeDays: number) {
  const maxAgeSeconds = maxAgeDays * 24 * 60 * 60;
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAgeSeconds}; path=/; SameSite=Lax`;
}

let cachedResourceId: string | null = null;

// 不透明字符串，不要在业务逻辑里把它当成"匿名用户"的特殊标记来分支处理——
// 以后换成真实登录用户 id 时，这个函数的调用方完全不用变。
export function getOrCreateResourceId(): string {
  if (cachedResourceId) return cachedResourceId;

  const existing = readCookie(ANONYMOUS_ID_COOKIE_NAME);
  if (existing) {
    cachedResourceId = existing;
    return existing;
  }

  const generated = crypto.randomUUID();
  writeCookie(ANONYMOUS_ID_COOKIE_NAME, generated, ANONYMOUS_ID_COOKIE_MAX_AGE_DAYS);
  cachedResourceId = generated;
  return generated;
}

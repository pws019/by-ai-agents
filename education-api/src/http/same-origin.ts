// CSRF 防护：cookie 是浏览器自动带上的，光有 HttpOnly session cookie 挡不住"跨站页面
// 诱导用户浏览器发一个写请求"（cookie 照样会被自动附带）。真正管用的是校验请求从哪个
// 站点发起——跨站请求的 Origin 不会是我们自己的域。只查写方法：GET/HEAD 不改状态，不用防。
import type { Context, Next } from "hono";
import { errorJson } from "./errors.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function requireSameOrigin(allowedOrigin: string) {
  return async (c: Context, next: Next) => {
    // Agent 通道靠签名头认证，不靠浏览器自动附带的 cookie，不存在 CSRF 问题；它是服务端到服务端的调用，
    // 本来也不会带 Origin。这里只跳过"已经被内部签名认证过"的请求，未认证的仍然走下面的检查。
    if (c.get("via") === "agent") return next();
    if (WRITE_METHODS.has(c.req.method)) {
      const origin = c.req.header("Origin");
      // 同源导航型请求浏览器不一定带 Origin（部分场景退化为 Referer），故 Origin 缺失时退而看 Referer 前缀；
      // 两者都不匹配才拒绝，避免把正常的同源表单/fetch 请求也一并挡掉。
      const referer = c.req.header("Referer");
      const ok = origin === allowedOrigin || (!origin && referer?.startsWith(allowedOrigin));
      if (!ok) return errorJson(c, 403, "FORBIDDEN", "跨站请求被拒绝");
    }
    await next();
  };
}

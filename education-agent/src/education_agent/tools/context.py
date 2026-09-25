"""可信 actor 上下文：由 BFF（education-api）签发，这里只负责校验，不负责相信任何别的来源。

格式与签名规则必须和 education-api/src/auth/internalContext.ts 完全一致：
`<payloadB64>.<sigB64>`，签名 = HMAC-SHA256(secret, payloadB64 这个字符串) 的 base64url。
tests/test_context.py 里有一条由独立脚本算出的测试向量，两边实现都必须对它得出同样结论。

上下文只存在于"一次调用"里：不放进 LangGraph state、不写进 checkpoint、不进提示词。
- checkpoint 会落库，签名 token 落库等于把凭证存进数据库；
- 它有效期只有几十秒，恢复（resume）时应由 BFF 重新签发，而不是复用旧的。
"""
import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class RunContext:
    actor_id: str
    role: str  # "student" | "teacher"
    request_id: str
    expires_at: int  # unix 秒
    token: str  # 原始签名串，原样转发给业务 API；不要打印、不要写日志

    def is_expired(self, now: float | None = None) -> bool:
        return (now if now is not None else time.time()) >= self.expires_at

    def __repr__(self) -> str:  # 防止 token 被 repr/日志/异常信息带出去
        return f"RunContext(actor_id={self.actor_id!r}, role={self.role!r}, request_id={self.request_id!r})"


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_context(token: str, secret: str, now: float | None = None) -> RunContext | None:
    """校验通过返回 RunContext，否则 None。过期/篡改/格式错/角色非法统一成 None，不区分原因。"""
    if not secret:
        return None
    parts = token.split(".")
    if len(parts) != 2:
        return None
    payload_b64, sig_b64 = parts
    expected = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    if not hmac.compare_digest(expected, sig_b64):
        return None
    try:
        p = json.loads(_b64url_decode(payload_b64))
        if not isinstance(p["actorId"], str) or not isinstance(p["requestId"], str):
            return None
        if p["role"] not in ("student", "teacher"):
            return None
        exp = p["exp"]
        if not isinstance(exp, int) or isinstance(exp, bool):
            return None
    except (ValueError, KeyError, TypeError):
        return None
    ctx = RunContext(p["actorId"], p["role"], p["requestId"], exp, token)
    return None if ctx.is_expired(now) else ctx

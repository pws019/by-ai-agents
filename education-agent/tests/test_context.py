"""RunContext 校验。测试向量与 education-api/src/auth/internalContext.test.ts 里的同一条，
由独立脚本（不是任一边的实现）算出，保证 TS 签发、Python 校验两个实现互相对得上。"""
import base64
import hashlib
import hmac
import json

from education_agent.tools.context import verify_context

SECRET = "test-secret"
VECTOR = (
    "eyJhY3RvcklkIjoiMDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMGIyIiwicm9sZSI6InN0dWRlbnQiLCJyZXF1ZXN0SWQiOiJyZXEtMSIsImV4cCI6NDEwMjQ0NDgwMH0"
    ".wwit5rN-2aE7RN9SdZ_wA8q103JPQcqTkuwBzN8sGjE"
)


def sign(payload: dict, secret: str = SECRET) -> str:
    b = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), b.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    return f"{b}.{sig}"


def payload(**over) -> dict:
    return {"actorId": "a1", "role": "student", "requestId": "r1", "exp": 2_000_000_000, **over}


def test_ts_issued_vector_verifies():
    ctx = verify_context(VECTOR, SECRET, now=1_000_000_000)
    assert ctx is not None
    assert (ctx.actor_id, ctx.role, ctx.request_id) == ("00000000-0000-0000-0000-0000000000b2", "student", "req-1")
    assert ctx.token == VECTOR


def test_wrong_or_empty_secret_rejected():
    assert verify_context(VECTOR, "other", now=1_000_000_000) is None
    assert verify_context(sign(payload(), ""), "", now=1_000_000_000) is None


def test_expired_rejected():
    tok = sign(payload(exp=100))
    assert verify_context(tok, SECRET, now=99) is not None
    assert verify_context(tok, SECRET, now=100) is None


def test_tampered_payload_rejected():
    b, sig = sign(payload()).split(".")
    forged = base64.urlsafe_b64encode(json.dumps(payload(actorId="someone-else")).encode()).rstrip(b"=").decode()
    assert verify_context(f"{forged}.{sig}", SECRET, now=1) is None


def test_malformed_and_bad_role_rejected():
    assert verify_context("garbage", SECRET) is None
    assert verify_context("a.b.c", SECRET) is None
    assert verify_context(sign(payload(role="admin")), SECRET, now=1) is None
    assert verify_context(sign(payload(exp="x")), SECRET, now=1) is None


def test_repr_never_contains_token():
    ctx = verify_context(VECTOR, SECRET, now=1_000_000_000)
    assert VECTOR not in repr(ctx)
    assert VECTOR.split(".")[1] not in repr(ctx)

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { signInternalContext, verifyInternalContext } from "./internalContext.js";

const SECRET = "test-secret";
const ctx = { actorId: "00000000-0000-0000-0000-0000000000b2", role: "student" as const, requestId: "req-1" };

describe("internal context 签名/校验", () => {
  test("签发后能校验通过，内容原样取回", () => {
    const token = signInternalContext(ctx, SECRET);
    assert.deepEqual(verifyInternalContext(token, SECRET), ctx);
  });

  test("跨语言测试向量：education-agent（Python）的实现必须对这同一个 token 得出同样结论", () => {
    // 由独立的 Python 脚本用 HMAC-SHA256 算出来，不是用本文件的 sign 函数生成的。
    const token =
      "eyJhY3RvcklkIjoiMDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMGIyIiwicm9sZSI6InN0dWRlbnQiLCJyZXF1ZXN0SWQiOiJyZXEtMSIsImV4cCI6NDEwMjQ0NDgwMH0" +
      ".wwit5rN-2aE7RN9SdZ_wA8q103JPQcqTkuwBzN8sGjE";
    assert.deepEqual(verifyInternalContext(token, SECRET), ctx);
  });

  test("密钥不对：null", () => {
    assert.equal(verifyInternalContext(signInternalContext(ctx, SECRET), "other-secret"), null);
  });

  test("密钥为空（未配置）：一律 null，不会因为空密钥被伪造", () => {
    assert.equal(verifyInternalContext(signInternalContext(ctx, ""), ""), null);
  });

  test("过期：null", () => {
    const token = signInternalContext(ctx, SECRET, { ttlSeconds: 60, nowMs: 1_000_000 });
    assert.notEqual(verifyInternalContext(token, SECRET, 1_000_000 + 59_000), null);
    assert.equal(verifyInternalContext(token, SECRET, 1_000_000 + 60_000), null);
  });

  test("篡改 payload（把 actorId 换成别人）：签名对不上，null", () => {
    const [payloadB64, sig] = signInternalContext(ctx, SECRET).split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    payload.actorId = "00000000-0000-0000-0000-0000000000b3";
    const forged = Buffer.from(JSON.stringify(payload)).toString("base64url");
    assert.equal(verifyInternalContext(`${forged}.${sig}`, SECRET), null);
  });

  test("格式错、角色非法：null", () => {
    assert.equal(verifyInternalContext("garbage", SECRET), null);
    assert.equal(verifyInternalContext("a.b.c", SECRET), null);
    const bad = signInternalContext({ ...ctx, role: "admin" as never }, SECRET);
    assert.equal(verifyInternalContext(bad, SECRET), null);
  });
});

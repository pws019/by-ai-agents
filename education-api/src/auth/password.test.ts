import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "./password.js";

test("正确密码验证通过，错误密码不通过", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("correct horse battery staple", stored), true);
  assert.equal(verifyPassword("wrong password", stored), false);
});

test("同一明文每次哈希结果不同（随机盐），但都能验证通过", () => {
  const a = hashPassword("same-password");
  const b = hashPassword("same-password");
  assert.notEqual(a, b);
  assert.equal(verifyPassword("same-password", a), true);
  assert.equal(verifyPassword("same-password", b), true);
});

test("格式不对的存储串直接判失败，不抛异常", () => {
  assert.equal(verifyPassword("x", "not-a-valid-hash"), false);
  assert.equal(verifyPassword("x", ""), false);
});

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hashPassword } from "../auth/password.js";
import { createApp } from "../app.js";
import { DATABASE_URL } from "../db/config.js";
import { migrate } from "../db/migrate.js";
import { createPool } from "../db/pool.js";

const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));
const dbName = `edu_test_${randomBytes(4).toString("hex")}`;
const withDb = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
};
const testUrl = withDb(dbName);
const ORIGIN = "http://localhost:5173";

let admin: pg.Client;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;

const DEV_PASSWORD = "test-pass-001";
let studentId: string;

before(async () => {
  admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl, migrationsDir);

  pool = createPool(testUrl);
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('student.test', $1, '测试学员', 'student') RETURNING id",
    [hashPassword(DEV_PASSWORD)],
  );
  studentId = rows[0]!.id;
  app = createApp(pool, { allowedOrigin: ORIGIN });
});

after(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });

const get = (path: string, headers: Record<string, string> = {}) => app.request(`/api/v1${path}`, { headers });

/** Set-Cookie 里把 cookie 值取出来，方便下一个请求原样带回去（测试环境没有真实浏览器帮你存 cookie）。 */
function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "应该有 Set-Cookie");
  return setCookie!.split(";")[0]!;
}

describe("登录/会话/身份", () => {
  test("登录名或密码错误统一返回 401，不泄露哪个用户名存在", async () => {
    const wrongPassword = await post("/auth/login", { loginName: "student.test", password: "nope" });
    assert.equal(wrongPassword.status, 401);
    const unknownUser = await post("/auth/login", { loginName: "nobody", password: "nope" });
    assert.equal(unknownUser.status, 401);
    const [a, b] = [await wrongPassword.json(), await unknownUser.json()];
    assert.equal(a.error.code, b.error.code);
    assert.equal(a.error.message, b.error.message); // requestId 各请求不同，不比较它
  });

  test("缺字段返回 422", async () => {
    const res = await post("/auth/login", { loginName: "student.test" });
    assert.equal(res.status, 422);
  });

  test("正确密码登录成功、拿到 cookie，用它访问 /me 能取回身份", async () => {
    const login = await post("/auth/login", { loginName: "student.test", password: DEV_PASSWORD });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { id: studentId, loginName: "student.test", role: "student" });

    const cookie = extractCookie(login);
    const me = await get("/me", { Cookie: cookie });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { id: studentId, loginName: "student.test", role: "student" });
  });

  test("没有 cookie 访问 /me 是 401；登出后旧 cookie 也变成 401", async () => {
    assert.equal((await get("/me")).status, 401);

    const login = await post("/auth/login", { loginName: "student.test", password: DEV_PASSWORD });
    const cookie = extractCookie(login);
    assert.equal((await get("/me", { Cookie: cookie })).status, 200);

    const logout = await post("/auth/logout", {}, { Cookie: cookie });
    assert.equal(logout.status, 204);
    assert.equal((await get("/me", { Cookie: cookie })).status, 401, "已撤销的 session 不该还能用");
  });

  test("跨站写请求（Origin 不匹配）被拒绝，读请求不受影响", async () => {
    const res = await post("/auth/login", { loginName: "student.test", password: DEV_PASSWORD }, { Origin: "https://evil.example" });
    assert.equal(res.status, 403);
    assert.equal((await get("/me")).status, 401, "GET 不受 CSRF 检查影响，401 而不是 403");
  });
});

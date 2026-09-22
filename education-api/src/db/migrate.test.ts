import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DATABASE_URL } from "./config.js";
import { APP_SCHEMA, migrate } from "./migrate.js";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

// 每次测试建一个全新的临时库：既验证"全新库可迁移"，也不污染开发库。
const dbName = `edu_test_${randomBytes(4).toString("hex")}`;
const withDb = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
};
const testUrl = withDb(dbName);

let admin: pg.Client;
let db: pg.Client;

const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  db.query<T>(sql, params);
const id = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;

/**
 * 断言这条 SQL 被数据库拒绝，并且是预期的错误类别（不只是"报错了"）。
 * 连接是自动提交模式，每条语句独立成事务，失败不会影响后面的语句。
 */
async function rejects(sql: string, params: unknown[], code: string) {
  await assert.rejects(
    () => q(sql, params),
    (e: { code?: string }) => e.code === code,
    `期望错误码 ${code}`,
  );
}
const CHECK = "23514";
const UNIQUE = "23505";
const FK = "23503";
const RESTRICT = "23001";

before(async () => {
  admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
});
after(async () => {
  await db?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe("迁移机制", () => {
  test("全新库执行全部迁移；再次执行没有任何变化", async () => {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    assert.deepEqual(await migrate(testUrl, migrationsDir), files);
    assert.deepEqual(await migrate(testUrl, migrationsDir), []);

    db = new pg.Client({ connectionString: testUrl, options: `-c search_path=${APP_SCHEMA}` });
    await db.connect();
    const n = await q<{ n: string }>("SELECT count(*) AS n FROM schema_migrations");
    assert.equal(Number(n.rows[0]!.n), files.length);
  });

  test("已执行的迁移内容被改动时拒绝继续", async () => {
    const original = (await q<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE name = '0001_identity.sql'")).rows[0]!.checksum;
    await q("UPDATE schema_migrations SET checksum = 'tampered' WHERE name = '0001_identity.sql'");
    await assert.rejects(migrate(testUrl, migrationsDir), /内容被修改/);
    await q("UPDATE schema_migrations SET checksum = $1 WHERE name = '0001_identity.sql'", [original]);
    assert.deepEqual(await migrate(testUrl, migrationsDir), []);
  });
});

describe("业务约束", () => {
  // 一组最小的合法数据，各用例在其上制造违规
  const f: Record<string, string> = {};

  before(async () => {
    f.student = await id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('s1','x','学员1','student') RETURNING id");
    f.teacher = await id("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('t1','x','老师1','teacher') RETURNING id");
    f.course = await id("INSERT INTO courses (title) VALUES ('AI 全栈（合成）') RETURNING id");
    f.version = await id("INSERT INTO course_versions (course_id, version) VALUES ($1, 1) RETURNING id", [f.course]);
    f.policy = await id("INSERT INTO policies (version, text) VALUES (1, '合成政策') RETURNING id");
    f.cohort = await id("INSERT INTO cohorts (course_id, course_version_id, name, currency, status, is_current_sale) VALUES ($1,$2,'第 1 期','CNY','running', true) RETURNING id", [f.course, f.version]);
    f.order = await id("INSERT INTO orders (student_id, cohort_id, policy_id, paid_cents, source) VALUES ($1,$2,$3,100000,'seed') RETURNING id", [f.student, f.cohort, f.policy]);
    f.enrollment = await id("INSERT INTO enrollments (student_id, order_id, cohort_id, status) VALUES ($1,$2,$3,'active') RETURNING id", [f.student, f.order, f.cohort]);
  });

  test("用户名不区分大小写唯一", () =>
    rejects("INSERT INTO users (login_name, password_hash, display_name, role) VALUES ('S1','x','重名','student')", [], UNIQUE));

  test("金额：不能为负；已退不能超过已付", async () => {
    await rejects("UPDATE orders SET paid_cents = -1 WHERE id = $1", [f.order], CHECK);
    await rejects("UPDATE orders SET refunded_cents = 100001 WHERE id = $1", [f.order], CHECK);
  });

  test("每门课程最多一个当期在售班期", () =>
    rejects("INSERT INTO cohorts (course_id, course_version_id, name, currency, status, is_current_sale) VALUES ($1,$2,'第 2 期','CNY','upcoming', true)", [f.course, f.version], UNIQUE));

  test("班期的课程必须与其课程版本所属课程一致", async () => {
    const other = await id("INSERT INTO courses (title) VALUES ('另一门课') RETURNING id");
    await rejects("INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'错配','CNY','upcoming')", [other, f.version], FK);
  });

  test("有订单引用的政策不能删除", () => rejects("DELETE FROM policies WHERE id = $1", [f.policy], FK));

  test("同一报名同类型只允许一张未结束申请；已结束的不占名额", async () => {
    const insert = (status: string) =>
      id("INSERT INTO applications (student_id, enrollment_id, type, reason, status) VALUES ($1,$2,'transfer','时间冲突',$3) RETURNING id", [f.student, f.enrollment, status]);
    f.app = await insert("submitted");
    await rejects("INSERT INTO applications (student_id, enrollment_id, type, reason, status) VALUES ($1,$2,'transfer','重复','draft')", [f.student, f.enrollment], UNIQUE);
    await q("UPDATE applications SET status = 'withdrawn' WHERE id = $1", [f.app]); // 撤回后可再申请
    f.app = await insert("draft");
  });

  test("执行状态只能出现在已批准的申请上", async () => {
    await rejects("UPDATE applications SET execution_status = 'pending' WHERE id = $1", [f.app], CHECK);
  });

  test("确认版本不能超过当前版本", () =>
    rejects("UPDATE applications SET confirmed_revision = 2 WHERE id = $1", [f.app], CHECK));

  test("审计事件只能追加，不能改也不能删", async () => {
    const ev = await id("INSERT INTO application_events (application_id, actor_id, event_type, revision) VALUES ($1,$2,'created',1) RETURNING id", [f.app, f.student]);
    await rejects("UPDATE application_events SET event_type = 'x' WHERE id = $1", [ev], RESTRICT);
    await rejects("DELETE FROM application_events WHERE id = $1", [ev], RESTRICT);
  });

  test("每张申请同一时间只有一张有效确认卡；作废后可签发新卡", async () => {
    const card = () =>
      id("INSERT INTO confirmations (user_id, application_id, payload_hash, revision, expires_at) VALUES ($1,$2,'h',1, now() + interval '10 minutes') RETURNING id", [f.student, f.app]);
    const first = await card();
    await rejects("INSERT INTO confirmations (user_id, application_id, payload_hash, revision, expires_at) VALUES ($1,$2,'h2',1, now() + interval '10 minutes')", [f.student, f.app], UNIQUE);
    await q("UPDATE confirmations SET revoked_at = now() WHERE id = $1", [first]);
    await card();
  });

  test("幂等键：同一 (操作人, 操作, key) 只能出现一次", async () => {
    await q("INSERT INTO idempotency_records (actor_id, operation, key, request_hash) VALUES ($1,'application.create','k1','h')", [f.student]);
    await rejects("INSERT INTO idempotency_records (actor_id, operation, key, request_hash) VALUES ($1,'application.create','k1','h')", [f.student], UNIQUE);
  });

  test("一张申请最多一条转班记录；转出转入班期不能相同", async () => {
    const target = await id("INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'第 3 期','CNY','upcoming') RETURNING id", [f.course, f.version]);
    await rejects("INSERT INTO enrollment_changes (enrollment_id, from_cohort_id, to_cohort_id, application_id, teacher_id) VALUES ($1,$2,$2,$3,$4)", [f.enrollment, f.cohort, f.app, f.teacher], CHECK);
    const change = "INSERT INTO enrollment_changes (enrollment_id, from_cohort_id, to_cohort_id, application_id, teacher_id) VALUES ($1,$2,$3,$4,$5)";
    await q(change, [f.enrollment, f.cohort, target, f.app, f.teacher]);
    await rejects(change, [f.enrollment, f.cohort, target, f.app, f.teacher], UNIQUE);
  });

  test("回放权益必须能追溯来源", () =>
    rejects("INSERT INTO replay_entitlements (student_id, cohort_id) VALUES ($1,$2)", [f.student, f.cohort], CHECK));

  test("更新记录时 updated_at 自动刷新", async () => {
    const before = (await q<{ t: Date }>("SELECT updated_at AS t FROM courses WHERE id = $1", [f.course])).rows[0]!.t;
    await new Promise((r) => setTimeout(r, 20));
    await q("UPDATE courses SET title = '改名' WHERE id = $1", [f.course]);
    const after = (await q<{ t: Date }>("SELECT updated_at AS t FROM courses WHERE id = $1", [f.course])).rows[0]!.t;
    assert.ok(after > before);
  });
});

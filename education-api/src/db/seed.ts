// 合成开发数据：从 data/education/seed/seed-data.json 幂等写入 dev 库。
// 幂等靠固定 id + ON CONFLICT (id) DO UPDATE，不是 TRUNCATE 重来：
// 重复执行不会产生重复行，也不会把手工在库里加的其它数据清空。
import { readFile } from "node:fs/promises";
import pg from "pg";
import { hashPassword } from "../auth/password.js";
import { APP_SCHEMA } from "./migrate.js";

const SEED_DATA_PATH = new URL("../../../data/education/seed/seed-data.json", import.meta.url);

interface SeedData {
  note: string;
  devPassword: string;
  users: { id: string; loginName: string; displayName: string; role: "student" | "teacher" }[];
  policies: { id: string; version: number; text: string; publishedDaysOffset: number }[];
  courses: { id: string; title: string; archived: boolean }[];
  courseVersions: { id: string; courseId: string; version: number; outline: unknown; publishedDaysOffset: number }[];
  cohorts: {
    id: string; courseId: string; courseVersionId: string; name: string;
    startDaysOffset: number; priceCents: number | null; currency: string;
    isCurrentSale: boolean; status: string;
  }[];
  lessons: { id: string; cohortId: string; title: string; position: number; replayAssetKey: string | null }[];
  orders: { id: string; studentId: string; cohortId: string; policyId: string; paidCents: number; refundedCents: number }[];
  enrollments: { id: string; studentId: string; orderId: string; cohortId: string; status: string }[];
  learningProgress: { id: string; studentId: string; lessonId: string; status: string }[];
}

/** daysOffset 相对"现在"计算绝对时间戳，避免历史/当前/未来班期的时间关系随日期漂移过期。 */
const atDaysOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

export async function seed(connectionString: string): Promise<void> {
  const data: SeedData = JSON.parse(await readFile(SEED_DATA_PATH, "utf8"));
  const passwordHash = hashPassword(data.devPassword);

  const client = new pg.Client({ connectionString, options: `-c search_path=${APP_SCHEMA}` });
  await client.connect();
  try {
    await client.query("BEGIN");

    for (const u of data.users) {
      await client.query(
        `INSERT INTO users (id, login_name, password_hash, display_name, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           login_name = EXCLUDED.login_name, password_hash = EXCLUDED.password_hash,
           display_name = EXCLUDED.display_name, role = EXCLUDED.role`,
        [u.id, u.loginName, passwordHash, u.displayName, u.role],
      );
    }

    for (const p of data.policies) {
      await client.query(
        `INSERT INTO policies (id, version, text, published_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, published_at = EXCLUDED.published_at`,
        [p.id, p.version, p.text, atDaysOffset(p.publishedDaysOffset)],
      );
    }

    for (const c of data.courses) {
      await client.query(
        `INSERT INTO courses (id, title, archived) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, archived = EXCLUDED.archived`,
        [c.id, c.title, c.archived],
      );
    }

    for (const v of data.courseVersions) {
      await client.query(
        `INSERT INTO course_versions (id, course_id, version, outline, published_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET outline = EXCLUDED.outline, published_at = EXCLUDED.published_at`,
        [v.id, v.courseId, v.version, JSON.stringify(v.outline), atDaysOffset(v.publishedDaysOffset)],
      );
    }

    for (const c of data.cohorts) {
      await client.query(
        `INSERT INTO cohorts (id, course_id, course_version_id, name, start_at, price_cents, currency, is_current_sale, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, start_at = EXCLUDED.start_at, price_cents = EXCLUDED.price_cents,
           currency = EXCLUDED.currency, is_current_sale = EXCLUDED.is_current_sale, status = EXCLUDED.status`,
        [c.id, c.courseId, c.courseVersionId, c.name, atDaysOffset(c.startDaysOffset), c.priceCents, c.currency, c.isCurrentSale, c.status],
      );
    }

    for (const l of data.lessons) {
      await client.query(
        `INSERT INTO lessons (id, cohort_id, title, position, replay_asset_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title, position = EXCLUDED.position, replay_asset_key = EXCLUDED.replay_asset_key`,
        [l.id, l.cohortId, l.title, l.position, l.replayAssetKey],
      );
    }

    for (const o of data.orders) {
      await client.query(
        `INSERT INTO orders (id, student_id, cohort_id, policy_id, paid_cents, refunded_cents, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'seed')
         ON CONFLICT (id) DO UPDATE SET
           paid_cents = EXCLUDED.paid_cents, refunded_cents = EXCLUDED.refunded_cents`,
        [o.id, o.studentId, o.cohortId, o.policyId, o.paidCents, o.refundedCents],
      );
    }

    for (const e of data.enrollments) {
      await client.query(
        `INSERT INTO enrollments (id, student_id, order_id, cohort_id, status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
        [e.id, e.studentId, e.orderId, e.cohortId, e.status],
      );
    }

    for (const p of data.learningProgress) {
      await client.query(
        `INSERT INTO learning_progress (id, student_id, lesson_id, status, source)
         VALUES ($1, $2, $3, $4, 'import')
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
        [p.id, p.studentId, p.lessonId, p.status],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DATABASE_URL } = await import("./config.js");
  const data: Pick<SeedData, "devPassword" | "users"> = JSON.parse(await readFile(SEED_DATA_PATH, "utf8"));
  await seed(DATABASE_URL);
  console.log(`已写入合成 seed 数据。dev 密码（所有账号通用）: ${data.devPassword}`);
  console.log(`登录名: ${data.users.map((u) => u.loginName).join(", ")}`);
}

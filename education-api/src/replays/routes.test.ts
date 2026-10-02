// GET /replays/:segmentId/access —— T-28 受控回放入口。
// 覆盖契约（contracts/education/openapi.yaml getReplayAccess）里 404 归一的四种来源：
// 片段没有时间轴、文档不是当前激活版本、课次没有回放素材、学员没有权益；
// 以及权益的两个独立来源：当前报名 active、转班保留的 replay_entitlements。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "../app.js";
import { createSession } from "../auth/session.js";
import { DATABASE_URL } from "../db/config.js";
import { migrate } from "../db/migrate.js";
import { createDb, createPool } from "../db/pool.js";
import { dropTestDatabase } from "../testing/db.js";

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
let db: ReturnType<typeof createDb>;
let app: ReturnType<typeof createApp>;

const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
const id = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;

let policyVersionCounter = 0;

async function insertCohortWithLesson(replayAssetKey: string | null) {
  const courseId = await id("INSERT INTO courses (title) VALUES ('合成课程') RETURNING id");
  const versionId = await id("INSERT INTO course_versions (course_id, version) VALUES ($1,1) RETURNING id", [courseId]);
  const cohortId = await id(
    "INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'合成班期','CNY','running') RETURNING id",
    [courseId, versionId],
  );
  const lessonId = await id("INSERT INTO lessons (cohort_id, title, position, replay_asset_key) VALUES ($1,'第 1 课',1,$2) RETURNING id", [
    cohortId,
    replayAssetKey,
  ]);
  return { cohortId, lessonId };
}

async function enrollStudent(cohortId: string, loginName: string, status: "active" | "transferred" = "active") {
  const studentId = await id(
    "INSERT INTO users (login_name, password_hash, display_name, role) VALUES ($1,'x','测试学员','student') RETURNING id",
    [loginName],
  );
  const policyId = await id("INSERT INTO policies (version, text) VALUES ($1,'合成政策') RETURNING id", [++policyVersionCounter]);
  const orderId = await id(
    "INSERT INTO orders (student_id, cohort_id, policy_id, paid_cents, source) VALUES ($1,$2,$3,100000,'seed') RETURNING id",
    [studentId, cohortId, policyId],
  );
  await id("INSERT INTO enrollments (student_id, order_id, cohort_id, status) VALUES ($1,$2,$3,$4) RETURNING id", [
    studentId,
    orderId,
    cohortId,
    status,
  ]);
  return { studentId, orderId };
}

async function insertActiveDocumentWithTimedSegment(lessonId: string, startMs: number, endMs: number) {
  const documentId = await id(
    "INSERT INTO knowledge_documents (lesson_id, kind, source_name, source_hash, version, activated_at) VALUES ($1,'vtt','x.vtt','hash-1',1,now()) RETURNING id",
    [lessonId],
  );
  const segmentId = await id(
    "INSERT INTO knowledge_segments (document_id, position, content, content_hash, start_ms, end_ms) VALUES ($1,0,'内容','c-hash',$2,$3) RETURNING id",
    [documentId, startMs, endMs],
  );
  return { documentId, segmentId };
}

async function loginCookie(userId: string): Promise<string> {
  const { token } = await createSession(db, userId);
  return `edu_session=${token}`;
}

before(async () => {
  admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl, migrationsDir);
  pool = createPool(testUrl);
  db = createDb(pool);
  app = createApp(pool, { allowedOrigin: ORIGIN });
});

after(async () => {
  await pool.end();
  await dropTestDatabase(admin, dbName);
  await admin.end();
});

const get = (path: string, cookie?: string) => app.request(`/api/v1${path}`, { headers: cookie ? { Cookie: cookie } : {} });

describe("GET /replays/:segmentId/access", () => {
  test("没登录：401", async () => {
    const res = await get("/replays/00000000-0000-0000-0000-000000000fff/access");
    assert.equal(res.status, 401);
  });

  test("本期学员、片段有时间轴、课次有回放素材：200，返回契约定义的形状", async () => {
    const { cohortId, lessonId } = await insertCohortWithLesson("replay/x.mp4");
    const { studentId } = await enrollStudent(cohortId, "student.ok");
    const { segmentId } = await insertActiveDocumentWithTimedSegment(lessonId, 12_000, 18_500);

    const res = await get(`/replays/${segmentId}/access`, await loginCookie(studentId));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { segmentId, playbackUrl: "/media/synthetic-demo-replay.mp4", startSeconds: 12, endSeconds: 18.5, synthetic: true });
  });

  test("不存在的 segmentId：404", async () => {
    const { cohortId } = await insertCohortWithLesson("replay/x.mp4");
    const { studentId } = await enrollStudent(cohortId, "student.fake-segment");
    const res = await get("/replays/00000000-0000-0000-0000-000000000fff/access", await loginCookie(studentId));
    assert.equal(res.status, 404);
  });

  test("讲义片段没有时间轴（start_ms/end_ms 为 NULL）：404，不编一个时间点出来", async () => {
    const { cohortId, lessonId } = await insertCohortWithLesson("replay/x.mp4");
    const { studentId } = await enrollStudent(cohortId, "student.markdown");
    const documentId = await id(
      "INSERT INTO knowledge_documents (lesson_id, kind, source_name, source_hash, version, activated_at) VALUES ($1,'markdown','x.md','hash-2',1,now()) RETURNING id",
      [lessonId],
    );
    const segmentId = await id(
      "INSERT INTO knowledge_segments (document_id, position, content, content_hash) VALUES ($1,0,'内容','c-hash-2') RETURNING id",
      [documentId],
    );
    const res = await get(`/replays/${segmentId}/access`, await loginCookie(studentId));
    assert.equal(res.status, 404);
  });

  test("文档还没发布（activated_at 为 NULL）：404，不能靠未激活版本的片段播放", async () => {
    const { cohortId, lessonId } = await insertCohortWithLesson("replay/x.mp4");
    const { studentId } = await enrollStudent(cohortId, "student.unpublished");
    const documentId = await id(
      "INSERT INTO knowledge_documents (lesson_id, kind, source_name, source_hash, version) VALUES ($1,'vtt','x.vtt','hash-3',1) RETURNING id",
      [lessonId],
    );
    const segmentId = await id(
      "INSERT INTO knowledge_segments (document_id, position, content, content_hash, start_ms, end_ms) VALUES ($1,0,'内容','c-hash-3',0,1000) RETURNING id",
      [documentId],
    );
    const res = await get(`/replays/${segmentId}/access`, await loginCookie(studentId));
    assert.equal(res.status, 404);
  });

  test("课次没有录回放（replay_asset_key 为 NULL）：404", async () => {
    const { cohortId, lessonId } = await insertCohortWithLesson(null);
    const { studentId } = await enrollStudent(cohortId, "student.no-replay");
    const { segmentId } = await insertActiveDocumentWithTimedSegment(lessonId, 0, 1000);
    const res = await get(`/replays/${segmentId}/access`, await loginCookie(studentId));
    assert.equal(res.status, 404);
  });

  test("没有报名也没有回放权益：404——不能靠知道一个片段 id 就看到任意班期的回放", async () => {
    const { lessonId } = await insertCohortWithLesson("replay/x.mp4");
    const { segmentId } = await insertActiveDocumentWithTimedSegment(lessonId, 0, 1000);
    const outsiderCohort = await insertCohortWithLesson(null);
    const { studentId: outsiderId } = await enrollStudent(outsiderCohort.cohortId, "student.outsider");

    const res = await get(`/replays/${segmentId}/access`, await loginCookie(outsiderId));
    assert.equal(res.status, 404);
  });

  test("转班且老师选择保留旧回放权益（replay_entitlements，revoked_at 为 NULL）：200", async () => {
    const { cohortId, lessonId } = await insertCohortWithLesson("replay/old.mp4");
    const { segmentId } = await insertActiveDocumentWithTimedSegment(lessonId, 0, 1000);
    // 已转班，enrollments.status 不再是 active；回放权益改记在 replay_entitlements，来源是转班前那笔订单。
    const { studentId, orderId } = await enrollStudent(cohortId, "student.kept", "transferred");
    await q("INSERT INTO replay_entitlements (student_id, cohort_id, source_order_id) VALUES ($1,$2,$3)", [studentId, cohortId, orderId]);

    const res = await get(`/replays/${segmentId}/access`, await loginCookie(studentId));
    assert.equal(res.status, 200);
  });

  test("回放权益已被撤销（revoked_at 非 NULL）：404", async () => {
    const { cohortId, lessonId } = await insertCohortWithLesson("replay/revoked.mp4");
    const { segmentId } = await insertActiveDocumentWithTimedSegment(lessonId, 0, 1000);
    const { studentId, orderId } = await enrollStudent(cohortId, "student.revoked", "transferred");
    await q("INSERT INTO replay_entitlements (student_id, cohort_id, source_order_id, revoked_at) VALUES ($1,$2,$3,now())", [
      studentId,
      cohortId,
      orderId,
    ]);

    const res = await get(`/replays/${segmentId}/access`, await loginCookie(studentId));
    assert.equal(res.status, 404);
  });
});

// T-25：导入字幕/讲义，落到 knowledge_documents/knowledge_segments。真实临时库——
// 这里保护的是"版本号怎么递增""失败重跑不重复""重复上传同一份文件被识别"这些数据库层面的行为。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import pg from "pg";
import { DATABASE_URL } from "../db/config.js";
import { migrate } from "../db/migrate.js";
import { createDb, createPool, type Db } from "../db/pool.js";
import { knowledgeDocuments, knowledgeSegments } from "../db/schema.js";
import { dropTestDatabase } from "../testing/db.js";
import { importKnowledgeDocument } from "./import.js";

const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));
const dbName = `edu_test_${randomBytes(4).toString("hex")}`;
const withDb = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
};
const testUrl = withDb(dbName);

let admin: pg.Client;
let pool: pg.Pool;
let db: Db;
let lessonId: string;

const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
const id = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;

before(async () => {
  admin = new pg.Client({ connectionString: withDb("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(testUrl, migrationsDir);
  pool = createPool(testUrl);
  db = createDb(pool);

  const courseId = await id("INSERT INTO courses (title) VALUES ('课程') RETURNING id");
  const versionId = await id("INSERT INTO course_versions (course_id, version) VALUES ($1,1) RETURNING id", [courseId]);
  const cohortId = await id("INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'班期1','CNY','running') RETURNING id", [courseId, versionId]);
  lessonId = await id("INSERT INTO lessons (cohort_id, title, position) VALUES ($1,'第一课',1) RETURNING id", [cohortId]);
});

after(async () => {
  await pool.end();
  await dropTestDatabase(admin, dbName);
  await admin.end();
});

// 两条 cue 间隔 5 秒（超过 chunk.ts 的 2000ms 阈值），确保它们落成两个独立的 segment，
// 不会被合并算法接在一起——这样才能测"多条 segment 按 position 顺序落库"。
const SRT = `1
00:00:01,000 --> 00:00:03,000
第一句话

2
00:00:08,000 --> 00:00:10,000
第二句话`;

describe("导入字幕/讲义", () => {
  test("首次导入：version 从 1 开始，segment 按 position 顺序落库", async () => {
    const result = await importKnowledgeDocument(db, { lessonId, kind: "srt", sourceName: "l1.srt", rawContent: SRT });
    assert.deepEqual(result, { kind: "imported", documentId: result.kind === "imported" ? result.documentId : "", version: 1, segmentCount: 2 });

    const rows = await db.select().from(knowledgeSegments).where(eq(knowledgeSegments.documentId, (result as { documentId: string }).documentId));
    assert.deepEqual(rows.map((r) => [r.position, r.content, r.startMs, r.endMs]).sort((a, b) => (a[0] as number) - (b[0] as number)), [
      [0, "第一句话", 1000, 3000],
      [1, "第二句话", 8000, 10000],
    ]);
  });

  test("不传 visibility：按 schema 默认值落为 private；传了就按传的值（T-29 教师维护页面用）", async () => {
    // 独立的 lesson：这个文件里其它测试按顺序共用 lessonId 并依赖 version 递增序列，混进去会打乱它们的断言。
    const courseId = await id("INSERT INTO courses (title) VALUES ('可见性测试课程') RETURNING id");
    const versionId = await id("INSERT INTO course_versions (course_id, version) VALUES ($1,1) RETURNING id", [courseId]);
    const cohortId = await id("INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'班期V','CNY','running') RETURNING id", [courseId, versionId]);
    const visibilityLesson = await id("INSERT INTO lessons (cohort_id, title, position) VALUES ($1,'可见性课',1) RETURNING id", [cohortId]);

    const defaulted = await importKnowledgeDocument(db, { lessonId: visibilityLesson, kind: "srt", sourceName: "l1.srt", rawContent: SRT });
    const [defaultedRow] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, (defaulted as { documentId: string }).documentId));
    assert.equal(defaultedRow!.visibility, "private");

    const changed = SRT.replace("第二句话", "第二句话（公开版）");
    const publicDoc = await importKnowledgeDocument(db, { lessonId: visibilityLesson, kind: "srt", sourceName: "l1.srt", rawContent: changed, visibility: "public" });
    const [publicRow] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, (publicDoc as { documentId: string }).documentId));
    assert.equal(publicRow!.visibility, "public");
  });

  test("内容变了：version 递增到 2，旧版本的 segment 还在（T-26 再决定要不要撤回）", async () => {
    const first = await importKnowledgeDocument(db, { lessonId, kind: "srt", sourceName: "l1.srt", rawContent: SRT });
    const changed = SRT.replace("第二句话", "第二句话（改过）");
    const second = await importKnowledgeDocument(db, { lessonId, kind: "srt", sourceName: "l1.srt", rawContent: changed });
    assert.equal(second.kind, "imported");
    assert.equal((second as { version: number }).version, 2);
    assert.notEqual((second as { documentId: string }).documentId, (first as { documentId: string }).documentId);

    const oldRows = await db.select().from(knowledgeSegments).where(eq(knowledgeSegments.documentId, (first as { documentId: string }).documentId));
    assert.equal(oldRows.length, 2, "旧版本没有被这次导入动过");
  });

  test("同一份文件重复上传（内容完全一样）：不产生新 version，直接返回已有的那一版", async () => {
    const first = await importKnowledgeDocument(db, { lessonId, kind: "srt", sourceName: "l1.srt", rawContent: SRT });
    const again = await importKnowledgeDocument(db, { lessonId, kind: "srt", sourceName: "l1-重新导出.srt", rawContent: SRT });
    assert.deepEqual(again, { kind: "unchanged", documentId: (first as { documentId: string }).documentId, version: (first as { version: number }).version });
  });

  test("讲义（markdown）：没有时间信息，segment 的 startMs/endMs 是 null", async () => {
    const result = await importKnowledgeDocument(db, { lessonId, kind: "markdown", sourceName: "handbook.md", rawContent: "## 一节\n\n内容" });
    assert.equal(result.kind, "imported");
    const rows = await db.select().from(knowledgeSegments).where(eq(knowledgeSegments.documentId, (result as { documentId: string }).documentId));
    assert.ok(rows.every((r) => r.startMs === null && r.endMs === null));
  });

  test("VTT 带 NOTE 头部：来源/标题/录制时间落进 knowledge_documents；SRT/讲义没有这类头部，三列是 null", async () => {
    const vtt = `WEBVTT

NOTE 来源：https://www.qianwen.com/record#share?share_id=abc123
NOTE 标题：真实分享会标题
NOTE chat_shared_at=2026-07-26T17:11:00+08:00

1
00:00:01.000 --> 00:00:03.000
第一句话`;
    const result = await importKnowledgeDocument(db, { lessonId, kind: "vtt", sourceName: "share.vtt", rawContent: vtt });
    assert.equal(result.kind, "imported");
    const [doc] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, (result as { documentId: string }).documentId));
    assert.equal(doc!.sourceUrl, "https://www.qianwen.com/record#share?share_id=abc123");
    assert.equal(doc!.sourceTitle, "真实分享会标题");
    assert.equal(doc!.recordedAt?.toISOString(), new Date("2026-07-26T17:11:00+08:00").toISOString());

    const srtResult = await importKnowledgeDocument(db, { lessonId, kind: "srt", sourceName: "l1.srt", rawContent: SRT });
    const [srtDoc] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, (srtResult as { documentId: string }).documentId));
    assert.deepEqual([srtDoc!.sourceUrl, srtDoc!.sourceTitle, srtDoc!.recordedAt], [null, null, null]);
  });

  test("不同 lesson 各自独立计数版本号", async () => {
    const courseId = await id("INSERT INTO courses (title) VALUES ('另一门课') RETURNING id");
    const versionId = await id("INSERT INTO course_versions (course_id, version) VALUES ($1,1) RETURNING id", [courseId]);
    const cohortId = await id("INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'班期A','CNY','running') RETURNING id", [courseId, versionId]);
    const otherLesson = await id("INSERT INTO lessons (cohort_id, title, position) VALUES ($1,'另一课',1) RETURNING id", [cohortId]);

    const result = await importKnowledgeDocument(db, { lessonId: otherLesson, kind: "srt", sourceName: "l1.srt", rawContent: SRT });
    assert.equal((result as { version: number }).version, 1, "跟本文件里其它测试已经导入过的 lesson 互不影响");
  });

  test("导入到不存在的 lesson：外键约束直接拒绝，不留任何痕迹", async () => {
    const badLessonId = "00000000-0000-0000-0000-00000000dead";
    await assert.rejects(() => importKnowledgeDocument(db, { lessonId: badLessonId, kind: "srt", sourceName: "l1.srt", rawContent: SRT }));
  });

  test("失败重跑不产生重复数据：导入中途失败（document 这一步没插进去），重跑后拿到干净的 version 1，不是 2", async () => {
    const courseId = await id("INSERT INTO courses (title) VALUES ('重试课') RETURNING id");
    const versionId = await id("INSERT INTO course_versions (course_id, version) VALUES ($1,1) RETURNING id", [courseId]);
    const cohortId = await id("INSERT INTO cohorts (course_id, course_version_id, name, currency, status) VALUES ($1,$2,'班期B','CNY','running') RETURNING id", [courseId, versionId]);
    const retryLesson = await id("INSERT INTO lessons (cohort_id, title, position) VALUES ($1,'重试课次',1) RETURNING id", [cohortId]);

    // 用一个不合法的 kind（绕过 TS 类型检查）触发 knowledge_documents 的 CHECK 约束失败，模拟
    // "导入过程中途失败"：这时"查当前最新 version"已经跑过，但 INSERT 没成功，整个事务必须回滚，
    // 不能留下"已经占用了 version 1 但没有内容"的半成品。
    await assert.rejects(() => importKnowledgeDocument(db, { lessonId: retryLesson, kind: "bogus" as never, sourceName: "l1.srt", rawContent: SRT }));

    const result = await importKnowledgeDocument(db, { lessonId: retryLesson, kind: "srt", sourceName: "l1.srt", rawContent: SRT });
    assert.equal((result as { version: number }).version, 1, "失败的那次没有真的占用/留下任何 version");
  });
});

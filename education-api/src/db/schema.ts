// Drizzle 的表定义——只用来给查询构建器提供类型和列名映射，不是迁移的来源。
// 真正的表结构、约束、索引、触发器都在 src/db/migrations/*.sql 里手写并执行；
// 这里的字段类型必须跟那边保持一致，但增删表/字段永远从改 .sql 开始，不是改这个文件。
import { bigint, boolean, integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const app = pgSchema("app");

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const users = app.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  loginName: text("login_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().$type<"student" | "teacher">(),
  ...timestamps,
});

export const sessions = app.table("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const courses = app.table("courses", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  archived: boolean("archived").notNull().default(false),
  ...timestamps,
});

export const courseVersions = app.table("course_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  courseId: uuid("course_id").notNull(),
  version: integer("version").notNull(),
  outline: jsonb("outline").notNull().default({}),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ...timestamps,
});

export const policies = app.table("policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: integer("version").notNull(),
  text: text("text").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ...timestamps,
});

export const cohorts = app.table("cohorts", {
  id: uuid("id").primaryKey().defaultRandom(),
  courseId: uuid("course_id").notNull(),
  courseVersionId: uuid("course_version_id").notNull(),
  name: text("name").notNull(),
  startAt: timestamp("start_at", { withTimezone: true }),
  // bigint 用 mode:'number'：DB 里是 bigint 防止金额溢出，但 JS number 精度（2^53）远超实际金额范围，
  // 让 drizzle 直接转成 number，不用再在每个路由里手动 Number() 转换（T-09 踩过的坑）。
  priceCents: bigint("price_cents", { mode: "number" }),
  currency: text("currency").notNull(),
  isCurrentSale: boolean("is_current_sale").notNull().default(false),
  status: text("status").notNull().$type<"upcoming" | "running" | "ended">(),
  ...timestamps,
});

export const lessons = app.table("lessons", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortId: uuid("cohort_id").notNull(),
  title: text("title").notNull(),
  position: integer("position").notNull(),
  replayAssetKey: text("replay_asset_key"),
  ...timestamps,
});

export const orders = app.table("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentId: uuid("student_id").notNull(),
  cohortId: uuid("cohort_id").notNull(),
  policyId: uuid("policy_id").notNull(),
  paidCents: bigint("paid_cents", { mode: "number" }).notNull(),
  refundedCents: bigint("refunded_cents", { mode: "number" }).notNull().default(0),
  source: text("source").notNull().$type<"seed" | "manual">(),
  ...timestamps,
});

export const enrollments = app.table("enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentId: uuid("student_id").notNull(),
  orderId: uuid("order_id").notNull(),
  cohortId: uuid("cohort_id").notNull(),
  status: text("status").notNull().$type<"active" | "transferred" | "ended">(),
  revision: integer("revision").notNull().default(1),
  ...timestamps,
});

export const learningProgress = app.table("learning_progress", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentId: uuid("student_id").notNull(),
  lessonId: uuid("lesson_id").notNull(),
  status: text("status").notNull().$type<"not_started" | "in_progress" | "completed">(),
  source: text("source").notNull().$type<"manual" | "import">(),
  ...timestamps,
});

export const applications = app.table("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentId: uuid("student_id").notNull(),
  enrollmentId: uuid("enrollment_id").notNull(),
  type: text("type").notNull().$type<"transfer" | "refund">(),
  reason: text("reason").notNull(),
  targetCohortId: uuid("target_cohort_id"),
  status: text("status")
    .notNull()
    .$type<"draft" | "submitted" | "needs_info" | "awaiting_student_confirmation" | "approved" | "rejected" | "withdrawn">(),
  executionStatus: text("execution_status").notNull().default("not_started").$type<"not_started" | "pending" | "completed" | "failed">(),
  proposal: jsonb("proposal").$type<{ targetCohortId?: string; refundCents?: number } | null>(),
  revision: integer("revision").notNull().default(1),
  confirmedRevision: integer("confirmed_revision"),
  sourceRunId: uuid("source_run_id"),
  ...timestamps,
});

export const applicationEvents = app.table("application_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull(),
  actorId: uuid("actor_id").notNull(),
  eventType: text("event_type").notNull(),
  revision: integer("revision").notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const confirmations = app.table("confirmations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  applicationId: uuid("application_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  revision: integer("revision").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const idempotencyRecords = app.table("idempotency_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").notNull(),
  operation: text("operation").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  resultId: uuid("result_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const enrollmentChanges = app.table("enrollment_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  enrollmentId: uuid("enrollment_id").notNull(),
  fromCohortId: uuid("from_cohort_id").notNull(),
  toCohortId: uuid("to_cohort_id").notNull(),
  applicationId: uuid("application_id").notNull(),
  teacherId: uuid("teacher_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const replayEntitlements = app.table("replay_entitlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentId: uuid("student_id").notNull(),
  cohortId: uuid("cohort_id").notNull(),
  sourceApplicationId: uuid("source_application_id"),
  sourceOrderId: uuid("source_order_id"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = app.table("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull(),
  mode: text("mode").notNull().default("bot").$type<"bot" | "queued" | "human" | "closed">(),
  ...timestamps,
});

export const runs = app.table("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull(),
  kind: text("kind").notNull().$type<"message" | "resume">(),
  status: text("status").notNull().$type<"running" | "completed" | "failed">(),
  errorCode: text("error_code"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const messages = app.table("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull(),
  role: text("role").notNull().$type<"user" | "assistant" | "teacher" | "system">(),
  content: text("content").notNull(),
  clientMessageId: text("client_message_id"),
  runId: uuid("run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

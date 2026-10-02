// 教育服务前端自己的展示层类型，跟 education-api 的 JSON 响应解耦——
// api.ts 里的函数负责把响应"翻译"成这些类型，组件只认这些类型。
// 和 src/types.ts（legacy 聊天 Demo）是两套独立的类型体系，不共用。

export type Role = "student" | "teacher";

export type CurrentUser = {
  id: string;
  loginName: string;
  role: Role;
};

export type CohortSummary = {
  cohortId: string;
  name: string;
  startAt: string | null;
};

export type EnrollmentStatus = "active" | "transferred" | "refunded" | "ended";

export type Enrollment = {
  enrollmentId: string;
  cohort: CohortSummary;
  status: EnrollmentStatus;
  policyVersion: number;
  revision: number;
};

export type ScheduleItem = {
  lessonId: string;
  title: string;
  order: number;
  hasReplay: boolean;
};

// GET /replays/:segmentId/access（T-28）：每次打开回放卡片都要重新请求，不缓存，
// 因为这个接口本身就是"播放前再鉴权"那一关，不是检索时判断过一次就永久当作有权限。
// synthetic 恒为 true——项目里没有真实回放素材，界面必须照实标注，不能让人以为在看真实录像。
export type ReplayAccess = {
  segmentId: string;
  playbackUrl: string;
  startSeconds: number;
  endSeconds: number;
  synthetic: true;
};

export type ProgressStatus = "not_started" | "in_progress" | "completed";

export type ProgressItem = {
  lessonId: string;
  status: ProgressStatus;
  source: "manual" | "import";
};

// 转班/退费申请（T-16）。字段和 contracts/education/openapi.yaml 的 schema 一一对应，
// 不额外发明字段——后端已经把状态机和确认卡机制想清楚了，前端只负责如实展示和调用。
export type ApplicationType = "transfer" | "refund";

export type ApplicationStatus =
  | "draft"
  | "submitted"
  | "needs_info"
  | "awaiting_student_confirmation"
  | "approved"
  | "rejected"
  | "withdrawn";

export type ApplicationExecutionStatus = "not_started" | "pending" | "completed" | "failed";

export type ApplicationSummary = {
  type: ApplicationType;
  enrollmentId: string;
  reason: string;
  targetCohortId: string | null;
  refundCents: number | null;
};

// 确认卡：申请草稿创建、PATCH draft、老师 propose 之后都会签发一张，
// confirmationId 绑定当时的 revision 和内容摘要——过期或内容变过就不能再用（AC-005）。
export type Confirmation = {
  confirmationId: string;
  applicationId: string;
  revision: number;
  expiresAt: string;
  summary: ApplicationSummary;
};

export type ApplicationDraft = {
  id: string;
  revision: number;
  status: ApplicationStatus;
  summary: ApplicationSummary;
  confirmation: Confirmation;
};

export type ApplicationProposal = { targetCohortId?: string; refundCents?: number } | null;

export type Application = {
  id: string;
  type: ApplicationType;
  enrollmentId: string;
  status: ApplicationStatus;
  executionStatus: ApplicationExecutionStatus;
  revision: number;
  summary: ApplicationSummary;
  proposal: ApplicationProposal;
  pendingConfirmation?: Confirmation;
  createdAt: string;
  updatedAt: string;
};

export type ApplicationEvent = {
  eventType: string;
  actorId: string;
  revision: number;
  details: Record<string, unknown>;
  createdAt: string;
};

export type ApplicationDetail = Application & { events: ApplicationEvent[] };

export type ApplicationPage = { items: Application[]; nextCursor: string | null };

// 转人工（T-22/23）。summary 只在老师视角的响应里有（学员侧不带这个字段，见后端 toHandoff）。
export type HandoffStatus = "queued" | "claimed" | "released";

export type Handoff = {
  id: string;
  conversationId: string;
  status: HandoffStatus;
  teacherId: string | null;
  summary: string | null;
  reason: string | null;
  revision: number;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant" | "teacher" | "system";
  content: string;
  runId: string | null;
  createdAt: string;
};

// 资料维护（T-29）。knowledge_segments.content_hash/start_ms 等字段不在这里暴露——老师维护页面
// 只需要知道"这一版发没发布、索引到哪一步了"，不需要逐条片段的内容（那是检索结果要展示的东西）。
export type TeacherLessonLookup = { lessonId: string; title: string; cohortId: string; cohortName: string };

// 资料维护页面的目录结构（班期 > 课次），不是学员自己的那个 CohortSummary（没有课程标题）。
export type TeacherCohortSummary = {
  cohortId: string;
  name: string;
  status: "upcoming" | "running" | "ended";
  startAt: string | null;
  courseId: string;
  courseTitle: string;
};

export type KnowledgeKind = "srt" | "vtt" | "markdown";
export type IndexStatus = "pending" | "running" | "succeeded" | "failed" | null;

export type KnowledgeDocument = {
  documentId: string;
  version: number;
  kind: KnowledgeKind;
  sourceName: string;
  visibility: "public" | "private";
  activatedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  indexStatus: IndexStatus;
  segmentCount: number;
};

export type KnowledgeDocumentImportResult = { documentId: string; version: number; kind: "imported" | "unchanged"; segmentCount?: number };

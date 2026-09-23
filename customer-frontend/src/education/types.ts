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

export type ProgressStatus = "not_started" | "in_progress" | "completed";

export type ProgressItem = {
  lessonId: string;
  status: ProgressStatus;
  source: "manual" | "import";
};

// education-api 的 fetch 封装。走 vite dev server 的 /api 代理（见 vite.config.ts），
// 浏览器眼里请求是同源的，session cookie 才能被自动带上、不用处理跨源 CORS。
import type {
  Application,
  ApplicationDetail,
  ApplicationDraft,
  ApplicationPage,
  ApplicationStatus,
  ApplicationType,
  CohortSummary,
  CurrentUser,
  Enrollment,
  ProgressItem,
  ScheduleItem,
} from "./types";

const BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`${code}: ${status}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include", // 同源代理下这行其实不是必需的，但显式写出来更清楚：这个请求依赖 cookie
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? "UNKNOWN");
  }
  return body as T;
}

export const login = (loginName: string, password: string) =>
  request<CurrentUser>("/auth/login", { method: "POST", body: JSON.stringify({ loginName, password }) });

export const logout = () => request<void>("/auth/logout", { method: "POST" });

export const getMe = () => request<CurrentUser>("/me");

export const listMyEnrollments = () => request<{ items: Enrollment[] }>("/me/enrollments");

export const getMySchedule = (enrollmentId: string) =>
  request<{ items: ScheduleItem[] }>(`/me/enrollments/${enrollmentId}/schedule`);

export const getMyProgress = (enrollmentId: string) =>
  request<{ items: ProgressItem[] }>(`/me/enrollments/${enrollmentId}/progress`);

export const getTransferTargets = (enrollmentId: string) =>
  request<{ items: CohortSummary[] }>(`/cohorts/transfer-targets?enrollmentId=${enrollmentId}`);

// --- 申请（转班/退费），T-16 ---

export const createApplicationDraft = (body: { type: ApplicationType; enrollmentId: string; reason: string; targetCohortId?: string | null }) =>
  request<ApplicationDraft>("/applications/drafts", { method: "POST", body: JSON.stringify(body) });

export const confirmApplication = (applicationId: string, body: { confirmationId: string; expectedRevision: number }) =>
  request<Application>(`/applications/${applicationId}/confirm`, { method: "POST", body: JSON.stringify(body) });

export const supplementApplication = (applicationId: string, body: { text: string; expectedRevision: number }) =>
  request<Application>(`/applications/${applicationId}/supplement`, { method: "POST", body: JSON.stringify(body) });

export const withdrawApplication = (applicationId: string, body: { expectedRevision: number }) =>
  request<Application>(`/applications/${applicationId}/withdraw`, { method: "POST", body: JSON.stringify(body) });

export const respondToProposal = (applicationId: string, body: { accept: boolean; confirmationId: string; expectedRevision: number }) =>
  request<Application>(`/applications/${applicationId}/proposal-response`, { method: "POST", body: JSON.stringify(body) });

export const listMyApplications = () => request<ApplicationPage>("/me/applications");

// --- 转人工（T-22/23），学员本人的操作，不经过 Agent ---

export const requestHandoff = (conversationId: string, reason?: string) =>
  request<unknown>(`/conversations/${conversationId}/handoff`, { method: "POST", body: JSON.stringify(reason ? { reason } : {}) });

export const getApplication = (applicationId: string) => request<ApplicationDetail>(`/applications/${applicationId}`);

// --- 老师审批 ---

export const listTeacherApplications = (params?: { status?: ApplicationStatus; type?: ApplicationType }) => {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.type) qs.set("type", params.type);
  const suffix = qs.toString() ? `?${qs}` : "";
  return request<ApplicationPage>(`/teacher/applications${suffix}`);
};

// 老师没有"自己的报名"这个概念，这里查询任意 enrollmentId 的候选目标班期都不校验归属，
// 权限判断只到"是不是老师角色"为止——跟学员版 getTransferTargets 是两个不同的端点。
export const teacherGetTransferTargets = (enrollmentId: string) =>
  request<{ items: CohortSummary[] }>(`/teacher/cohorts/transfer-targets?enrollmentId=${enrollmentId}`);

export const teacherRequestInfo = (applicationId: string, body: { question: string; expectedRevision: number }) =>
  request<Application>(`/teacher/applications/${applicationId}/request-info`, { method: "POST", body: JSON.stringify(body) });

export const teacherPropose = (
  applicationId: string,
  body: { targetCohortId?: string | null; refundCents?: number; reason: string; expectedRevision: number },
) => request<Application>(`/teacher/applications/${applicationId}/propose`, { method: "POST", body: JSON.stringify(body) });

export const teacherApprove = (applicationId: string, body: { expectedRevision: number; oldReplayAccess?: "keep" | "revoke" }) =>
  request<Application>(`/teacher/applications/${applicationId}/approve`, { method: "POST", body: JSON.stringify(body) });

export const teacherReject = (applicationId: string, body: { reason: string; expectedRevision: number }) =>
  request<Application>(`/teacher/applications/${applicationId}/reject`, { method: "POST", body: JSON.stringify(body) });

export const teacherRecordRefundResult = (
  applicationId: string,
  body: { outcome: "completed" | "failed"; note: string; reference?: string | null; expectedRevision: number },
) => request<Application>(`/teacher/applications/${applicationId}/refund-result`, { method: "POST", body: JSON.stringify(body) });

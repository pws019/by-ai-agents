// education-api 的 fetch 封装。走 vite dev server 的 /api 代理（见 vite.config.ts），
// 浏览器眼里请求是同源的，session cookie 才能被自动带上、不用处理跨源 CORS。
import type { CurrentUser, Enrollment, ProgressItem, ScheduleItem } from "./types";

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

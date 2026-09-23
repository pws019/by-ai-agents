// 申请状态/事件的中文文案，学生页和老师页共用——同一个状态在两边应该长一个样子，
// 不该各自维护一份容易读出歧义的翻译。
import type { ApplicationEvent, ApplicationExecutionStatus, ApplicationStatus, ApplicationType } from "./types";

export const APPLICATION_TYPE_LABEL: Record<ApplicationType, string> = {
  transfer: "转班",
  refund: "退费",
};

export const APPLICATION_STATUS_LABEL: Record<ApplicationStatus, string> = {
  draft: "草稿",
  submitted: "待处理",
  needs_info: "待补充信息",
  awaiting_student_confirmation: "待学员确认方案",
  approved: "已批准",
  rejected: "已拒绝",
  withdrawn: "已撤回",
};

export const EXECUTION_STATUS_LABEL: Record<ApplicationExecutionStatus, string> = {
  not_started: "未执行",
  pending: "待登记结果",
  completed: "已完成",
  failed: "登记失败",
};

const EVENT_LABEL: Record<string, string> = {
  submitted: "提交申请",
  supplement: "补充说明",
  withdrawn: "撤回申请",
  request_info: "老师要求补充信息",
  proposed: "老师提出方案",
  proposal_accepted: "学员接受方案",
  proposal_rejected: "学员拒绝方案",
  approved: "老师批准",
  rejected: "老师拒绝",
  refund_result: "登记退款结果",
};

export function eventLabel(event: ApplicationEvent): string {
  return EVENT_LABEL[event.eventType] ?? event.eventType;
}

// 终态：不能再对这条申请做任何操作。
export function isTerminalStatus(status: ApplicationStatus): boolean {
  return status === "approved" || status === "rejected" || status === "withdrawn";
}

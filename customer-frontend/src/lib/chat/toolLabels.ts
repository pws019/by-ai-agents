// 工具名 → 给用户看的中文。工具名固定（见 education-agent 的工具契约）；
// 契约的 tool.status 不含参数和结果，所以这里只需要"在做什么"的文案。
const LABELS: Record<string, string> = {
  getCurrentOffering: "查询当前招生",
  getMyEnrollment: "查询我的报名",
  getMySchedule: "查询课表",
  getMyProgress: "查询学习进度",
  getTransferTargets: "查询可转入的班期",
  prepareApplication: "起草申请",
  getApplicationStatus: "查询申请进度",
};

export const toolLabel = (tool: string): string => LABELS[tool] ?? "处理中";

/** 还在进行中的最近一个工具，用于"正在……"的提示；没有则 null。 */
export function runningToolLabel(tools: { tool: string; status: string }[]): string | null {
  const running = [...tools].reverse().find((t) => t.status === "started");
  return running ? `正在${toolLabel(running.tool)}…` : null;
}

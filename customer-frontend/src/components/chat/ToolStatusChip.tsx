import { toolLabel } from "../../lib/chat/toolLabels";
import type { ToolStatus } from "../../lib/chat/state";
import { Icon } from "../ui/Icon";

const STATUS = {
  started: { icon: "progress_activity", spin: true, text: "进行中", color: "text-primary" },
  succeeded: { icon: "check_circle", spin: false, text: "已完成", color: "text-secondary" },
  failed: { icon: "error", spin: false, text: "失败", color: "text-error" },
} as const;

// 挂在助手消息上的工具状态小标签：只有"做了什么 + 状态"。契约的 tool.status 有意不含参数和返回值（脱敏），
// 所以这里不再有可展开的详情。
export function ToolStatusChip({ tool }: { tool: ToolStatus }) {
  const s = STATUS[tool.status];
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 border border-outline-variant rounded-full bg-surface-container-lowest w-fit">
      <Icon name={s.icon} className={`text-[16px] ${s.color} ${s.spin ? "animate-spin" : ""}`} />
      <span className="text-label-md text-on-surface">{toolLabel(tool.tool)}</span>
      <span className={`text-label-sm ${s.color}`}>{s.text}</span>
    </div>
  );
}

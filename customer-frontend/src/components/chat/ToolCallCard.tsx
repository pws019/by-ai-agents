import { useState } from "react";

import { DEFAULT_TOOL_DISPLAY_NAME, TOOL_DISPLAY_NAMES } from "../../lib/constants";
import type { ToolCallInfo } from "../../types";
import { Icon } from "../ui/Icon";

function safeStringify(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const STATUS_CONFIG = {
  running: { icon: "progress_activity", spin: true, label: "调用中" },
  done: { icon: "check_circle", spin: false, label: "已完成" },
  error: { icon: "error", spin: false, label: "调用失败" },
} as const;

// 挂在助手消息气泡上的工具调用小卡片：默认收起，只显示"工具名 + 状态"，
// 点开能看到调用参数和返回结果。对话结束后仍然留在消息里（不是转瞬即逝的
// loading 提示），历史消息里重新打开会话也能看到，跟 Mastra Playground 的做法一致。
export function ToolCallCard({ toolCall }: { toolCall: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(false);
  const displayName = TOOL_DISPLAY_NAMES[toolCall.toolName] ?? DEFAULT_TOOL_DISPLAY_NAME;
  const status = STATUS_CONFIG[toolCall.status];
  const statusColor =
    toolCall.status === "error"
      ? "text-error"
      : toolCall.status === "running"
        ? "text-primary"
        : "text-secondary";

  return (
    <div className="border border-outline-variant rounded-lg bg-surface-container-lowest overflow-hidden text-left">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-container-low transition-colors"
      >
        <Icon
          name={status.icon}
          className={`text-[18px] ${statusColor} ${status.spin ? "animate-spin" : ""}`}
        />
        <span className="text-label-md text-on-surface">{displayName}</span>
        <span className={`text-label-sm ${statusColor}`}>{status.label}</span>
        <Icon
          name={expanded ? "expand_less" : "expand_more"}
          className="text-[18px] text-outline ml-auto"
        />
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-outline-variant pt-2">
          {toolCall.args !== undefined && (
            <div>
              <p className="text-label-sm text-outline mb-1">调用参数</p>
              <pre className="text-[11px] text-on-surface-variant bg-surface-container rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-words">
                {safeStringify(toolCall.args)}
              </pre>
            </div>
          )}
          {toolCall.result !== undefined && (
            <div>
              <p className="text-label-sm text-outline mb-1">
                {toolCall.status === "error" ? "错误信息" : "返回结果"}
              </p>
              <pre className="text-[11px] text-on-surface-variant bg-surface-container rounded p-2 overflow-auto max-h-52 whitespace-pre-wrap break-words">
                {safeStringify(toolCall.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

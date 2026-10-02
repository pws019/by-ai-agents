// 从 getReplayAccess 的失败结果里挑一句给学员看的话。
// 独立成纯函数（不摸 DOM）是跟着本仓库的测试惯例走——组件测试基础设施还没有，
// 能拆成纯逻辑的部分就拆出来，照 lib/chat 的做法用 node:test 测，而不是裸着写进 JSX 里不测。
import { ApiError } from "../../education/api";

export function describeReplayError(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return "没有找到可播放的回放，或者你没有这节课的播放权限";
  return "加载回放失败，请稍后重试";
}

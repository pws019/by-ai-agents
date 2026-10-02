import { useState } from "react";
import { getReplayAccess } from "../../education/api";
import type { ReplayAccess } from "../../education/types";
import { Icon } from "../ui/Icon";
import { describeReplayError } from "./replayError";

type ReplayCardProps = {
  segmentId: string;
  title: string;
};

type State = { status: "closed" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; access: ReplayAccess };

// 受控回放入口（T-28）：点开才请求，每次点开都重新请求、不缓存上一次结果——
// "播放访问再鉴权"说的就是这里，不是检索/课表接口判断过一次权限就一直有效。
// 卡片本身不关心 access 来自哪里（课表、聊天引用都行），只认 segmentId，调用方负责提供。
export function ReplayCard({ segmentId, title }: ReplayCardProps) {
  const [state, setState] = useState<State>({ status: "closed" });

  const open = () => {
    setState({ status: "loading" });
    getReplayAccess(segmentId)
      .then((access) => setState({ status: "ready", access }))
      .catch((error) => setState({ status: "error", message: describeReplayError(error) }));
  };

  if (state.status === "closed") {
    return (
      <button type="button" onClick={open} className="text-label-sm text-primary underline">
        看回放
      </button>
    );
  }

  return (
    <div role="region" aria-label={`《${title}》回放`} className="mt-2 w-full rounded-xl border border-outline-variant bg-surface-container-lowest p-3 flex flex-col gap-2">
      {state.status === "loading" && <p className="text-body-sm text-on-surface-variant">加载中…</p>}
      {state.status === "error" && <p className="text-body-sm text-error">{state.message}</p>}
      {state.status === "ready" && (
        <>
          {/* 合成演示资源明确标注：没有真实回放素材，不能让界面看起来像是在播真实课程录像。 */}
          <div className="flex items-center gap-2">
            <Icon name="info" className="text-outline" />
            <span className="text-label-sm text-outline">合成演示素材，非真实课程录像</span>
          </div>
          <video
            controls
            src={state.access.playbackUrl}
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime = state.access.startSeconds;
            }}
            className="w-full rounded-lg bg-black"
          />
        </>
      )}
      <button type="button" onClick={() => setState({ status: "closed" })} className="text-label-sm text-secondary underline self-start">
        收起
      </button>
    </div>
  );
}

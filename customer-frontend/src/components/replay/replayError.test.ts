import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../../education/api";
import { describeReplayError } from "./replayError";

describe("describeReplayError", () => {
  test("404（片段不存在/没有权限/课次没录回放，后端统一归一）：提示权限相关的话", () => {
    assert.equal(describeReplayError(new ApiError(404, "NOT_FOUND")), "没有找到可播放的回放，或者你没有这节课的播放权限");
  });

  test("其它状态码或非 ApiError：通用失败提示，不编造具体原因", () => {
    assert.equal(describeReplayError(new ApiError(500, "INTERNAL")), "加载回放失败，请稍后重试");
    assert.equal(describeReplayError(new TypeError("network down")), "加载回放失败，请稍后重试");
  });
});

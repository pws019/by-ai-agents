// 受控回放入口（T-28）：播放前再鉴权，不信任检索/引用阶段已经做过的任何权限判断——
// searchKnowledge（T-27）只是从向量库里挑出候选、按 cohort 粗筛，这里才是真正决定
// "能不能把播放地址给这个人"的一关，contracts/education/openapi.yaml 的 getReplayAccess 已经
// 定义了形状（segmentId/playbackUrl/startSeconds/endSeconds/synthetic），这里按契约实现。
//
// segmentId 对应 knowledge_segments.id（T-25 导入产生）：
// segment → document（拿 lessonId、是否为当前激活版本）→ lesson（拿 cohortId、是否录了回放）
// → cohort 权益（当前报名 active，或转班时老师选择保留的 replay_entitlements）。
// 四步任何一步不满足都归一返回 null——路由层统一回 404，不区分"片段不存在"和"存在但无权"，
// 跟 me.ts 的 "不存在和不是本人的都归一为 404" 是同一个理由（AC-003）。
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/pool.js";
import { enrollments, knowledgeDocuments, knowledgeSegments, lessons, replayEntitlements } from "../db/schema.js";

// 项目里没有真实回放素材/存储服务，所有回放统一指向这一份合成演示视频；synthetic 标记
// 让前端明确展示"这不是真实课程录像"，不能让人误以为播的是真实录播（tasks.md T-28 验收要求）。
export const SYNTHETIC_PLAYBACK_URL = "/media/synthetic-demo-replay.mp4";

export interface ReplayAccess {
  segmentId: string;
  playbackUrl: string;
  startSeconds: number;
  endSeconds: number;
  synthetic: true;
}

export async function fetchReplayAccess(db: Db, studentId: string, segmentId: string): Promise<ReplayAccess | null> {
  const [segment] = await db
    .select({ id: knowledgeSegments.id, documentId: knowledgeSegments.documentId, startMs: knowledgeSegments.startMs, endMs: knowledgeSegments.endMs })
    .from(knowledgeSegments)
    .where(eq(knowledgeSegments.id, segmentId));
  // 讲义（markdown）没有时间轴，start_ms/end_ms 恒为 NULL：没有可以播放的时间点，不编一个 0~0 出来。
  if (!segment || segment.startMs === null || segment.endMs === null) return null;

  const [document] = await db
    .select({ lessonId: knowledgeDocuments.lessonId, activatedAt: knowledgeDocuments.activatedAt })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.id, segment.documentId));
  // 只信 activatedAt：即使 Qdrant 里的点位还没被异步清理掉，撤回/未发布的版本在这里也立刻拦住（AC-016）。
  if (!document || document.activatedAt === null) return null;

  const [lesson] = await db
    .select({ cohortId: lessons.cohortId, replayAssetKey: lessons.replayAssetKey })
    .from(lessons)
    .where(eq(lessons.id, document.lessonId));
  if (!lesson || lesson.replayAssetKey === null) return null;

  if (!(await isEntitled(db, studentId, lesson.cohortId))) return null;

  return {
    segmentId: segment.id,
    playbackUrl: SYNTHETIC_PLAYBACK_URL,
    startSeconds: segment.startMs / 1000,
    endSeconds: segment.endMs / 1000,
    synthetic: true,
  };
}

// 权益不只看当前报名：转班时老师可以选择保留旧班期回放权益（T-12 的
// POST /teacher/applications/:id/approve body.oldReplayAccess === "keep"），
// 那部分权益记在 replay_entitlements，是独立于 enrollments 的第二个来源，两个都要查。
async function isEntitled(db: Db, studentId: string, cohortId: string): Promise<boolean> {
  const [activeEnrollment] = await db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(and(eq(enrollments.studentId, studentId), eq(enrollments.cohortId, cohortId), eq(enrollments.status, "active")));
  if (activeEnrollment) return true;

  const [entitlement] = await db
    .select({ id: replayEntitlements.id })
    .from(replayEntitlements)
    .where(and(eq(replayEntitlements.studentId, studentId), eq(replayEntitlements.cohortId, cohortId), isNull(replayEntitlements.revokedAt)));
  return !!entitlement;
}

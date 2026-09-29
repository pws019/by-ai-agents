// 我的学习基础页（T-11）：报名列表 + 选中报名的课表和进度。
// 数据全部来自 T-09 的只读 API，没有接模型——M1 门槛就是"模型没接入也能查到正确业务事实"。
// 身份、导航（我的申请/退出）由外层 AppLayout 的侧栏提供，这里只管内容——跟聊天面板是同一个原则。
import { useEffect, useState } from "react";
import { getMyProgress, getMySchedule, listMyEnrollments } from "./api";
import type { Enrollment, ProgressItem, ScheduleItem } from "./types";

const STATUS_LABEL: Record<Enrollment["status"], string> = {
  active: "进行中",
  transferred: "已转班",
  refunded: "已退费",
  ended: "已结束",
};
const PROGRESS_LABEL: Record<ProgressItem["status"], string> = {
  not_started: "未开始",
  in_progress: "进行中",
  completed: "已完成",
};

export function MyLearningPage() {
  const [enrollments, setEnrollments] = useState<Enrollment[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleItem[] | null>(null);
  const [progress, setProgress] = useState<ProgressItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMyEnrollments()
      .then(({ items }) => {
        setEnrollments(items);
        setSelectedId(items[0]?.enrollmentId ?? null);
      })
      .catch(() => setError("加载报名信息失败"));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setSchedule(null);
    setProgress(null);
    Promise.all([getMySchedule(selectedId), getMyProgress(selectedId)])
      .then(([s, p]) => {
        setSchedule(s.items);
        setProgress(p.items);
      })
      .catch(() => setError("加载课表/进度失败"));
  }, [selectedId]);

  const progressByLesson = new Map((progress ?? []).map((p) => [p.lessonId, p]));

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="p-8 max-w-container-max-width mx-auto">
        <h1 className="text-headline-sm text-on-surface mb-6">我的学习</h1>

        {error && <p className="text-error mb-4">{error}</p>}

        {enrollments === null ? (
          <p className="text-on-surface-variant">加载中…</p>
        ) : enrollments.length === 0 ? (
          <p className="text-on-surface-variant">还没有报名记录。</p>
        ) : (
          <>
            <div className="flex gap-2 mb-6 flex-wrap">
              {enrollments.map((e) => (
                <button
                  key={e.enrollmentId}
                  onClick={() => setSelectedId(e.enrollmentId)}
                  className={`rounded-full px-4 py-1.5 text-label-md transition-colors ${
                    e.enrollmentId === selectedId
                      ? "bg-primary text-on-primary"
                      : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high"
                  }`}
                >
                  {e.cohort.name}（{STATUS_LABEL[e.status]}）
                </button>
              ))}
            </div>

            {schedule === null || progress === null ? (
              <p className="text-on-surface-variant">加载课表中…</p>
            ) : schedule.length === 0 ? (
              <p className="text-on-surface-variant">这个班期还没有排课。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {schedule.map((lesson) => {
                  const p = progressByLesson.get(lesson.lessonId);
                  return (
                    <li
                      key={lesson.lessonId}
                      className="flex items-center justify-between rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-3"
                    >
                      <span className="text-body-sm text-on-surface">
                        第 {lesson.order} 课：{lesson.title}
                        {lesson.hasReplay && <span className="ml-2 text-label-sm text-on-surface-variant">（有回放）</span>}
                      </span>
                      {/* 没有 progress 记录的课次不编一个"未开始"出来，如实显示"暂无记录"——
                          见 education-api 的设计决定：不编造未录入的数据。 */}
                      <span
                        className={`text-label-sm rounded-full px-2.5 py-1 ${
                          p?.status === "completed"
                            ? "bg-primary-container text-on-primary-container"
                            : p?.status === "in_progress"
                              ? "bg-secondary-container text-on-secondary-container"
                              : "bg-surface-container text-on-surface-variant"
                        }`}
                      >
                        {p ? PROGRESS_LABEL[p.status] : "暂无记录"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

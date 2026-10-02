// 资料维护页面（T-29）：导入新版本字幕/讲义、查看每一版的发布/索引状态、发布或撤回。
// 授权与状态机全在后端（education-api 转发给 education-agent 的 ingestion.db，T-26 已经测过），
// 这里只负责调用和如实展示——跟 TeacherHandoffsPage 是同一个原则，不在前端重新判断一遍"能不能发布"。
//
// 布局跟 TeacherHandoffsPage 同一个模式：左栏固定宽度的树形目录（班期 > 课次，点选不是粘贴 id），
// 右栏是选中课次的资料维护内容，互不重新挂载——跟会话工作台"左边选会话、右边看内容"是同一个原因：
// 老师在浏览目录找课次的同时，右边刚看的内容不需要消失/重建。
import { useEffect, useState } from "react";
import { Icon } from "../components/ui/Icon";
import {
  ApiError,
  importKnowledgeDocument,
  listKnowledgeDocuments,
  listTeacherCohorts,
  listTeacherLessons,
  publishKnowledgeDocument,
  withdrawKnowledgeDocument,
} from "./api";
import type { KnowledgeDocument, KnowledgeKind, ScheduleItem, TeacherCohortSummary } from "./types";

const KIND_LABEL: Record<KnowledgeKind, string> = { srt: "SRT 字幕", vtt: "VTT 字幕", markdown: "Markdown 讲义" };
const INDEX_STATUS_LABEL: Record<string, string> = { pending: "等待索引", running: "索引中", succeeded: "索引完成", failed: "索引失败" };
const COHORT_STATUS_LABEL: Record<TeacherCohortSummary["status"], string> = { upcoming: "未开课", running: "进行中", ended: "已结束" };

type Selected = { cohort: TeacherCohortSummary; lesson: ScheduleItem };

export function TeacherKnowledgePage() {
  const [cohorts, setCohorts] = useState<TeacherCohortSummary[] | null>(null);
  const [cohortsError, setCohortsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);

  useEffect(() => {
    listTeacherCohorts()
      .then(({ items }) => setCohorts(items))
      .catch(() => setCohortsError("加载班期列表失败"));
  }, []);

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center h-16 px-gutter border-b border-outline-variant bg-surface shrink-0">
        <h1 className="text-headline-sm font-semibold text-on-surface">资料维护</h1>
      </header>

      <div className="flex-1 min-h-0 flex">
        <div className="w-[320px] shrink-0 border-r border-outline-variant h-full overflow-y-auto custom-scrollbar py-4">
          <CohortTree cohorts={cohorts} error={cohortsError} selectedLessonId={selected?.lesson.lessonId ?? null} onSelectLesson={(cohort, lesson) => setSelected({ cohort, lesson })} />
        </div>

        <div className="flex-1 min-w-0 h-full overflow-y-auto custom-scrollbar">
          {!selected ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-on-surface-variant">
              <Icon name="menu_book" className="text-[40px] text-outline" />
              <p className="text-body-sm">从左侧选一节课查看资料</p>
            </div>
          ) : (
            <div className="p-8 max-w-container-max-width mx-auto flex flex-col gap-6">
              <LessonMaterials key={selected.lesson.lessonId} cohortName={selected.cohort.name} lesson={selected.lesson} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 树：班期是可展开/收起的节点，第一次展开才去拉这个班期的课次列表并缓存住，收起再展开不用重新请求。
function CohortTree({
  cohorts,
  error,
  selectedLessonId,
  onSelectLesson,
}: {
  cohorts: TeacherCohortSummary[] | null;
  error: string | null;
  selectedLessonId: string | null;
  onSelectLesson: (cohort: TeacherCohortSummary, lesson: ScheduleItem) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [lessonsByCohort, setLessonsByCohort] = useState<Record<string, ScheduleItem[] | "error" | undefined>>({});

  function toggle(cohort: TeacherCohortSummary) {
    const next = new Set(expanded);
    if (next.has(cohort.cohortId)) {
      next.delete(cohort.cohortId);
    } else {
      next.add(cohort.cohortId);
      if (lessonsByCohort[cohort.cohortId] === undefined || lessonsByCohort[cohort.cohortId] === "error") {
        setLessonsByCohort((prev) => ({ ...prev, [cohort.cohortId]: undefined }));
        listTeacherLessons(cohort.cohortId)
          .then(({ items }) => setLessonsByCohort((prev) => ({ ...prev, [cohort.cohortId]: items })))
          .catch(() => setLessonsByCohort((prev) => ({ ...prev, [cohort.cohortId]: "error" })));
      }
    }
    setExpanded(next);
  }

  if (error) return <p className="px-4 text-body-sm text-error">{error}</p>;
  if (cohorts === null) return <p className="px-4 text-body-sm text-on-surface-variant">加载中…</p>;
  if (cohorts.length === 0) return <p className="px-4 text-body-sm text-outline italic">还没有任何班期。</p>;

  return (
    <ul className="flex flex-col gap-0.5 px-2" aria-label="班期与课次目录">
      {cohorts.map((cohort) => {
        const isOpen = expanded.has(cohort.cohortId);
        const lessons = lessonsByCohort[cohort.cohortId];
        return (
          <li key={cohort.cohortId}>
            <button
              type="button"
              onClick={() => toggle(cohort)}
              aria-expanded={isOpen}
              className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-surface-container-low"
            >
              <Icon name={isOpen ? "expand_more" : "chevron_right"} className="text-[18px] text-outline shrink-0" />
              <Icon name={isOpen ? "folder_open" : "folder"} filled className="text-[18px] text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-body-sm text-on-surface truncate">{cohort.name}</p>
                <p className="text-label-sm text-on-surface-variant truncate">{cohort.courseTitle}</p>
              </div>
              <span className="shrink-0 text-label-sm text-on-surface-variant">{COHORT_STATUS_LABEL[cohort.status]}</span>
            </button>

            {isOpen && (
              <ul className="pl-8 flex flex-col gap-0.5 mt-0.5 mb-1">
                {lessons === undefined ? (
                  <li className="px-2 py-1 text-label-sm text-on-surface-variant">加载中…</li>
                ) : lessons === "error" ? (
                  <li className="px-2 py-1 text-label-sm text-error">加载课次失败</li>
                ) : lessons.length === 0 ? (
                  <li className="px-2 py-1 text-label-sm text-outline italic">还没有排课</li>
                ) : (
                  lessons.map((lesson) => {
                    const active = lesson.lessonId === selectedLessonId;
                    return (
                      <li key={lesson.lessonId}>
                        <button
                          type="button"
                          onClick={() => onSelectLesson(cohort, lesson)}
                          className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                            active ? "bg-primary-container text-on-primary-container" : "text-on-surface-variant hover:bg-surface-container-low"
                          }`}
                        >
                          <Icon name="menu_book" filled className="text-[16px] shrink-0" />
                          <span className="shrink-0 text-label-sm opacity-70">#{lesson.order}</span>
                          <span className="flex-1 min-w-0 truncate text-body-sm">{lesson.title}</span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function LessonMaterials({ cohortName, lesson }: { cohortName: string; lesson: ScheduleItem }) {
  const [documents, setDocuments] = useState<KnowledgeDocument[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [kind, setKind] = useState<KnowledgeKind>("markdown");
  const [sourceName, setSourceName] = useState("");
  const [rawContent, setRawContent] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("private");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  function refreshDocuments() {
    return listKnowledgeDocuments(lesson.lessonId)
      .then(({ items }) => setDocuments(items))
      .catch(() => setActionError("加载资料列表失败"));
  }

  useEffect(() => {
    setDocuments(null);
    void refreshDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson.lessonId]);

  async function doImport() {
    if (!sourceName.trim() || !rawContent.trim() || importBusy) return;
    setImportBusy(true);
    setImportError(null);
    try {
      await importKnowledgeDocument({ lessonId: lesson.lessonId, kind, sourceName: sourceName.trim(), rawContent, visibility });
      setSourceName("");
      setRawContent("");
      await refreshDocuments();
    } catch (err) {
      setImportError(err instanceof ApiError ? `导入失败（${err.code}）` : "导入失败，请检查网络后重试");
    } finally {
      setImportBusy(false);
    }
  }

  async function doPublish(documentId: string) {
    if (busyId) return;
    setBusyId(documentId);
    setActionError(null);
    try {
      await publishKnowledgeDocument(documentId);
      await refreshDocuments();
    } catch (err) {
      setActionError(
        err instanceof ApiError
          ? { LESSON_BUSY: "这节课正有另一次发布在处理，请稍后重试。", INVALID_STATE: "这一版的索引还没成功，暂时不能发布。" }[err.code] ??
              `发布失败（${err.code}）`
          : "发布失败，请检查网络后重试",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function doWithdraw(documentId: string) {
    if (busyId) return;
    setBusyId(documentId);
    setActionError(null);
    try {
      await withdrawKnowledgeDocument(documentId);
      await refreshDocuments();
    } catch (err) {
      setActionError(err instanceof ApiError ? `撤回失败（${err.code}）` : "撤回失败，请检查网络后重试");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <section className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4 flex items-center gap-2">
        <Icon name="menu_book" filled className="text-primary" />
        <span className="text-body-md text-on-surface">
          {cohortName} · {lesson.title}
        </span>
      </section>

      {actionError && <p className="text-body-sm text-error">{actionError}</p>}

      <section className="flex flex-col gap-2">
        <h2 className="text-label-lg font-semibold text-on-surface">已导入的版本</h2>
        {documents === null ? (
          <p className="text-body-sm text-on-surface-variant">加载中…</p>
        ) : documents.length === 0 ? (
          <p className="text-body-sm text-outline italic">这节课还没导入过资料。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {documents.map((d) => (
              <DocumentRow key={d.documentId} doc={d} busy={busyId === d.documentId} onPublish={() => void doPublish(d.documentId)} onWithdraw={() => void doWithdraw(d.documentId)} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4 flex flex-col gap-3">
        <h2 className="text-label-lg font-semibold text-on-surface">导入新版本</h2>
        <p className="text-label-sm text-outline">
          粘贴整份字幕/讲义的原始文本（不支持上传文件或抓取 URL）。内容跟当前最新版本完全一样不会产生新版本。
        </p>
        <div className="flex gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as KnowledgeKind)}
            className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-body-sm"
          >
            {(Object.keys(KIND_LABEL) as KnowledgeKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as "public" | "private")}
            className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-body-sm"
          >
            <option value="private">仅本班期可见</option>
            <option value="public">公开（不限 cohort）</option>
          </select>
          <input
            value={sourceName}
            onChange={(e) => setSourceName(e.target.value)}
            placeholder="原始文件名（仅排查用），如 lesson-1.srt"
            className="flex-1 rounded-lg border border-outline-variant bg-surface px-3 py-2 text-body-sm"
          />
        </div>
        <textarea
          value={rawContent}
          onChange={(e) => setRawContent(e.target.value)}
          rows={8}
          placeholder="粘贴原始文本…"
          className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-body-sm font-mono"
        />
        {importError && <p className="text-body-sm text-error">{importError}</p>}
        <button
          type="button"
          onClick={() => void doImport()}
          disabled={importBusy || !sourceName.trim() || !rawContent.trim()}
          className="self-start rounded-lg bg-primary text-on-primary px-4 py-2 text-label-md disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {importBusy ? "导入中…" : "导入"}
        </button>
      </section>
    </>
  );
}

function DocumentRow({
  doc,
  busy,
  onPublish,
  onWithdraw,
}: {
  doc: KnowledgeDocument;
  busy: boolean;
  onPublish: () => void;
  onWithdraw: () => void;
}) {
  const active = doc.activatedAt !== null;
  const canPublish = doc.indexStatus === "succeeded" && !active;
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-3">
      <div className="min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-2 text-body-sm text-on-surface">
          <span className="font-semibold">v{doc.version}</span>
          <span>{KIND_LABEL[doc.kind]}</span>
          <span className="text-on-surface-variant truncate">{doc.sourceName}</span>
          {doc.visibility === "public" && <span className="text-label-sm text-secondary">公开</span>}
        </div>
        <div className="flex items-center gap-2 text-label-sm text-on-surface-variant">
          <span>{doc.segmentCount} 个片段</span>
          <StatusBadge active={active} indexStatus={doc.indexStatus} />
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {active ? (
          <button
            type="button"
            onClick={onWithdraw}
            disabled={busy}
            className="rounded-lg border border-outline-variant px-3 py-1.5 text-label-sm text-on-surface-variant hover:bg-surface-container-low disabled:opacity-50"
          >
            {busy ? "处理中…" : "撤回"}
          </button>
        ) : (
          <button
            type="button"
            onClick={onPublish}
            disabled={busy || !canPublish}
            title={canPublish ? undefined : "索引完成后才能发布"}
            className="rounded-lg bg-primary text-on-primary px-3 py-1.5 text-label-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "处理中…" : "发布"}
          </button>
        )}
      </div>
    </li>
  );
}

function StatusBadge({ active, indexStatus }: { active: boolean; indexStatus: KnowledgeDocument["indexStatus"] }) {
  if (active) {
    return (
      <span className="rounded-full bg-primary-container text-on-primary-container px-2 py-0.5">
        已发布
      </span>
    );
  }
  if (indexStatus === null) {
    return <span className="rounded-full bg-surface-container text-on-surface-variant px-2 py-0.5">未登记索引</span>;
  }
  const tone = indexStatus === "failed" ? "bg-error-container text-on-error-container" : "bg-surface-container text-on-surface-variant";
  return <span className={`rounded-full px-2 py-0.5 ${tone}`}>{INDEX_STATUS_LABEL[indexStatus]}</span>;
}

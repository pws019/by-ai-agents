// 资料维护页面（T-29）：导入新版本字幕/讲义、查看每一版的发布/索引状态、发布或撤回。
// 授权与状态机全在后端（education-api 转发给 education-agent 的 ingestion.db，T-26 已经测过），
// 这里只负责调用和如实展示——跟 TeacherHandoffsPage 是同一个原则，不在前端重新判断一遍"能不能发布"。
import { useState } from "react";
import { Icon } from "../components/ui/Icon";
import {
  ApiError,
  importKnowledgeDocument,
  listKnowledgeDocuments,
  publishKnowledgeDocument,
  teacherGetLesson,
  withdrawKnowledgeDocument,
} from "./api";
import type { KnowledgeDocument, KnowledgeKind, TeacherLessonLookup } from "./types";

const KIND_LABEL: Record<KnowledgeKind, string> = { srt: "SRT 字幕", vtt: "VTT 字幕", markdown: "Markdown 讲义" };
const INDEX_STATUS_LABEL: Record<string, string> = { pending: "等待索引", running: "索引中", succeeded: "索引完成", failed: "索引失败" };

export function TeacherKnowledgePage() {
  const [lessonIdInput, setLessonIdInput] = useState("");
  const [lesson, setLesson] = useState<TeacherLessonLookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<KnowledgeDocument[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [kind, setKind] = useState<KnowledgeKind>("markdown");
  const [sourceName, setSourceName] = useState("");
  const [rawContent, setRawContent] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("private");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  function refreshDocuments(lessonId: string) {
    return listKnowledgeDocuments(lessonId)
      .then(({ items }) => setDocuments(items))
      .catch(() => setActionError("加载资料列表失败"));
  }

  async function lookupLesson() {
    const lessonId = lessonIdInput.trim();
    if (!lessonId) return;
    setLookupError(null);
    setLesson(null);
    setDocuments(null);
    try {
      const found = await teacherGetLesson(lessonId);
      setLesson(found);
      await refreshDocuments(found.lessonId);
    } catch (err) {
      setLookupError(err instanceof ApiError && err.status === 404 ? "没有找到这个课次 id" : "查找失败，请检查网络后重试");
    }
  }

  async function doImport() {
    if (!lesson || !sourceName.trim() || !rawContent.trim() || importBusy) return;
    setImportBusy(true);
    setImportError(null);
    try {
      await importKnowledgeDocument({ lessonId: lesson.lessonId, kind, sourceName: sourceName.trim(), rawContent, visibility });
      setSourceName("");
      setRawContent("");
      await refreshDocuments(lesson.lessonId);
    } catch (err) {
      setImportError(err instanceof ApiError ? `导入失败（${err.code}）` : "导入失败，请检查网络后重试");
    } finally {
      setImportBusy(false);
    }
  }

  async function doPublish(documentId: string) {
    if (!lesson || busyId) return;
    setBusyId(documentId);
    setActionError(null);
    try {
      await publishKnowledgeDocument(documentId);
      await refreshDocuments(lesson.lessonId);
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
    if (!lesson || busyId) return;
    setBusyId(documentId);
    setActionError(null);
    try {
      await withdrawKnowledgeDocument(documentId);
      await refreshDocuments(lesson.lessonId);
    } catch (err) {
      setActionError(err instanceof ApiError ? `撤回失败（${err.code}）` : "撤回失败，请检查网络后重试");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="p-8 max-w-container-max-width mx-auto flex flex-col gap-6">
        <h1 className="text-headline-sm text-on-surface">资料维护</h1>

        <section className="flex flex-col gap-2">
          <label className="text-label-md text-on-surface-variant" htmlFor="lesson-id-input">
            课次 id
          </label>
          <div className="flex gap-2">
            <input
              id="lesson-id-input"
              value={lessonIdInput}
              onChange={(e) => setLessonIdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void lookupLesson()}
              placeholder="粘贴课次（lesson）id"
              className="flex-1 rounded-xl border border-outline-variant bg-surface-container-lowest px-3 py-2 text-body-sm focus:outline-none focus:border-primary"
            />
            <button
              type="button"
              onClick={() => void lookupLesson()}
              className="rounded-lg bg-primary text-on-primary px-4 py-2 text-label-md hover:opacity-90"
            >
              查找
            </button>
          </div>
          {lookupError && <p className="text-body-sm text-error">{lookupError}</p>}
        </section>

        {lesson && (
          <>
            <section className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4 flex items-center gap-2">
              <Icon name="menu_book" filled className="text-primary" />
              <span className="text-body-md text-on-surface">
                {lesson.cohortName} · {lesson.title}
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
        )}
      </div>
    </div>
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

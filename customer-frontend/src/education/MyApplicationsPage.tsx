// 我的申请（T-16）：学员发起转班/退费申请、查看进度时间线、回应老师方案——
// 全程不需要聊天，跟 M2 阶段门槛"领域闭环可独立工作"对应。
import { useEffect, useState } from "react";
import {
  ApiError,
  confirmApplication,
  createApplicationDraft,
  getApplication,
  getTransferTargets,
  listMyApplications,
  listMyEnrollments,
  respondToProposal,
  supplementApplication,
  withdrawApplication,
} from "./api";
import { APPLICATION_STATUS_LABEL, APPLICATION_TYPE_LABEL, eventLabel, isTerminalStatus } from "./applicationLabels";
import type { Application, ApplicationDetail, ApplicationType, CohortSummary, Enrollment } from "./types";

function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function MyApplicationsPage() {
  const [enrollments, setEnrollments] = useState<Enrollment[] | null>(null);
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [targetNames, setTargetNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  function refreshList() {
    return listMyApplications()
      .then(({ items }) => setApplications(items))
      .catch(() => setError("加载申请列表失败"));
  }

  useEffect(() => {
    listMyEnrollments()
      .then(({ items }) => setEnrollments(items))
      .catch(() => setError("加载报名信息失败"));
    void refreshList();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    getApplication(selectedId)
      .then((d) => {
        setDetail(d);
        if (d.type === "transfer") {
          getTransferTargets(d.enrollmentId)
            .then(({ items }) => setTargetNames(new Map(items.map((c) => [c.cohortId, c.name]))))
            .catch(() => {});
        }
      })
      .catch(() => setError("加载申请详情失败"));
  }, [selectedId]);

  async function afterAction(promise: Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await promise;
      await refreshList();
      if (selectedId) setDetail(await getApplication(selectedId));
    } catch (err) {
      setError(err instanceof ApiError ? `操作失败（${err.code}）` : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  function targetLabel(cohortId: string | null | undefined): string {
    if (!cohortId) return "未指定";
    return targetNames.get(cohortId) ?? `班期 ${cohortId.slice(0, 8)}`;
  }

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="p-8 max-w-container-max-width mx-auto">
        <h1 className="text-headline-sm text-on-surface mb-6">我的申请</h1>

        {error && <p className="text-error mb-4">{error}</p>}

        <div className="grid grid-cols-[320px_1fr] gap-6">
          <div>
            <button
              onClick={() => setCreating((v) => !v)}
              className="w-full mb-3 flex items-center justify-center gap-1.5 rounded-xl bg-primary text-on-primary py-2.5 text-label-md hover:opacity-90 active:scale-[0.98] transition-all"
            >
              {creating ? "取消" : "+ 新建申请"}
            </button>

            {creating && enrollments && (
              <CreateApplicationForm
                enrollments={enrollments}
                onCreated={(draft) => {
                  setCreating(false);
                  setError(null);
                  void refreshList();
                  setSelectedId(draft.id);
                }}
                onError={setError}
              />
            )}

            {applications === null ? (
              <p className="text-on-surface-variant">加载中…</p>
            ) : applications.length === 0 ? (
              <p className="text-on-surface-variant">还没有申请记录。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {applications.map((a) => (
                  <li key={a.id}>
                    <button
                      onClick={() => setSelectedId(a.id)}
                      className={`w-full text-left rounded-xl border px-3 py-2.5 text-body-sm transition-colors ${
                        a.id === selectedId
                          ? "border-primary bg-surface-container-high"
                          : "border-outline-variant bg-surface-container-lowest hover:bg-surface-container-low"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-on-surface">{APPLICATION_TYPE_LABEL[a.type]}</span>
                        <StatusBadge status={a.status} />
                      </div>
                      <div className="text-label-sm text-on-surface-variant mt-1 truncate">{a.summary.reason}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            {!detail ? (
              <p className="text-on-surface-variant">从左侧选一条申请查看详情。</p>
            ) : (
              <ApplicationDetailPanel
                detail={detail}
                busy={busy}
                targetLabel={targetLabel}
                onConfirm={() => {
                  if (!detail.pendingConfirmation) return;
                  void afterAction(
                    confirmApplication(detail.id, { confirmationId: detail.pendingConfirmation.confirmationId, expectedRevision: detail.revision }),
                  );
                }}
                onWithdraw={() => void afterAction(withdrawApplication(detail.id, { expectedRevision: detail.revision }))}
                onSupplement={(text) => void afterAction(supplementApplication(detail.id, { text, expectedRevision: detail.revision }))}
                onRespondProposal={(accept) => {
                  if (!detail.pendingConfirmation) return;
                  void afterAction(
                    respondToProposal(detail.id, {
                      accept,
                      confirmationId: detail.pendingConfirmation.confirmationId,
                      expectedRevision: detail.revision,
                    }),
                  );
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Application["status"] }) {
  const tone = isTerminalStatus(status)
    ? status === "approved"
      ? "bg-primary-container text-on-primary-container"
      : "bg-surface-container-high text-on-surface-variant"
    : "bg-secondary-container text-on-secondary-container";
  return <span className={`rounded-full px-2 py-0.5 text-xs ${tone}`}>{APPLICATION_STATUS_LABEL[status]}</span>;
}

function CreateApplicationForm({
  enrollments,
  onCreated,
  onError,
}: {
  enrollments: Enrollment[];
  onCreated: (draft: { id: string }) => void;
  onError: (msg: string) => void;
}) {
  const [enrollmentId, setEnrollmentId] = useState(enrollments[0]?.enrollmentId ?? "");
  const [type, setType] = useState<ApplicationType>("transfer");
  const [reason, setReason] = useState("");
  const [targetCohortId, setTargetCohortId] = useState<string>("");
  const [targets, setTargets] = useState<CohortSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (type !== "transfer" || !enrollmentId) {
      setTargets([]);
      return;
    }
    getTransferTargets(enrollmentId)
      .then(({ items }) => setTargets(items))
      .catch(() => setTargets([]));
  }, [type, enrollmentId]);

  async function handleSubmit() {
    if (!reason.trim()) {
      onError("请填写申请原因");
      return;
    }
    setSubmitting(true);
    try {
      // AC-007：转班的目标班期可以先不填（"未定"），审批过程中老师可以再提方案。
      const draft = await createApplicationDraft({
        type,
        enrollmentId,
        reason,
        targetCohortId: type === "transfer" ? (targetCohortId || null) : null,
      });
      await confirmApplication(draft.id, { confirmationId: draft.confirmation.confirmationId, expectedRevision: draft.revision });
      onCreated(draft);
    } catch (err) {
      onError(err instanceof ApiError ? `创建失败（${err.code}）` : "创建失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-xl border border-outline-variant bg-surface-container-lowest p-3 text-body-sm">
      <label className="flex flex-col gap-1">
        报名
        <select
          className="rounded border border-outline-variant px-2 py-1"
          value={enrollmentId}
          onChange={(e) => setEnrollmentId(e.target.value)}
        >
          {enrollments.map((e) => (
            <option key={e.enrollmentId} value={e.enrollmentId}>
              {e.cohort.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        类型
        <select className="rounded border border-outline-variant px-2 py-1" value={type} onChange={(e) => setType(e.target.value as ApplicationType)}>
          <option value="transfer">转班</option>
          <option value="refund">退费</option>
        </select>
      </label>
      {type === "transfer" && (
        <label className="flex flex-col gap-1">
          目标班期（可先不选，等老师给方案）
          <select
            className="rounded border border-outline-variant px-2 py-1"
            value={targetCohortId}
            onChange={(e) => setTargetCohortId(e.target.value)}
          >
            <option value="">未定</option>
            {targets.map((t) => (
              <option key={t.cohortId} value={t.cohortId}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1">
        原因
        <textarea
          className="rounded border border-outline-variant px-2 py-1"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
        />
      </label>
      <button
        onClick={() => void handleSubmit()}
        disabled={submitting || !enrollmentId}
        className="rounded-lg bg-primary text-on-primary py-1.5 disabled:opacity-50"
      >
        {submitting ? "提交中…" : "提交申请"}
      </button>
    </div>
  );
}

function ApplicationDetailPanel({
  detail,
  busy,
  targetLabel,
  onConfirm,
  onWithdraw,
  onSupplement,
  onRespondProposal,
}: {
  detail: ApplicationDetail;
  busy: boolean;
  targetLabel: (cohortId: string | null | undefined) => string;
  onConfirm: () => void;
  onWithdraw: () => void;
  onSupplement: (text: string) => void;
  onRespondProposal: (accept: boolean) => void;
}) {
  const [supplementText, setSupplementText] = useState("");
  const canWithdraw = ["submitted", "needs_info", "awaiting_student_confirmation"].includes(detail.status);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-title-md">
            {APPLICATION_TYPE_LABEL[detail.type]}申请
          </h2>
          <StatusBadge status={detail.status} />
        </div>
        <p className="text-sm text-on-surface-variant mb-1">原因：{detail.summary.reason}</p>
        {detail.type === "transfer" && <p className="text-sm text-on-surface-variant">目标班期：{targetLabel(detail.summary.targetCohortId)}</p>}
        {detail.type === "refund" && detail.summary.refundCents !== null && (
          <p className="text-sm text-on-surface-variant">退款金额：¥{centsToYuan(detail.summary.refundCents)}</p>
        )}
        <p className="text-xs text-on-surface-variant mt-1">当前版本：revision {detail.revision}</p>
      </div>

      {detail.status === "draft" && detail.pendingConfirmation && (
        <div className="rounded-xl border border-primary bg-primary-container/10 p-4">
          <p className="text-sm mb-2">草稿已生成，确认无误后提交：</p>
          <button onClick={onConfirm} disabled={busy} className="rounded-lg bg-primary text-on-primary px-4 py-1.5 text-label-md disabled:opacity-50">
            确认提交
          </button>
        </div>
      )}

      {detail.status === "needs_info" && (
        <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4">
          <p className="text-sm mb-2">老师要求补充信息，请在下方回复：</p>
          <textarea
            className="w-full rounded border border-outline-variant px-2 py-1 text-sm mb-2"
            rows={2}
            value={supplementText}
            onChange={(e) => setSupplementText(e.target.value)}
          />
          <button
            onClick={() => onSupplement(supplementText)}
            disabled={busy || !supplementText.trim()}
            className="rounded-lg bg-primary text-on-primary px-4 py-1.5 text-label-md disabled:opacity-50"
          >
            提交补充
          </button>
        </div>
      )}

      {detail.status === "awaiting_student_confirmation" && detail.proposal && detail.pendingConfirmation && (
        <div className="rounded-xl border border-primary bg-primary-container/10 p-4">
          <p className="text-sm mb-2">老师提出了方案，请确认：</p>
          {detail.type === "transfer" && <p className="text-sm mb-2">转入：{targetLabel(detail.proposal.targetCohortId)}</p>}
          {detail.type === "refund" && detail.proposal.refundCents !== undefined && (
            <p className="text-sm mb-2">退款金额：¥{centsToYuan(detail.proposal.refundCents)}</p>
          )}
          <div className="flex gap-2">
            <button onClick={() => onRespondProposal(true)} disabled={busy} className="rounded-lg bg-primary text-on-primary px-4 py-1.5 text-label-md disabled:opacity-50">
              接受
            </button>
            <button
              onClick={() => onRespondProposal(false)}
              disabled={busy}
              className="rounded-lg border border-outline-variant px-4 py-1.5 text-label-md disabled:opacity-50"
            >
              拒绝
            </button>
          </div>
        </div>
      )}

      {canWithdraw && (
        <button
          onClick={onWithdraw}
          disabled={busy}
          className="self-start rounded-lg border border-error text-error px-4 py-1.5 text-label-md disabled:opacity-50"
        >
          撤回申请
        </button>
      )}

      <div>
        <h3 className="text-title-sm mb-2">时间线</h3>
        <ul className="flex flex-col gap-2">
          {detail.events.map((ev, i) => (
            <li key={i} className="text-body-sm rounded-lg border border-outline-variant px-3 py-2">
              <div className="flex items-center justify-between">
                <span>{eventLabel(ev)}</span>
                <span className="text-xs text-on-surface-variant">{new Date(ev.createdAt).toLocaleString()}</span>
              </div>
              {typeof ev.details.text === "string" && <p className="text-xs text-on-surface-variant mt-1">{ev.details.text}</p>}
              {typeof ev.details.question === "string" && <p className="text-xs text-on-surface-variant mt-1">{ev.details.question}</p>}
              {typeof ev.details.reason === "string" && <p className="text-xs text-on-surface-variant mt-1">{ev.details.reason}</p>}
              {typeof ev.details.note === "string" && <p className="text-xs text-on-surface-variant mt-1">{ev.details.note}</p>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

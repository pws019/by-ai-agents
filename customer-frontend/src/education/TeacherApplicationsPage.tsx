// 老师审批页（T-16）：处理学员的转班/退费申请——要求补充信息、提出方案、批准、拒绝、
// 登记退款结果。审批链路里的每一步不变原则（revision/confirmedRevision）都在 education-api，
// 这里只负责调用和如实展示 409 冲突，不在前端重新判断一遍"能不能批"。
import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  ApiError,
  listTeacherApplications,
  getApplication,
  teacherApprove,
  teacherGetTransferTargets,
  teacherPropose,
  teacherRecordRefundResult,
  teacherReject,
  teacherRequestInfo,
} from "./api";
import { APPLICATION_STATUS_LABEL, APPLICATION_TYPE_LABEL, eventLabel } from "./applicationLabels";
import { useAuth } from "./AuthContext";
import type { Application, ApplicationDetail, ApplicationStatus, CohortSummary } from "./types";

function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

const STATUS_FILTERS: { label: string; value: ApplicationStatus | "" }[] = [
  { label: "全部", value: "" },
  { label: "待处理", value: "submitted" },
  { label: "待学员确认", value: "awaiting_student_confirmation" },
  { label: "待补充信息", value: "needs_info" },
  { label: "已批准", value: "approved" },
  { label: "已拒绝", value: "rejected" },
];

export function TeacherApplicationsPage() {
  const { user, logout } = useAuth();
  const [statusFilter, setStatusFilter] = useState<ApplicationStatus | "">("");
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [targets, setTargets] = useState<CohortSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function refreshList() {
    return listTeacherApplications(statusFilter ? { status: statusFilter } : undefined)
      .then(({ items }) => setApplications(items))
      .catch(() => setError("加载申请队列失败"));
  }

  useEffect(() => {
    void refreshList();
  }, [statusFilter]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    getApplication(selectedId)
      .then((d) => {
        setDetail(d);
        if (d.type === "transfer") {
          teacherGetTransferTargets(d.enrollmentId)
            .then(({ items }) => setTargets(items))
            .catch(() => setTargets([]));
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
      if (err instanceof ApiError && err.code === "REVISION_CONFLICT") {
        setError("申请已经被更新过（可能是另一位老师处理了，或学员刚做了操作），已刷新为最新状态，请核对后重试");
        if (selectedId) setDetail(await getApplication(selectedId));
        await refreshList();
      } else {
        setError(err instanceof ApiError ? `操作失败（${err.code}）` : "操作失败，请重试");
      }
    } finally {
      setBusy(false);
    }
  }

  function targetLabel(cohortId: string | null | undefined): string {
    if (!cohortId) return "未指定";
    return targets.find((t) => t.cohortId === cohortId)?.name ?? `班期 ${cohortId.slice(0, 8)}`;
  }

  return (
    <div className="min-h-screen bg-surface text-on-surface p-8 max-w-container-max-width mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <h1 className="text-headline-sm">申请审批</h1>
          <Link to="/teacher/handoffs" className="text-sm text-primary underline">
            会话工作台
          </Link>
        </div>
        <div className="flex items-center gap-3 text-sm text-on-surface-variant">
          <span>{user?.loginName}</span>
          <button onClick={() => void logout()} className="text-primary underline">
            退出登录
          </button>
        </div>
      </header>

      {error && <p className="text-error mb-4">{error}</p>}

      <div className="grid grid-cols-[360px_1fr] gap-6">
        <div>
          <div className="flex flex-wrap gap-1 mb-3">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`rounded-md px-2.5 py-1 text-xs ${
                  statusFilter === f.value ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface-variant"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {applications === null ? (
            <p className="text-on-surface-variant">加载中…</p>
          ) : applications.length === 0 ? (
            <p className="text-on-surface-variant">没有符合条件的申请。</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {applications.map((a) => (
                <li key={a.id}>
                  <button
                    onClick={() => setSelectedId(a.id)}
                    className={`w-full text-left rounded-md border px-3 py-2 text-sm ${
                      a.id === selectedId ? "border-primary bg-primary-container/10" : "border-outline-variant"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span>{APPLICATION_TYPE_LABEL[a.type]}</span>
                      <span className="rounded-full px-2 py-0.5 text-xs bg-secondary-container text-on-secondary-container">
                        {APPLICATION_STATUS_LABEL[a.status]}
                      </span>
                    </div>
                    <div className="text-xs text-on-surface-variant mt-1 truncate">{a.summary.reason}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          {!detail ? (
            <p className="text-on-surface-variant">从左侧选一条申请处理。</p>
          ) : (
            <TeacherDetailPanel
              detail={detail}
              targets={targets}
              targetLabel={targetLabel}
              busy={busy}
              onRequestInfo={(question) => void afterAction(teacherRequestInfo(detail.id, { question, expectedRevision: detail.revision }))}
              onPropose={(body) => void afterAction(teacherPropose(detail.id, { ...body, expectedRevision: detail.revision }))}
              onApprove={(oldReplayAccess) =>
                void afterAction(teacherApprove(detail.id, { expectedRevision: detail.revision, ...(oldReplayAccess ? { oldReplayAccess } : {}) }))
              }
              onReject={(reason) => void afterAction(teacherReject(detail.id, { reason, expectedRevision: detail.revision }))}
              onRefundResult={(body) => void afterAction(teacherRecordRefundResult(detail.id, { ...body, expectedRevision: detail.revision }))}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TeacherDetailPanel({
  detail,
  targets,
  targetLabel,
  busy,
  onRequestInfo,
  onPropose,
  onApprove,
  onReject,
  onRefundResult,
}: {
  detail: ApplicationDetail;
  targets: CohortSummary[];
  targetLabel: (cohortId: string | null | undefined) => string;
  busy: boolean;
  onRequestInfo: (question: string) => void;
  onPropose: (body: { targetCohortId?: string | null; refundCents?: number; reason: string }) => void;
  onApprove: (oldReplayAccess?: "keep" | "revoke") => void;
  onReject: (reason: string) => void;
  onRefundResult: (body: { outcome: "completed" | "failed"; note: string; reference?: string | null }) => void;
}) {
  const [question, setQuestion] = useState("");
  const [proposeReason, setProposeReason] = useState("");
  const [proposeTarget, setProposeTarget] = useState("");
  const [proposeRefundYuan, setProposeRefundYuan] = useState("");
  const [oldReplayAccess, setOldReplayAccess] = useState<"keep" | "revoke">("keep");
  const [rejectReason, setRejectReason] = useState("");
  const [refundOutcome, setRefundOutcome] = useState<"completed" | "failed">("completed");
  const [refundNote, setRefundNote] = useState("");
  const [refundReference, setRefundReference] = useState("");

  const canDecide = detail.status === "submitted";
  const canRecordRefund = detail.type === "refund" && detail.status === "approved" && detail.executionStatus === "pending";

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-outline-variant p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-title-md">{APPLICATION_TYPE_LABEL[detail.type]}申请</h2>
          <span className="rounded-full px-2 py-0.5 text-xs bg-secondary-container text-on-secondary-container">
            {APPLICATION_STATUS_LABEL[detail.status]}
          </span>
        </div>
        <p className="text-sm text-on-surface-variant mb-1">学员原因：{detail.summary.reason}</p>
        {detail.type === "transfer" && <p className="text-sm text-on-surface-variant">学员填写的目标：{targetLabel(detail.summary.targetCohortId)}</p>}
        {detail.proposal && (
          <p className="text-sm text-on-surface-variant">
            当前方案：
            {detail.type === "transfer" ? targetLabel(detail.proposal.targetCohortId) : `退款 ¥${centsToYuan(detail.proposal.refundCents ?? 0)}`}
          </p>
        )}
        <p className="text-xs text-on-surface-variant mt-1">执行状态：{detail.executionStatus}　revision {detail.revision}</p>
      </div>

      {canDecide && (
        <div className="flex flex-col gap-4 rounded-md border border-outline-variant p-4">
          <div>
            <p className="text-sm mb-2">要求补充信息</p>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded border border-outline-variant px-2 py-1 text-sm"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="需要学员补充什么？"
              />
              <button
                onClick={() => onRequestInfo(question)}
                disabled={busy || !question.trim()}
                className="rounded-md border border-outline-variant px-3 py-1.5 text-sm disabled:opacity-50"
              >
                发送
              </button>
            </div>
          </div>

          <div>
            <p className="text-sm mb-2">提出方案（转班目标或退款金额可以跟学员申请的不一样，学员需要重新确认）</p>
            {detail.type === "transfer" ? (
              <select
                className="w-full rounded border border-outline-variant px-2 py-1 text-sm mb-2"
                value={proposeTarget}
                onChange={(e) => setProposeTarget(e.target.value)}
              >
                <option value="">选择目标班期</option>
                {targets.map((t) => (
                  <option key={t.cohortId} value={t.cohortId}>
                    {t.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                min={0}
                step={0.01}
                className="w-full rounded border border-outline-variant px-2 py-1 text-sm mb-2"
                value={proposeRefundYuan}
                onChange={(e) => setProposeRefundYuan(e.target.value)}
                placeholder="退款金额（元）"
              />
            )}
            <input
              className="w-full rounded border border-outline-variant px-2 py-1 text-sm mb-2"
              value={proposeReason}
              onChange={(e) => setProposeReason(e.target.value)}
              placeholder="方案说明"
            />
            <button
              onClick={() =>
                onPropose(
                  detail.type === "transfer"
                    ? { targetCohortId: proposeTarget, reason: proposeReason }
                    : { refundCents: Math.round(Number(proposeRefundYuan) * 100), reason: proposeReason },
                )
              }
              disabled={
                busy ||
                !proposeReason.trim() ||
                (detail.type === "transfer" ? !proposeTarget : !(Number(proposeRefundYuan) >= 0))
              }
              className="rounded-md border border-outline-variant px-3 py-1.5 text-sm disabled:opacity-50"
            >
              提出方案（需学员确认）
            </button>
          </div>

          <div>
            <p className="text-sm mb-2">直接批准（沿用学员申请里原本的内容，不经过学员再次确认）</p>
            {detail.type === "transfer" && (
              <select
                className="rounded border border-outline-variant px-2 py-1 text-sm mb-2"
                value={oldReplayAccess}
                onChange={(e) => setOldReplayAccess(e.target.value as "keep" | "revoke")}
              >
                <option value="keep">保留旧班期回放权益</option>
                <option value="revoke">不保留</option>
              </select>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => onApprove(detail.type === "transfer" ? oldReplayAccess : undefined)}
                disabled={busy}
                className="rounded-md bg-primary text-on-primary px-4 py-1.5 text-sm disabled:opacity-50"
              >
                批准
              </button>
            </div>
          </div>

          <div>
            <p className="text-sm mb-2">拒绝</p>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded border border-outline-variant px-2 py-1 text-sm"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="拒绝原因"
              />
              <button
                onClick={() => onReject(rejectReason)}
                disabled={busy || !rejectReason.trim()}
                className="rounded-md border border-error text-error px-3 py-1.5 text-sm disabled:opacity-50"
              >
                拒绝
              </button>
            </div>
          </div>
        </div>
      )}

      {canRecordRefund && (
        <div className="rounded-md border border-primary bg-primary-container/10 p-4">
          <p className="text-sm mb-2">
            登记退款结果——这个系统没有接支付渠道，钱是在系统外面手动转的，这里只记录"转成了"还是"转失败了"。
          </p>
          <select
            className="rounded border border-outline-variant px-2 py-1 text-sm mb-2"
            value={refundOutcome}
            onChange={(e) => setRefundOutcome(e.target.value as "completed" | "failed")}
          >
            <option value="completed">已转账成功</option>
            <option value="failed">转账失败</option>
          </select>
          <input
            className="w-full rounded border border-outline-variant px-2 py-1 text-sm mb-2"
            value={refundReference}
            onChange={(e) => setRefundReference(e.target.value)}
            placeholder="转账凭证号（可不填）"
          />
          <input
            className="w-full rounded border border-outline-variant px-2 py-1 text-sm mb-2"
            value={refundNote}
            onChange={(e) => setRefundNote(e.target.value)}
            placeholder="备注（必填）"
          />
          <button
            onClick={() => onRefundResult({ outcome: refundOutcome, note: refundNote, reference: refundReference || null })}
            disabled={busy || !refundNote.trim()}
            className="rounded-md bg-primary text-on-primary px-4 py-1.5 text-sm disabled:opacity-50"
          >
            登记
          </button>
        </div>
      )}

      <div>
        <h3 className="text-title-sm mb-2">时间线</h3>
        <ul className="flex flex-col gap-2">
          {detail.events.map((ev, i) => (
            <li key={i} className="text-sm rounded-md border border-outline-variant px-3 py-2">
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

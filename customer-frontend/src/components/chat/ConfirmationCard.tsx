import { Link } from "react-router";

import { APPLICATION_TYPE_LABEL } from "../../education/applicationLabels";
import type { ConfirmationCard as Card } from "../../lib/chat/events";
import { Icon } from "../ui/Icon";

type ConfirmationCardProps = {
  card: Card;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
};

const text = (v: unknown) => (typeof v === "string" && v ? v : null);

// 助手起草了一份申请，需要学员本人确认才会提交。"确认提交"调用的是业务 API（学员本人的操作），
// 不是让 Agent 去确认——Agent 没有这个能力（AC-004）。
export function ConfirmationCard({ card, busy, onConfirm, onDismiss }: ConfirmationCardProps) {
  const type = card.summary.type === "transfer" || card.summary.type === "refund" ? APPLICATION_TYPE_LABEL[card.summary.type] : "申请";
  const reason = text(card.summary.reason);
  const refund = typeof card.summary.refundCents === "number" ? `${(card.summary.refundCents / 100).toFixed(2)} 元` : null;
  const expired = new Date(card.expiresAt).getTime() <= Date.now();

  return (
    <div className="flex justify-start w-full" role="region" aria-label="待确认的申请草稿">
      <div className="flex gap-4 max-w-[85%] w-full">
        <div className="w-8 h-8 shrink-0" />
        <div className="w-full border border-primary rounded-xl bg-surface-container-lowest p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Icon name="assignment" filled className="text-primary" />
            <span className="text-label-md text-on-surface font-semibold">待确认：{type}申请草稿</span>
          </div>
          <dl className="text-body-sm text-on-surface-variant grid grid-cols-[4rem_1fr] gap-x-3 gap-y-1">
            <dt>类型</dt>
            <dd className="text-on-surface">{type}</dd>
            {reason && (
              <>
                <dt>原因</dt>
                <dd className="text-on-surface break-words">{reason}</dd>
              </>
            )}
            {refund && (
              <>
                <dt>退费金额</dt>
                <dd className="text-on-surface">{refund}</dd>
              </>
            )}
            <dt>有效期至</dt>
            <dd className="text-on-surface">{new Date(card.expiresAt).toLocaleString("zh-CN")}</dd>
          </dl>
          <p className="text-label-sm text-outline">这只是草稿，还没有提交。核对无误后点击确认才会正式提交给老师处理。</p>
          {expired && <p className="text-body-sm text-error">这张确认卡已过期，请重新发起申请。</p>}
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={busy || expired}
              onClick={onConfirm}
              className="rounded-lg bg-primary text-on-primary px-4 py-2 text-label-md disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? "处理中…" : "确认提交"}
            </button>
            <button type="button" disabled={busy} onClick={onDismiss} className="text-label-md text-secondary underline disabled:opacity-50">
              暂不提交
            </button>
            <Link to="/my-applications" className="text-label-md text-primary underline ml-auto">
              在“我的申请”里查看
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

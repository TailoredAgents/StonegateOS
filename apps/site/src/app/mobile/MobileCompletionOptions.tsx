"use client";

import { useMobileCompletionDraft } from "./mobile-completion-draft-context";

export function MobileCompletionOptions({
  partnerJob,
  canManageMedia,
  canSendCustomerMessages,
}: {
  partnerJob: boolean;
  canManageMedia: boolean;
  canSendCustomerMessages: boolean;
}) {
  const context = useMobileCompletionDraft();
  // Metadata may be unavailable. A real server proof error exposes the existing
  // authorized exception without requiring another page load or metadata fetch.
  const proofIssue = /proof|evidence/iu.test(context?.error ?? "");
  const showProof = canManageMedia && (partnerJob || proofIssue);
  if (!showProof && !canSendCustomerMessages) return null;
  return (
    <details
      open={proofIssue || undefined}
      className="rounded-lg border border-white/10 px-3"
    >
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-slate-300">
        More completion options
      </summary>
      <div className="space-y-3 pb-3">
        {showProof ? (
          <details
            open={proofIssue || undefined}
            className="rounded-lg border border-white/10 px-3"
          >
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-amber-100">
              Missing-proof exception
            </summary>
            <label className="block pb-3 text-sm text-slate-300">
              Use only when existing partner proof cannot be captured. The
              reason is recorded with the job.
              <textarea
                name="proofOverrideReason"
                minLength={10}
                maxLength={500}
                rows={3}
                defaultValue={context?.draft?.proofOverrideReason ?? ""}
                className="mt-2 w-full rounded-lg border border-white/15 bg-slate-900 p-3 text-base text-white"
                placeholder="Explain why proof cannot be provided"
              />
            </label>
          </details>
        ) : null}
        {canSendCustomerMessages ? (
          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-sm text-slate-300">
            <input
              name="sendReviewRequest"
              type="checkbox"
              defaultChecked={context?.draft?.sendReviewRequest === true}
              className="mt-0.5 h-5 w-5 shrink-0"
            />
            <span>
              Request a review by SMS after completion. Optional; delivery is
              confirmed separately.
            </span>
          </label>
        ) : null}
      </div>
    </details>
  );
}

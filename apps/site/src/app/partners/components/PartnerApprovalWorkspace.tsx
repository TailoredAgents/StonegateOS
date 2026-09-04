"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, LoaderCircle, ThumbsDown } from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  approvalDecisionAvailability,
  approvalDecisionErrorMessage,
  isApprovalHoldExpired,
  type PartnerApprovalDecision,
  type PartnerApprovalState,
} from "../lib/portal-approvals";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type DecisionMessage = {
  tone: "success" | "warning" | "error";
  text: string;
};

export function PartnerApprovalDecisionForm({
  requestId,
  initialEtag,
  initialState,
  requestedByCurrentMember,
  initialCurrentMemberDecision,
  expiresAt,
  rulesValid,
}: {
  requestId: string;
  initialEtag: string | null;
  initialState: PartnerApprovalState;
  requestedByCurrentMember: boolean;
  initialCurrentMemberDecision: PartnerApprovalDecision | null;
  expiresAt: string | null;
  rulesValid: boolean;
}) {
  const router = useRouter();
  const [decision, setDecision] =
    React.useState<PartnerApprovalDecision>("approved");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [state, setState] = React.useState(initialState);
  const [etag, setEtag] = React.useState(initialEtag);
  const [currentMemberDecision, setCurrentMemberDecision] = React.useState(
    initialCurrentMemberDecision,
  );
  const [message, setMessage] = React.useState<DecisionMessage | null>(null);
  const operationRef = React.useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);
  const errorRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setState(initialState);
    setEtag(initialEtag);
    setCurrentMemberDecision(initialCurrentMemberDecision);
  }, [initialCurrentMemberDecision, initialEtag, initialState]);

  const availability = approvalDecisionAvailability({
    state,
    requestedByCurrentMember,
    currentMemberDecision,
    expiresAt,
  });
  const holdExpired = isApprovalHoldExpired(expiresAt);
  const canDecide = availability.allowed && rulesValid && Boolean(etag);

  async function submit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!etag || !canDecide) return;
    const normalizedReason = reason.trim();
    if (decision === "declined" && normalizedReason.length < 5) {
      setMessage({
        tone: "error",
        text: "Add a decline reason with at least five characters so the requester knows what must change.",
      });
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    const payload = {
      decision,
      reason: normalizedReason || null,
    };
    const fingerprint = JSON.stringify({ ...payload, ifMatch: etag });
    if (
      !operationRef.current ||
      operationRef.current.fingerprint !== fingerprint
    ) {
      operationRef.current = {
        fingerprint,
        key: createPortalOperationKey("approval-decision"),
      };
    }
    setBusy(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      approvalRequest: {
        id: string;
        state: PartnerApprovalState;
        revision: number;
        etag: string;
      };
      decision: {
        id: string;
        decision: PartnerApprovalDecision;
        reason: string | null;
        createdAt: string;
      };
    }>(`approval-requests/${encodeURIComponent(requestId)}/decision`, {
      method: "POST",
      headers: {
        "If-Match": etag,
        "Idempotency-Key": operationRef.current.key,
      },
      body: JSON.stringify(payload),
    }).catch(() => null);
    setBusy(false);

    if (!result?.ok) {
      const status = result?.response.status ?? 503;
      const code = result?.error.error ?? "service_unavailable";
      setMessage({
        tone:
          code === "hold_expired" ||
          status === 409 ||
          status === 410 ||
          status === 412
            ? "warning"
            : "error",
        text: approvalDecisionErrorMessage(code, status),
      });
      if ([409, 410, 412].includes(status)) router.refresh();
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }

    const nextState = result.data.approvalRequest.state;
    setState(nextState);
    setEtag(
      result.response.headers.get("etag") ?? result.data.approvalRequest.etag,
    );
    setCurrentMemberDecision(result.data.decision.decision);
    operationRef.current = null;
    setMessage(
      nextState === "approved_needs_reschedule"
        ? {
            tone: "warning",
            text: "Your approval was recorded, but the temporary arrival window expired. The job now needs another available window before it can be confirmed.",
          }
        : nextState === "pending"
          ? {
              tone: "success",
              text: "Your decision was recorded. This request is still waiting for the remaining required approval decisions.",
            }
          : {
              tone: "success",
              text:
                result.data.decision.decision === "approved"
                  ? "The request was approved."
                  : "The request was declined and the requester can review your reason.",
            },
    );
    router.refresh();
  }

  const blockedCopy =
    availability.reason === "self_approval"
      ? "You submitted this request, so another authorized account member must decide it. Self-approval is not allowed."
      : availability.reason === "already_decided"
        ? `Your ${currentMemberDecision ?? "prior"} decision is already recorded and cannot be changed.`
        : availability.reason === "not_pending"
          ? "This approval is complete. Its decision is saved and cannot be changed here."
          : !rulesValid
            ? "The approval requirements could not be verified. Stonegate must review this request before an account decision can be accepted."
            : !etag
              ? "The request revision could not be verified. Refresh before making a decision."
              : null;

  return (
    <PartnerPanel>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
          Account decision
        </p>
        <h2 className="mt-1 text-lg font-semibold text-slate-950">
          Approve or decline this request
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Review the job, amount, schedule, and approval requirements. Your
          decision becomes part of the account’s audit history after you submit
          it.
        </p>
      </div>

      {message ? (
        <div ref={errorRef} tabIndex={-1} className="mt-5 focus:outline-none">
          <PartnerNotice tone={message.tone}>{message.text}</PartnerNotice>
        </div>
      ) : null}

      {blockedCopy ? (
        <PartnerNotice
          tone={
            availability.reason === "already_decided" ||
            availability.reason === "not_pending"
              ? "info"
              : "warning"
          }
          className="mt-5"
        >
          {blockedCopy}
        </PartnerNotice>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="mt-5">
          {holdExpired ? (
            <PartnerNotice tone="warning" className="mb-5">
              The temporary arrival window expired.{" "}
              {"You may still approve or decline this request"}, but another
              window is needed before the job can be confirmed.
            </PartnerNotice>
          ) : null}
          <fieldset disabled={busy}>
            <legend className="text-sm font-semibold text-slate-800">
              Decision
            </legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label
                className={cn(
                  "flex min-h-16 cursor-pointer items-start gap-3 rounded-xl border bg-white p-4 transition",
                  decision === "approved"
                    ? "border-emerald-400 ring-2 ring-emerald-100"
                    : "border-slate-300 hover:border-emerald-300",
                )}
              >
                <input
                  type="radio"
                  name="decision"
                  value="approved"
                  checked={decision === "approved"}
                  onChange={() => setDecision("approved")}
                  className="mt-1"
                />
                <span>
                  <span className="flex items-center gap-2 font-semibold text-slate-950">
                    <CheckCircle2
                      className="h-4 w-4 text-emerald-700"
                      aria-hidden="true"
                    />
                    Approve
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-slate-600">
                    Approve the request under the account requirements shown
                    above.
                  </span>
                </span>
              </label>
              <label
                className={cn(
                  "flex min-h-16 cursor-pointer items-start gap-3 rounded-xl border bg-white p-4 transition",
                  decision === "declined"
                    ? "border-rose-400 ring-2 ring-rose-100"
                    : "border-slate-300 hover:border-rose-300",
                )}
              >
                <input
                  type="radio"
                  name="decision"
                  value="declined"
                  checked={decision === "declined"}
                  onChange={() => setDecision("declined")}
                  className="mt-1"
                />
                <span>
                  <span className="flex items-center gap-2 font-semibold text-slate-950">
                    <ThumbsDown
                      className="h-4 w-4 text-rose-700"
                      aria-hidden="true"
                    />
                    Decline
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-slate-600">
                    Decline the request and explain what needs to change.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          <label htmlFor="partner-approval-reason" className="mt-4 block">
            <span className="text-sm font-semibold text-slate-700">
              {decision === "declined" ? "Decline reason" : "Decision note"}
            </span>
            <span className="ml-1 text-xs text-slate-500">
              {decision === "declined" ? "Required" : "Optional"}
            </span>
            <textarea
              id="partner-approval-reason"
              name="reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={busy}
              required={decision === "declined"}
              minLength={decision === "declined" ? 5 : undefined}
              maxLength={1_000}
              rows={4}
              aria-describedby="partner-approval-reason-help"
              className={partnerFieldClass}
            />
          </label>
          <p
            id="partner-approval-reason-help"
            className="mt-1.5 text-xs leading-5 text-slate-500"
          >
            This note becomes visible in the account approval history. Do not
            include gate codes, payment credentials, or other secrets.
          </p>
          <button
            type="submit"
            disabled={busy}
            className={cn(
              decision === "declined"
                ? partnerSecondaryButtonClass
                : partnerPrimaryButtonClass,
              "mt-4",
              decision === "declined"
                ? "border-rose-300 text-rose-800 hover:border-rose-400 hover:bg-rose-50 hover:text-rose-900"
                : null,
            )}
          >
            {busy ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : decision === "approved" ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ThumbsDown className="h-4 w-4" aria-hidden="true" />
            )}
            {busy
              ? "Recording decision…"
              : decision === "approved"
                ? "Record approval"
                : "Record decline"}
          </button>
        </form>
      )}
    </PartnerPanel>
  );
}

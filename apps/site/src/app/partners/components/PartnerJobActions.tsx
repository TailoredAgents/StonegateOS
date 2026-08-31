"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Ban, CalendarClock, Copy, LoaderCircle, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@myst-os/ui";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

export type PartnerCancellationDecision = {
  action: "cancel" | "request_cancellation_review" | null;
  reason: { code: string; label: string };
  deadlineAt: string | null;
  timezone: string;
  cutoffMinutes: number;
  consequence: {
    code: string;
    label: string;
    automaticFeeMinor: null;
  };
  policySource: "launch_default" | "configured";
};

function formatCancellationDeadline(
  value: string | null,
  timezone: string,
): string | null {
  if (!value) return null;
  const deadline = new Date(value);
  if (!Number.isFinite(deadline.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(deadline);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(deadline);
  }
}

export function PartnerJobActions({
  jobId,
  etag,
  allowedActions,
  cancellation,
}: {
  jobId: string;
  etag: string | null;
  allowedActions: string[];
  cancellation: PartnerCancellationDecision;
}) {
  const router = useRouter();
  const [canceling, setCanceling] = React.useState(false);
  const [duplicating, setDuplicating] = React.useState(false);
  const [savingTemplate, setSavingTemplate] = React.useState(false);
  const [message, setMessage] = React.useState<{
    text: string;
    tone: "success" | "error";
  } | null>(null);
  const canCancel =
    cancellation.action === "cancel" &&
    allowedActions.includes("cancel") &&
    Boolean(etag);
  const canRequestCancellationReview =
    cancellation.action === "request_cancellation_review" &&
    allowedActions.includes("request_cancellation_review") &&
    Boolean(etag);
  const hasCancellationAction = canCancel || canRequestCancellationReview;
  const canReschedule = allowedActions.includes("reschedule");
  const canDuplicate = allowedActions.includes("duplicate");
  const cancellationDeadline = formatCancellationDeadline(
    cancellation.deadlineAt,
    cancellation.timezone,
  );

  const cancel = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (!etag) return;
    const formData = new FormData(event.currentTarget);
    const rawReason = formData.get("reason");
    const reason = typeof rawReason === "string" ? rawReason.trim() : "";
    if (reason.length < 5) {
      setMessage({
        text: "Add a brief cancellation reason with at least five characters.",
        tone: "error",
      });
      return;
    }
    setCanceling(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      job: { status: string };
      cancellation: {
        outcome: "canceled" | "review_requested";
        automaticFeeMinor: null;
      };
    }>(`jobs/${jobId}/cancel`, {
      method: "POST",
      headers: {
        "If-Match": etag,
        "Idempotency-Key": createPortalOperationKey("job-cancel"),
      },
      body: JSON.stringify({ reason }),
    }).catch(() => null);
    setCanceling(false);
    if (!result?.ok) {
      setMessage({
        text:
          result?.error.message ??
          "The cancellation request was not saved. Refresh and try again.",
        tone: "error",
      });
      return;
    }
    setMessage({
      text:
        result.data.cancellation.outcome === "review_requested"
          ? "Your cancellation request was sent for staff review. The job remains scheduled until Stonegate responds."
          : "The job was canceled.",
      tone: "success",
    });
    router.refresh();
  };

  const bookAgain = async (): Promise<void> => {
    setDuplicating(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      draft: { id: string };
    }>(`jobs/${encodeURIComponent(jobId)}/duplicate`, {
      method: "POST",
      headers: { "Idempotency-Key": createPortalOperationKey("book-again") },
      body: JSON.stringify({}),
    }).catch(() => null);
    setDuplicating(false);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text:
          result?.error.message ??
          "A safe copy could not be created. The original job is unchanged.",
      });
      return;
    }
    router.push(
      `/partners/book?draftId=${encodeURIComponent(result.data.draft.id)}` as Route,
    );
  };

  const saveTemplate = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const name = String(
      new FormData(event.currentTarget).get("templateName") ?? "",
    ).trim();
    if (name.length < 2) {
      setMessage({
        tone: "error",
        text: "Use at least two characters for the template name.",
      });
      return;
    }
    setSavingTemplate(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      template: { id: string };
    }>("service-templates", {
      method: "POST",
      headers: {
        "Idempotency-Key": createPortalOperationKey("service-template"),
      },
      body: JSON.stringify({ name, jobId }),
    }).catch(() => null);
    setSavingTemplate(false);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The template was not saved.",
      });
      return;
    }
    event.currentTarget.reset();
    setMessage({
      tone: "success",
      text: "Reusable scope saved. One-time access, pricing, approvals, media, holds, and payment details were not copied.",
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {canDuplicate ? (
          <button
            type="button"
            onClick={() => void bookAgain()}
            disabled={duplicating}
            className={partnerPrimaryButtonClass}
          >
            {duplicating ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            {duplicating ? "Preparing…" : "Book again"}
          </button>
        ) : null}
        {canReschedule ? (
          <Link
            href={
              `/partners/bookings/${encodeURIComponent(jobId)}/reschedule` as Route
            }
            className={partnerSecondaryButtonClass}
          >
            <CalendarClock className="h-4 w-4" aria-hidden="true" />
            Change schedule
          </Link>
        ) : null}
      </div>
      {canDuplicate ? (
        <details className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg font-semibold text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden">
            <Save className="h-4 w-4" aria-hidden="true" />
            Save as reusable template
          </summary>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Saves service, location, reusable scope, crew notes, contact, and
            proof preferences. You will re-enter access and commercial details.
          </p>
          <form
            onSubmit={(event) => void saveTemplate(event)}
            className="mt-3 space-y-3"
            data-partner-analytics="template_save"
          >
            <label
              htmlFor="partner-template-name"
              className="block text-sm font-semibold text-slate-700"
            >
              Template name
              <input
                id="partner-template-name"
                name="templateName"
                required
                minLength={2}
                maxLength={120}
                className={partnerFieldClass}
                placeholder="Quarterly office cleanout"
              />
            </label>
            <button
              type="submit"
              disabled={savingTemplate}
              className={partnerSecondaryButtonClass}
            >
              {savingTemplate ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Save className="h-4 w-4" aria-hidden="true" />
              )}
              {savingTemplate ? "Saving…" : "Save template"}
            </button>
          </form>
        </details>
      ) : null}
      <section
        aria-labelledby="partner-cancellation-policy-title"
        className="rounded-xl border border-slate-200 bg-slate-50 p-4"
      >
        <h3
          id="partner-cancellation-policy-title"
          className="text-sm font-semibold text-slate-950"
        >
          Cancellation policy
        </h3>
        <p className="mt-1 text-sm leading-6 text-slate-700">
          {cancellation.policySource === "launch_default"
            ? `The current portal policy uses a ${cancellation.cutoffMinutes / 60}-hour cutoff.`
            : `This account uses a ${cancellation.cutoffMinutes / 60}-hour cutoff.`}{" "}
          {cancellation.reason.label}
        </p>
        {cancellationDeadline ? (
          <p className="mt-1 text-sm leading-6 text-slate-700">
            Direct-cancellation deadline: {cancellationDeadline} (
            {cancellation.timezone}).
          </p>
        ) : null}
        <p
          id="partner-cancellation-consequence"
          className="mt-1 text-sm font-medium leading-6 text-slate-800"
        >
          {cancellation.consequence.label}
        </p>
      </section>
      {hasCancellationAction ? (
        <details
          className={cn(
            "rounded-xl p-4",
            canRequestCancellationReview
              ? "border border-amber-300 bg-amber-50/70"
              : "border border-rose-200 bg-rose-50/60",
          )}
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg font-semibold text-rose-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 [&::-webkit-details-marker]:hidden">
            <Ban className="h-4 w-4" aria-hidden="true" />
            {canRequestCancellationReview
              ? "Request cancellation review"
              : "Cancel this job"}
          </summary>
          <form
            onSubmit={(event) => void cancel(event)}
            className="mt-3 space-y-3"
            data-partner-analytics="job_cancel"
          >
            <label htmlFor="partner-job-cancel-reason">
              <span className="text-sm font-semibold text-slate-700">
                Reason for cancellation
              </span>
              <textarea
                id="partner-job-cancel-reason"
                name="reason"
                required
                minLength={5}
                maxLength={1_000}
                rows={3}
                className={partnerFieldClass}
                placeholder="Tell Stonegate why this service is no longer needed."
                aria-describedby="partner-cancellation-consequence"
              />
            </label>
            <button
              type="submit"
              disabled={canceling}
              className={cn(
                partnerSecondaryButtonClass,
                "border-rose-300 text-rose-800 hover:bg-rose-100",
              )}
            >
              {canceling ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Ban className="h-4 w-4" aria-hidden="true" />
              )}
              {canceling
                ? "Submitting…"
                : canRequestCancellationReview
                  ? "Send review request"
                  : "Confirm cancellation"}
            </button>
          </form>
        </details>
      ) : null}
      {message ? (
        <PartnerNotice tone={message.tone}>{message.text}</PartnerNotice>
      ) : null}
    </div>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  Ban,
  CalendarClock,
  Copy,
  FilePenLine,
  LoaderCircle,
  Save,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@myst-os/ui";
import {
  findPartnerJobAction,
  partnerJobActionBlockers,
  type PartnerJobActionAvailability,
  type PartnerJobActionKey,
} from "../lib/job-action-availability";
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
  directCancellationEnabled: boolean;
  lateCancellationDisposition: "staff_review";
  consequence: {
    code: string;
    label: string;
    automaticFeeMinor: null;
  };
  policySource: "launch_default" | "configured" | "unconfigured";
  policyRevision: number | null;
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

function jobActionLabel(action: PartnerJobActionKey): string {
  const labels: Record<PartnerJobActionKey, string> = {
    request_change: "Scope change",
    reschedule: "Schedule change",
    edit_references: "Reference change",
    cancel: "Cancellation",
    request_cancellation_review: "Cancellation review",
    message: "Job message",
    upload_media: "Photo upload",
    create_proof_share: "Proof sharing",
    duplicate: "Book again",
  };
  return labels[action];
}

export function PartnerJobActions({
  jobId,
  etag,
  allowedActions,
  actionAvailability,
  cancellation,
  references,
}: {
  jobId: string;
  etag: string | null;
  allowedActions: string[];
  actionAvailability: PartnerJobActionAvailability[];
  cancellation: PartnerCancellationDecision;
  references: {
    poNumber: string | null;
    costCenter: string | null;
    project: string | null;
  };
}) {
  const router = useRouter();
  const [canceling, setCanceling] = React.useState(false);
  const [duplicating, setDuplicating] = React.useState(false);
  const [savingTemplate, setSavingTemplate] = React.useState(false);
  const [requestingChange, setRequestingChange] = React.useState(false);
  const [updatingReferences, setUpdatingReferences] = React.useState(false);
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
  const rescheduleAvailability = findPartnerJobAction(
    actionAvailability,
    "reschedule",
  );
  const duplicateAvailability = findPartnerJobAction(
    actionAvailability,
    "duplicate",
  );
  const changeAvailability = findPartnerJobAction(
    actionAvailability,
    "request_change",
  );
  const referencesAvailability = findPartnerJobAction(
    actionAvailability,
    "edit_references",
  );
  const canReschedule =
    rescheduleAvailability?.allowed === true &&
    allowedActions.includes("reschedule") &&
    Boolean(etag);
  const canDuplicate =
    duplicateAvailability?.allowed === true &&
    allowedActions.includes("duplicate");
  const canRequestChange =
    changeAvailability?.allowed === true &&
    allowedActions.includes("request_change") &&
    Boolean(etag);
  const canEditReferences =
    referencesAvailability?.allowed === true &&
    allowedActions.includes("edit_references") &&
    Boolean(etag);
  const blockerKeys: PartnerJobActionKey[] = [
    "request_change",
    "reschedule",
    "edit_references",
    "duplicate",
  ];
  if (!cancellation.action) blockerKeys.push("cancel");
  const blockers = partnerJobActionBlockers(actionAvailability, blockerKeys);
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
        automaticFeeApplied: false;
        jobRemainsScheduled: boolean;
        consequence: string;
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

  const requestJobChange = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (!etag) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (key: string): string => {
      const value = data.get(key);
      return typeof value === "string" ? value.trim() : "";
    };
    const reason = text("reason");
    const description = text("description");
    const crewInstructions = text("crewInstructions");
    const accessDetails = text("accessDetails");
    const onSiteName = text("onSiteName");
    const onSitePhone = text("onSitePhone");
    const onSiteEmail = text("onSiteEmail");
    const materiality = {
      price: data.get("impactPrice") === "on",
      schedule: data.get("impactSchedule") === "on",
      service: data.get("impactService") === "on",
      quantity: data.get("impactQuantity") === "on",
      hazards: data.get("impactHazards") === "on",
      proof: data.get("impactProof") === "on",
    };
    const hasProposedField = Boolean(
      description ||
        crewInstructions ||
        accessDetails ||
        onSiteName ||
        onSitePhone ||
        onSiteEmail,
    );
    if (
      reason.length < 5 ||
      (!hasProposedField && !Object.values(materiality).some(Boolean))
    ) {
      setMessage({
        tone: "error",
        text: "Add a short reason and at least one proposed detail or impact.",
      });
      return;
    }
    setRequestingChange(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      changeRequest: {
        id: string;
        state: string;
        consequence: string;
      };
    }>(`jobs/${encodeURIComponent(jobId)}/change-requests`, {
      method: "POST",
      headers: {
        "If-Match": etag,
        "Idempotency-Key": createPortalOperationKey("job-change-request"),
      },
      body: JSON.stringify({
        reason,
        proposedChanges: {
          ...(description ? { description } : {}),
          ...(crewInstructions ? { crewInstructions } : {}),
          ...(accessDetails ? { accessDetails } : {}),
          ...(onSiteName || onSitePhone || onSiteEmail
            ? {
                onSiteContact: {
                  ...(onSiteName ? { name: onSiteName } : {}),
                  ...(onSitePhone ? { phone: onSitePhone } : {}),
                  ...(onSiteEmail ? { email: onSiteEmail } : {}),
                },
              }
            : {}),
          materiality,
        },
      }),
    }).catch(() => null);
    setRequestingChange(false);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text:
          result?.error.message ??
          "The job change request was not saved. Refresh and try again.",
      });
      return;
    }
    form.reset();
    setMessage({
      tone: "success",
      text: result.data.changeRequest.consequence,
    });
    router.refresh();
  };

  const updateReferences = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (!etag) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const nullableText = (key: string): string | null => {
      const value = data.get(key);
      if (typeof value !== "string") return null;
      return value.trim() || null;
    };
    setUpdatingReferences(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      job: { revision: number };
    }>(`jobs/${encodeURIComponent(jobId)}/references`, {
      method: "PATCH",
      headers: {
        "If-Match": etag,
        "Idempotency-Key": createPortalOperationKey("job-references"),
      },
      body: JSON.stringify({
        poNumber: nullableText("poNumber"),
        costCenter: nullableText("costCenter"),
        projectReference: nullableText("projectReference"),
      }),
    }).catch(() => null);
    setUpdatingReferences(false);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text:
          result?.error.message ??
          "The commercial references were not saved. Refresh and try again.",
      });
      return;
    }
    setMessage({
      tone: "success",
      text: "The PO, cost center, and project reference were updated.",
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
    const rawName = new FormData(event.currentTarget).get("templateName");
    const name = typeof rawName === "string" ? rawName.trim() : "";
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
      {rescheduleAvailability?.allowed &&
      rescheduleAvailability.reason.code === "available_review_required" ? (
        <PartnerNotice tone="warning">
          {rescheduleAvailability.reason.label}
        </PartnerNotice>
      ) : null}
      {!etag &&
      actionAvailability.some(
        (entry) =>
          entry.allowed &&
          [
            "request_change",
            "reschedule",
            "edit_references",
            "cancel",
            "request_cancellation_review",
          ].includes(entry.action),
      ) ? (
        <PartnerNotice tone="warning">
          Refresh this job to load its latest revision before changing it.
        </PartnerNotice>
      ) : null}
      {canRequestChange ? (
        <details className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden">
            <FilePenLine className="h-4 w-4" aria-hidden="true" />
            Request a job change
          </summary>
          <p
            id="partner-job-change-consequence"
            className="mt-2 text-sm leading-6 text-slate-700"
          >
            Stonegate must review this request. Submitting it does not change or
            promise acceptance of the current price, schedule, service, proof
            requirements, or job details. Sensitive changes require a separate
            change order.
          </p>
          <form
            onSubmit={(event) => void requestJobChange(event)}
            className="mt-3 space-y-4"
            data-partner-analytics="job_change_request"
          >
            <label htmlFor="partner-job-change-reason">
              <span className="text-sm font-semibold text-slate-700">
                What needs to change?
              </span>
              <textarea
                id="partner-job-change-reason"
                name="reason"
                required
                minLength={5}
                maxLength={1_000}
                rows={3}
                className={partnerFieldClass}
                aria-describedby="partner-job-change-consequence"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label htmlFor="partner-job-change-description">
                <span className="text-sm font-semibold text-slate-700">
                  Public scope note
                </span>
                <textarea
                  id="partner-job-change-description"
                  name="description"
                  maxLength={4_000}
                  rows={3}
                  className={partnerFieldClass}
                />
              </label>
              <label htmlFor="partner-job-change-crew-instructions">
                <span className="text-sm font-semibold text-slate-700">
                  Crew instructions
                </span>
                <textarea
                  id="partner-job-change-crew-instructions"
                  name="crewInstructions"
                  maxLength={2_000}
                  rows={3}
                  className={partnerFieldClass}
                />
              </label>
              <label htmlFor="partner-job-change-access">
                <span className="text-sm font-semibold text-slate-700">
                  Job access details
                </span>
                <textarea
                  id="partner-job-change-access"
                  name="accessDetails"
                  maxLength={2_000}
                  rows={3}
                  className={partnerFieldClass}
                />
              </label>
              <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
                <legend className="px-1 text-sm font-semibold text-slate-700">
                  On-site contact
                </legend>
                <div className="space-y-2">
                  <label htmlFor="partner-job-change-contact-name">
                    <span className="text-sm text-slate-700">Name</span>
                    <input
                      id="partner-job-change-contact-name"
                      name="onSiteName"
                      maxLength={160}
                      className={partnerFieldClass}
                    />
                  </label>
                  <label htmlFor="partner-job-change-contact-phone">
                    <span className="text-sm text-slate-700">Phone</span>
                    <input
                      id="partner-job-change-contact-phone"
                      name="onSitePhone"
                      type="tel"
                      maxLength={40}
                      className={partnerFieldClass}
                    />
                  </label>
                  <label htmlFor="partner-job-change-contact-email">
                    <span className="text-sm text-slate-700">Email</span>
                    <input
                      id="partner-job-change-contact-email"
                      name="onSiteEmail"
                      type="email"
                      maxLength={254}
                      className={partnerFieldClass}
                    />
                  </label>
                </div>
              </fieldset>
            </div>
            <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
              <legend className="px-1 text-sm font-semibold text-slate-800">
                Could this affect any of these?
              </legend>
              <p className="text-sm leading-6 text-slate-600">
                Select every impact so Stonegate can route the request safely.
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {[
                  ["impactPrice", "Price or payment"],
                  ["impactSchedule", "Schedule or arrival window"],
                  ["impactService", "Service type"],
                  ["impactQuantity", "Quantity or volume"],
                  ["impactHazards", "Hazards or site safety"],
                  ["impactProof", "Photos or proof requirements"],
                ].map(([name, label]) => (
                  <label
                    key={name}
                    className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm text-slate-700"
                  >
                    <input
                      type="checkbox"
                      name={name}
                      className="h-5 w-5 rounded border-slate-300 text-primary-700 focus:ring-primary-500"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <button
              type="submit"
              disabled={requestingChange}
              className={partnerPrimaryButtonClass}
            >
              {requestingChange ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <FilePenLine className="h-4 w-4" aria-hidden="true" />
              )}
              {requestingChange ? "Submitting…" : "Send change request"}
            </button>
          </form>
        </details>
      ) : null}
      {canEditReferences ? (
        <details className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden">
            <FilePenLine className="h-4 w-4" aria-hidden="true" />
            Edit commercial references
          </summary>
          <p
            id="partner-job-references-help"
            className="mt-2 text-sm leading-6 text-slate-600"
          >
            This changes only the PO, cost center, and project reference. It
            does not alter price, invoices, scope, or schedule.
          </p>
          <form
            onSubmit={(event) => void updateReferences(event)}
            className="mt-3 space-y-3"
            data-partner-analytics="job_reference_update"
          >
            <label htmlFor="partner-job-po-number">
              <span className="text-sm font-semibold text-slate-700">
                PO number
              </span>
              <input
                id="partner-job-po-number"
                name="poNumber"
                defaultValue={references.poNumber ?? ""}
                maxLength={160}
                className={partnerFieldClass}
                aria-describedby="partner-job-references-help"
              />
            </label>
            <label htmlFor="partner-job-cost-center">
              <span className="text-sm font-semibold text-slate-700">
                Cost center
              </span>
              <input
                id="partner-job-cost-center"
                name="costCenter"
                defaultValue={references.costCenter ?? ""}
                maxLength={160}
                className={partnerFieldClass}
              />
            </label>
            <label htmlFor="partner-job-project-reference">
              <span className="text-sm font-semibold text-slate-700">
                Project reference
              </span>
              <input
                id="partner-job-project-reference"
                name="projectReference"
                defaultValue={references.project ?? ""}
                maxLength={160}
                className={partnerFieldClass}
              />
            </label>
            <button
              type="submit"
              disabled={updatingReferences}
              className={partnerSecondaryButtonClass}
            >
              {updatingReferences ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Save className="h-4 w-4" aria-hidden="true" />
              )}
              {updatingReferences ? "Saving…" : "Save references"}
            </button>
          </form>
        </details>
      ) : null}
      {blockers.length ? (
        <details className="rounded-xl border border-slate-200 bg-white p-4">
          <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-lg text-sm font-semibold text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden">
            Why some actions are unavailable
          </summary>
          <ul className="mt-2 space-y-2 text-sm leading-6 text-slate-600">
            {blockers.map((entry) => (
              <li key={entry.action}>
                <span className="font-semibold text-slate-800">
                  {jobActionLabel(entry.action)}:
                </span>{" "}
                {entry.reason.label}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
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
          {cancellation.policySource === "unconfigured"
            ? "This account’s persisted policy is unavailable, so confirmed-job changes require staff review."
            : cancellation.directCancellationEnabled
              ? `This account uses a ${cancellation.cutoffMinutes / 60}-hour cutoff for direct confirmed-job changes.`
              : "This account requires staff review for every confirmed-job cancellation or schedule change."}{" "}
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
          {cancellation.consequence.label} Schedule changes at or after the
          cutoff also leave the existing appointment in place while Stonegate
          reviews the requested window.
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

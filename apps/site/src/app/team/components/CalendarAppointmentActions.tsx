"use client";

import React from "react";
import { previewPartnerServiceArrival } from "../actions/partner-service-reviews";
import { useRouter } from "next/navigation";
import {
  isTeamMutationSuccessEnvelope,
  readTeamMutationError,
  readTeamMutationException,
} from "../lib/mutation-feedback";
import { formatCalendarDayKey, TEAM_TIME_ZONE } from "../lib/calendar-time";
import { requestedPartnerDate } from "../lib/partner-request-presentation";
import { readScheduleWarning } from "../lib/schedule-warning";
import { CrewPayoutSelector } from "./CrewPayoutSelector";
import type { SavedCrewPayout } from "../lib/crew-payout-form";
import { StaffScheduleResourcePicker } from "./StaffScheduleResourcePicker";
import { TEAM_INPUT_COMPACT, teamButtonClass } from "./team-ui";

type Props = {
  appointmentId: string;
  appointmentType: string | null;
  serviceType?: string | null;
  crewMembers?: SavedCrewPayout[];
  start: string;
  version: string | null;
  quotedTotalCents: number | null;
  finalTotalCents: number | null;
  isQuoteOnly: boolean;
  canEditStatus: boolean;
  canUpdateAppointments: boolean;
  canCollectPayments: boolean;
  canSendCustomerMessages: boolean;
  canManageAppointmentMedia: boolean;
  canOverrideScheduleConflicts: boolean;
  teamMembers: Array<{ id: string; name: string }>;
  scheduleOnly?: boolean;
  confirmPartnerService?: boolean;
  partnerRequest?: { id: string; accountId: string };
  partnerPreferredWindows?: readonly {
    localDate: string;
    timeOfDay: string;
    timezone?: string;
  }[];
  onScheduleEdited?: () => void;
  correctionOnly?: boolean;
  onScheduled?: (warning: string | null) => void;
};

type Feedback = {
  tone: "success" | "warning" | "error";
  message: string;
} | null;

type SuccessPayload = {
  ok?: unknown;
  version?: unknown;
  calendarSync?: unknown;
  scheduleWarning?: unknown;
  note?: unknown;
  data?: unknown;
  receipt?: unknown;
};

type ScheduleConflictPayload = {
  code: string;
  message: string;
  requiredAcknowledgement: string;
  conflictFingerprint: string;
  conflicts: Array<{
    id: string;
    title: string;
    startAt: string;
    endAt: string;
  }>;
};

function makeIdempotencyKey(): string {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2).padEnd(16, "0");
  return `calendar-${Date.now()}-${randomPart}`;
}

function formatEasternTimeInput(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US-u-hc-h23", {
    timeZone: TEAM_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  return hour && minute ? `${hour}:${minute}` : "";
}

function readVersion(payload: SuccessPayload): string | null {
  if (typeof payload.version === "string" && payload.version.trim()) {
    return payload.version;
  }
  if (payload.data && typeof payload.data === "object") {
    const value = (payload.data as Record<string, unknown>)["version"];
    if (typeof value === "string" && value.trim()) return value;
  }
  if (payload.receipt && typeof payload.receipt === "object") {
    const value = (payload.receipt as Record<string, unknown>)["version"];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isExactStatusMutationReceipt(
  payload: SuccessPayload | null,
  expected: {
    appointmentId: string;
    status: string;
    customerNotification: "requested" | "not_requested";
    reviewRequest: "requested" | "not_requested";
  },
): boolean {
  if (!isTeamMutationSuccessEnvelope(payload) || !isRecord(payload)) {
    return false;
  }
  const data = isRecord(payload["data"]) ? payload["data"] : null;
  const receipt = isRecord(payload["receipt"]) ? payload["receipt"] : null;
  return Boolean(
    data &&
      receipt &&
      data["appointmentId"] === expected.appointmentId &&
      data["status"] === expected.status &&
      typeof data["version"] === "string" &&
      data["version"].length > 0 &&
      (data["calendarSync"] === "requested" ||
        data["calendarSync"] === "not_required") &&
      data["customerNotification"] === expected.customerNotification &&
      data["reviewRequest"] === expected.reviewRequest &&
      receipt["entityType"] === "appointment" &&
      receipt["entityId"] === expected.appointmentId &&
      receipt["version"] === data["version"],
  );
}

function mutationFingerprint(formData: FormData): string {
  const entries: Array<[string, string]> = [];
  formData.forEach((value, key) => {
    entries.push([
      key,
      typeof value === "string"
        ? value
        : `${value.name}:${value.size}:${value.type}`,
    ]);
  });
  return JSON.stringify(
    entries.sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
    ),
  );
}

export function CalendarAppointmentActions({
  appointmentId,
  appointmentType,
  serviceType,
  crewMembers,
  start,
  version,
  quotedTotalCents,
  finalTotalCents,
  isQuoteOnly,
  canEditStatus,
  canUpdateAppointments,
  canCollectPayments,
  canSendCustomerMessages,
  canManageAppointmentMedia,
  canOverrideScheduleConflicts,
  teamMembers,
  scheduleOnly = false,
  confirmPartnerService = false,
  partnerRequest,
  partnerPreferredWindows = [],
  onScheduleEdited,
  correctionOnly = false,
  onScheduled,
}: Props): React.ReactElement {
  const router = useRouter();
  const [currentVersion, setCurrentVersion] = React.useState(version);
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<Feedback>(null);
  const [noteDraft, setNoteDraft] = React.useState("");
  const [scheduleConflict, setScheduleConflict] =
    React.useState<ScheduleConflictPayload | null>(null);
  const mutationAttemptsRef = React.useRef(
    new Map<string, { fingerprint: string; key: string }>(),
  );
  const noteFieldId = React.useId();
  const crewConfirmationFieldId = React.useId();
  const reviewRequestFieldId = React.useId();
  const scheduleTimezoneId = React.useId();
  const requestedDatesId = React.useId();
  const plannedTimeRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => setCurrentVersion(version), [version]);

  const completeDefaultValue =
    finalTotalCents !== null
      ? (finalTotalCents / 100).toFixed(2)
      : quotedTotalCents !== null
        ? (quotedTotalCents / 100).toFixed(2)
        : "";
  const defaultDate = formatCalendarDayKey(new Date(start));
  const defaultTime = formatEasternTimeInput(start);

  const [previewDate, setPreviewDate] = React.useState(defaultDate);
  const [previewTime, setPreviewTime] = React.useState(defaultTime);
  const [previewRetry, setPreviewRetry] = React.useState(0);
  const [arrivalPreview, setArrivalPreview] = React.useState<{
    input: string;
    label: string;
    error: string;
  } | null>(null);
  const previewInput = `${previewDate}:${previewTime}`;
  const previewJobId = partnerRequest?.id;
  const previewAccountId = partnerRequest?.accountId;
  React.useEffect(() => {
    if (!confirmPartnerService || !previewJobId || !previewAccountId) return;
    let current = true;
    const timer = setTimeout(() => {
      if (!previewDate || !previewTime) return;
      void previewPartnerServiceArrival({
        id: previewJobId,
        accountId: previewAccountId,
        preferredDate: previewDate,
        startTime: previewTime,
      })
        .then((result) => {
          if (!current) return;
          if (!result.ok) {
            setArrivalPreview({
              input: previewInput,
              label: "",
              error: result.message,
            });
            return;
          }
          try {
            const format = new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: result.timezone,
            });
            const arrivalStart = new Date(result.arrivalStartAt);
            const arrivalEnd = new Date(result.arrivalEndAt);
            const zone = new Intl.DateTimeFormat("en-US", {
              timeZone: result.timezone,
              timeZoneName: "short",
            })
              .formatToParts(arrivalStart)
              .find((part) => part.type === "timeZoneName")?.value;
            setArrivalPreview({
              input: previewInput,
              label: `${format.formatRange(arrivalStart, arrivalEnd)} ${zone ?? result.timezone}`,
              error: "",
            });
          } catch {
            setArrivalPreview({
              input: previewInput,
              label: "",
              error: "The arrival window could not be verified. Try again.",
            });
          }
        })
        .catch(() => {
          if (current)
            setArrivalPreview({
              input: previewInput,
              label: "",
              error: "The arrival window could not be reached. Try again.",
            });
        });
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [
    confirmPartnerService,
    previewJobId,
    previewAccountId,
    previewDate,
    previewTime,
    previewInput,
    previewRetry,
  ]);
  const arrivalReady =
    !confirmPartnerService ||
    (arrivalPreview?.input === previewInput &&
      !!arrivalPreview.label &&
      !arrivalPreview.error);

  function chooseRequestedDate(localDate: string): void {
    if (pendingAction) return;
    setPreviewDate(localDate);
    setArrivalPreview(null);
    setScheduleConflict(null);
    setPreviewRetry((value) => value + 1);
    onScheduleEdited?.();
    plannedTimeRef.current?.focus();
  }

  async function submitMutation(
    form: HTMLFormElement,
    actionName: string,
    successMessage: string,
    failureMessage: string,
    confirmation?: string,
  ): Promise<void> {
    if (pendingAction) return;
    if (confirmation && !window.confirm(confirmation)) return;

    const formData = new FormData(form);
    if (currentVersion) formData.set("expectedVersion", currentVersion);
    const fingerprint = mutationFingerprint(formData);
    const previousAttempt = mutationAttemptsRef.current.get(actionName);
    const idempotencyKey =
      previousAttempt?.fingerprint === fingerprint
        ? previousAttempt.key
        : makeIdempotencyKey();
    mutationAttemptsRef.current.set(actionName, {
      fingerprint,
      key: idempotencyKey,
    });
    setPendingAction(actionName);
    setFeedback(null);

    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: formData,
      });
      if (!response.ok) {
        if (actionName === "reschedule") {
          const conflictPayload = (await response
            .clone()
            .json()
            .catch(() => null)) as Record<string, unknown> | null;
          const code =
            typeof conflictPayload?.["code"] === "string"
              ? conflictPayload["code"]
              : typeof conflictPayload?.["error"] === "string"
                ? conflictPayload["error"]
                : "";
          const conflicts = Array.isArray(conflictPayload?.["conflicts"])
            ? conflictPayload["conflicts"].flatMap((entry) => {
                if (!entry || typeof entry !== "object") return [];
                const record = entry as Record<string, unknown>;
                return typeof record["id"] === "string" &&
                  typeof record["title"] === "string" &&
                  typeof record["startAt"] === "string" &&
                  typeof record["endAt"] === "string"
                  ? [
                      {
                        id: record["id"],
                        title: record["title"],
                        startAt: record["startAt"],
                        endAt: record["endAt"],
                      },
                    ]
                  : [];
              })
            : [];
          const requiredAcknowledgement =
            typeof conflictPayload?.["requiredAcknowledgement"] === "string"
              ? conflictPayload["requiredAcknowledgement"]
              : "";
          const conflictFingerprint =
            typeof conflictPayload?.["conflictFingerprint"] === "string"
              ? conflictPayload["conflictFingerprint"]
              : "";
          if (
            code.startsWith("schedule_conflict") &&
            conflicts.length > 0 &&
            requiredAcknowledgement &&
            /^[0-9a-f]{64}$/u.test(conflictFingerprint)
          ) {
            setScheduleConflict({
              code,
              message:
                typeof conflictPayload?.["message"] === "string"
                  ? conflictPayload["message"]
                  : "That time conflicts with another scheduled job.",
              requiredAcknowledgement,
              conflictFingerprint,
              conflicts,
            });
          }
        }
        setFeedback({
          tone: "error",
          message: await readTeamMutationError(response, failureMessage),
        });
        return;
      }

      const payload = (await response
        .json()
        .catch(() => null)) as SuccessPayload | null;
      const isStatusAction = ["complete", "no_show", "canceled"].includes(
        actionName,
      );
      const submittedStatus = formData.get("status");
      const expectedStatus =
        typeof submittedStatus === "string" ? submittedStatus : "";
      const customerNotificationRequested =
        formData.get("sendCustomerNotification") === "on";
      const reviewRequestRequested = formData.get("sendReviewRequest") === "on";
      const confirmed = isStatusAction
        ? isExactStatusMutationReceipt(payload, {
            appointmentId,
            status: expectedStatus,
            customerNotification: customerNotificationRequested
              ? "requested"
              : "not_requested",
            reviewRequest: reviewRequestRequested
              ? "requested"
              : "not_requested",
          })
        : actionName === "note"
          ? isTeamMutationSuccessEnvelope(payload)
          : Boolean(payload && payload.ok === true);
      if (!payload || !confirmed) {
        setFeedback({
          tone: "error",
          message: `${failureMessage}. The service response could not confirm the change. Keep your input and refresh before retrying.`,
        });
        return;
      }

      const nextVersion = readVersion(payload);
      if (nextVersion) setCurrentVersion(nextVersion);
      mutationAttemptsRef.current.delete(actionName);
      const mutationData = isRecord(payload.data) ? payload.data : null;
      const scheduleWarning = readScheduleWarning(
        payload.scheduleWarning ?? mutationData?.["scheduleWarning"],
      );
      const calendarQueued = isStatusAction
        ? mutationData?.["calendarSync"] === "requested"
        : payload.calendarSync === "requested";
      const needsReconciliation =
        !isStatusAction && payload.calendarSync === "reconciliation_required";
      const effectCopy = customerNotificationRequested
        ? " Customer notice requested; delivery is not yet confirmed."
        : reviewRequestRequested
          ? " Review request queued; delivery is not yet confirmed."
          : isStatusAction
            ? " Customer was not notified."
            : "";
      const message = calendarQueued
        ? `${successMessage} in the CRM.${effectCopy} Google Calendar cleanup is queued; keep this view available until the linked event disappears.`
        : needsReconciliation
          ? `${successMessage} in the CRM.${effectCopy} Google Calendar did not confirm the change. Keep the appointment open and ask an owner to reconcile the calendar.`
          : `${successMessage}${effectCopy}`;
      setFeedback({
        tone:
          calendarQueued || needsReconciliation || scheduleWarning
            ? "warning"
            : "success",
        message: scheduleWarning
          ? `${message} Warning: ${scheduleWarning}`
          : message,
      });
      if (actionName === "note") setNoteDraft("");
      if (actionName === "reschedule") {
        setScheduleConflict(null);
        onScheduled?.(scheduleWarning);
      }
      router.refresh();
    } catch (error) {
      setFeedback({
        tone: "error",
        message: readTeamMutationException(error, failureMessage),
      });
    } finally {
      setPendingAction(null);
    }
  }

  const feedbackClass =
    feedback?.tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : feedback?.tone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-rose-200 bg-rose-50 text-rose-900";

  return (
    <div className={confirmPartnerService ? "space-y-3" : "mt-3 space-y-3"}>
      {feedback ? (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          aria-live={feedback.tone === "error" ? "assertive" : "polite"}
          className={`rounded-xl border px-3 py-2 text-sm ${feedbackClass}`}
        >
          {feedback.message}
        </div>
      ) : null}

      {canEditStatus ||
      correctionOnly ||
      (scheduleOnly && canUpdateAppointments) ? (
        <div
          className={
            confirmPartnerService
              ? "space-y-3"
              : "space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3"
          }
        >
          <div
            className={
              confirmPartnerService
                ? "text-base font-semibold text-slate-900"
                : "text-[11px] font-semibold uppercase tracking-wide text-slate-500"
            }
          >
            {scheduleOnly
              ? confirmPartnerService
                ? "Confirm schedule"
                : "Schedule service in the CRM"
              : correctionOnly
                ? "Correct crew pay"
                : "Update appointment"}
          </div>

          {!scheduleOnly ? (
            <>
              {isQuoteOnly ? (
                <form
                  action="/api/team/appointments/status"
                  onSubmit={(event) => {
                    if (event.defaultPrevented) return;
                    event.preventDefault();
                    void submitMutation(
                      event.currentTarget,
                      "complete",
                      "Quote visit marked done.",
                      "Unable to complete quote visit",
                    );
                  }}
                >
                  <input
                    type="hidden"
                    name="appointmentId"
                    value={appointmentId}
                  />
                  <input
                    type="hidden"
                    name="appointmentType"
                    value={appointmentType ?? ""}
                  />
                  <input type="hidden" name="status" value="completed" />
                  <div className="flex flex-col gap-3">
                    <p className="text-sm text-slate-600">
                      Mark this in-person quote visit as done. The customer will
                      not be notified by this status change.
                    </p>
                    <button
                      type="submit"
                      disabled={pendingAction !== null}
                      className={`${teamButtonClass("primary", "sm")} w-full`}
                    >
                      {pendingAction === "complete" ? "Saving…" : "Mark done"}
                    </button>
                  </div>
                </form>
              ) : canCollectPayments ? (
                <form
                  action="/api/team/appointments/status"
                  className="grid min-w-0 grid-cols-1 gap-3"
                  onSubmit={(event) => {
                    if (event.defaultPrevented) return;
                    event.preventDefault();
                    void submitMutation(
                      event.currentTarget,
                      "complete",
                      correctionOnly
                        ? "Crew pay corrected."
                        : "Job completed with the confirmed total and crew.",
                      "Unable to complete job",
                    );
                  }}
                >
                  <input
                    type="hidden"
                    name="appointmentId"
                    value={appointmentId}
                  />
                  <input
                    type="hidden"
                    name="appointmentType"
                    value={appointmentType ?? ""}
                  />
                  <input type="hidden" name="status" value="completed" />
                  <input
                    type="hidden"
                    name="expectedFinalTotalCents"
                    value={
                      finalTotalCents === null
                        ? "null"
                        : String(finalTotalCents)
                    }
                  />

                  <label className="flex flex-col gap-1 text-sm text-slate-700">
                    <span>Final job total</span>
                    <input
                      readOnly={correctionOnly}
                      name="finalTotal"
                      type="number"
                      min={0}
                      step="0.01"
                      required
                      defaultValue={completeDefaultValue}
                      placeholder="e.g. 350.00"
                      className={TEAM_INPUT_COMPACT}
                    />
                  </label>

                  <CrewPayoutSelector
                    key={`${appointmentId}:${version ?? ""}`}
                    serviceType={serviceType}
                    initialCrewMembers={crewMembers}
                    teamMembers={teamMembers}
                    stacked
                  />

                  {canManageAppointmentMedia && !correctionOnly ? (
                    <details className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                      <summary className="min-h-11 cursor-pointer py-2 font-semibold">
                        Missing-proof exception
                      </summary>
                      <label
                        className="mt-2 block"
                        htmlFor="calendar-proof-override-reason"
                      >
                        <span className="block text-sm leading-6">
                          Use only when required partner proof cannot be
                          captured. The reason is recorded in the job history.
                        </span>
                        <textarea
                          id="calendar-proof-override-reason"
                          name="proofOverrideReason"
                          minLength={10}
                          maxLength={500}
                          rows={3}
                          className={`${TEAM_INPUT_COMPACT} mt-2 w-full`}
                          placeholder="Explain why the required proof cannot be provided"
                        />
                      </label>
                    </details>
                  ) : null}

                  <label
                    htmlFor={crewConfirmationFieldId}
                    className="flex min-h-11 min-w-0 scroll-mt-24 cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                  >
                    <input
                      id={crewConfirmationFieldId}
                      type="checkbox"
                      name="crewConfirmed"
                      value="yes"
                      required
                      className="mt-0.5 h-5 w-5 shrink-0 scroll-mt-24 rounded border-slate-300"
                    />
                    <span className="min-w-0 break-words">
                      I confirmed the final total and everyone who worked this
                      job.
                    </span>
                  </label>

                  {canSendCustomerMessages && !correctionOnly ? (
                    <label
                      htmlFor={reviewRequestFieldId}
                      className="flex min-h-11 min-w-0 scroll-mt-24 cursor-pointer items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900"
                    >
                      <input
                        id={reviewRequestFieldId}
                        type="checkbox"
                        name="sendReviewRequest"
                        className="mt-0.5 h-5 w-5 shrink-0 scroll-mt-24 rounded border-sky-300"
                      />
                      <span className="min-w-0 break-words">
                        Request a review message after this completion. Safe
                        default is off; checking this queues a message but does
                        not confirm delivery.
                      </span>
                    </label>
                  ) : (
                    <p className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                      The job will be completed without a review message.
                      Messaging permission is required to request one.
                    </p>
                  )}

                  <div>
                    <button
                      type="submit"
                      disabled={pendingAction !== null}
                      className={`${teamButtonClass("primary", "sm")} w-full`}
                    >
                      {pendingAction === "complete"
                        ? "Saving…"
                        : correctionOnly
                          ? "Save crew correction"
                          : "Complete job"}
                    </button>
                  </div>
                </form>
              ) : (
                <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  You can update this appointment, but completing a job total
                  requires payment access.
                </p>
              )}

              {!correctionOnly ? (
                <div className="grid grid-cols-1 gap-3">
                  <form
                    action="/api/team/appointments/status"
                    className="space-y-2"
                    onSubmit={(event) => {
                      if (event.defaultPrevented) return;
                      event.preventDefault();
                      void submitMutation(
                        event.currentTarget,
                        "no_show",
                        "Appointment marked no-show.",
                        "Unable to mark no-show",
                        "Mark this appointment as a no-show? This changes downstream scheduling and reporting.",
                      );
                    }}
                  >
                    <input
                      type="hidden"
                      name="appointmentId"
                      value={appointmentId}
                    />
                    <input
                      type="hidden"
                      name="appointmentType"
                      value={appointmentType ?? ""}
                    />
                    <input type="hidden" name="status" value="no_show" />
                    <p className="text-xs text-slate-600">
                      The customer will not be notified by this status change.
                    </p>
                    <button
                      type="submit"
                      disabled={pendingAction !== null}
                      className={`${teamButtonClass("secondary", "sm")} w-full`}
                    >
                      {pendingAction === "no_show" ? "Saving…" : "Mark no-show"}
                    </button>
                  </form>

                  <form
                    action="/api/team/appointments/status"
                    className="space-y-2"
                    onSubmit={(event) => {
                      if (event.defaultPrevented) return;
                      event.preventDefault();
                      void submitMutation(
                        event.currentTarget,
                        "canceled",
                        "Appointment canceled.",
                        "Unable to cancel appointment",
                        "Cancel this appointment? Linked Google Calendar cleanup will be queued. The customer is notified only when the notice checkbox is selected.",
                      );
                    }}
                  >
                    <input
                      type="hidden"
                      name="appointmentId"
                      value={appointmentId}
                    />
                    <input
                      type="hidden"
                      name="appointmentType"
                      value={appointmentType ?? ""}
                    />
                    <input type="hidden" name="status" value="canceled" />
                    {canSendCustomerMessages ? (
                      <label className="flex min-h-11 items-start gap-3 rounded-xl border border-rose-200 bg-white px-3 py-2 text-sm text-rose-900">
                        <input
                          type="checkbox"
                          name="sendCustomerNotification"
                          className="mt-0.5 h-5 w-5 rounded border-rose-300"
                        />
                        <span>
                          Send a cancellation notice. Safe default is off;
                          delivery is tracked separately in Inbox.
                        </span>
                      </label>
                    ) : (
                      <p className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                        The customer will not be notified. Messaging permission
                        is required to send a cancellation notice.
                      </p>
                    )}
                    <button
                      type="submit"
                      disabled={pendingAction !== null}
                      className={`${teamButtonClass("danger", "sm")} w-full`}
                    >
                      {pendingAction === "canceled"
                        ? "Saving…"
                        : "Cancel appointment"}
                    </button>
                  </form>
                </div>
              ) : null}
            </>
          ) : null}
          {!correctionOnly ? (
            <form
              method="post"
              action="/api/team/appointments/reschedule"
              className={`grid min-w-0 grid-cols-1 gap-3 ${confirmPartnerService ? "" : "border-t border-slate-200 pt-3"}`}
              onSubmit={(event) => {
                if (event.defaultPrevented) return;
                event.preventDefault();
                if (!arrivalReady) return;
                void submitMutation(
                  event.currentTarget,
                  "reschedule",
                  scheduleOnly
                    ? "Service scheduled."
                    : "Appointment rescheduled.",
                  confirmPartnerService
                    ? "Unable to confirm service"
                    : "Unable to reschedule appointment",
                );
              }}
            >
              <input type="hidden" name="appointmentId" value={appointmentId} />
              {confirmPartnerService && partnerPreferredWindows.length ? (
                <fieldset
                  className="min-w-0 space-y-2"
                  disabled={pendingAction !== null}
                >
                  <legend className="mb-2 text-sm font-medium text-slate-700">
                    Client’s requested dates
                  </legend>
                  <ul className="space-y-2">
                    {partnerPreferredWindows.map((window, index) => {
                      const date = new Date(`${window.localDate}T12:00:00Z`);
                      const validDate =
                        /^\d{4}-\d{2}-\d{2}$/u.test(window.localDate) &&
                        Number.isFinite(date.getTime()) &&
                        date.toISOString().slice(0, 10) === window.localDate;
                      const otherTimezone = Boolean(
                        window.timezone && window.timezone !== TEAM_TIME_ZONE,
                      );
                      const explanation = otherTimezone
                        ? `Requested in ${window.timezone}. Enter the matching Eastern date below.`
                        : !validDate
                          ? "This requested date needs review. Enter a valid service date below."
                          : "";
                      const explanationId = `${requestedDatesId}-${index}`;
                      const preferenceId = `${explanationId}-preference`;
                      const dateLabel = `Use date: ${requestedPartnerDate(window.localDate)}`;
                      const selectedDate =
                        validDate &&
                        !otherTimezone &&
                        previewDate === window.localDate;
                      return (
                        <li
                          key={`${window.localDate}:${window.timeOfDay}:${index}`}
                        >
                          <button
                            type="button"
                            aria-label={dateLabel}
                            aria-pressed={selectedDate}
                            disabled={
                              !validDate ||
                              otherTimezone ||
                              pendingAction !== null
                            }
                            aria-describedby={`${preferenceId}${explanation ? ` ${explanationId}` : ""}`}
                            onClick={() =>
                              chooseRequestedDate(window.localDate)
                            }
                            className={`min-h-11 w-full rounded-lg border px-3 py-2 text-left text-sm font-medium text-teal-800 hover:border-teal-400 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:text-slate-500 ${selectedDate ? "border-teal-500 bg-teal-50" : "border-slate-200 bg-white"}`}
                          >
                            <span className="block">{dateLabel}</span>
                            <span
                              id={preferenceId}
                              className="mt-0.5 block text-xs font-normal text-slate-600"
                            >
                              {window.timeOfDay === "anytime"
                                ? "Client is flexible on time"
                                : `Client prefers ${window.timeOfDay.replaceAll("_", " ").toLowerCase()}`}
                            </span>
                          </button>
                          {explanation ? (
                            <p
                              id={explanationId}
                              className="mt-1 text-xs leading-5 text-slate-500"
                            >
                              {explanation}
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              ) : null}
              <div className="grid min-w-0 grid-cols-1 gap-3">
                <label className="flex flex-col gap-1 text-sm text-slate-700">
                  <span>
                    {confirmPartnerService ? "Service date" : "New date"}
                  </span>
                  <input
                    type="date"
                    name="preferredDate"
                    required
                    {...(confirmPartnerService
                      ? { value: previewDate, disabled: pendingAction !== null }
                      : { defaultValue: defaultDate })}
                    onChange={(event) => {
                      setScheduleConflict(null);
                      setPreviewDate(event.target.value);
                      if (confirmPartnerService) {
                        setArrivalPreview(null);
                        onScheduleEdited?.();
                      }
                    }}
                    className={TEAM_INPUT_COMPACT}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm text-slate-700">
                  <span>
                    {confirmPartnerService
                      ? "Planned start time"
                      : "Eastern time"}
                  </span>
                  <input
                    ref={plannedTimeRef}
                    type="time"
                    name="startTime"
                    step={confirmPartnerService ? 1800 : undefined}
                    required
                    {...(confirmPartnerService
                      ? { value: previewTime, disabled: pendingAction !== null }
                      : { defaultValue: defaultTime })}
                    aria-describedby={
                      confirmPartnerService ? scheduleTimezoneId : undefined
                    }
                    onChange={(event) => {
                      setScheduleConflict(null);
                      setPreviewTime(event.target.value);
                      if (confirmPartnerService) {
                        setArrivalPreview(null);
                        onScheduleEdited?.();
                      }
                    }}
                    className={TEAM_INPUT_COMPACT}
                  />
                </label>
              </div>
              {confirmPartnerService ? (
                <p id={scheduleTimezoneId} className="text-xs text-slate-500">
                  All times are Eastern.
                </p>
              ) : null}
              {confirmPartnerService ? (
                <div
                  role="status"
                  className="rounded-lg border border-teal-200 bg-teal-50 p-3 text-sm text-teal-950"
                >
                  <strong>Arrival window to confirm</strong>
                  <p className="mt-1">
                    {!previewDate || !previewTime
                      ? "Choose the service date and planned start time."
                      : arrivalPreview?.input === previewInput
                        ? arrivalPreview.error || arrivalPreview.label
                        : "Checking arrival window…"}
                  </p>
                  {arrivalReady ? (
                    <p className="mt-1 text-xs text-teal-800">
                      Two-hour arrival window. The service stays unconfirmed
                      until you select Confirm service.
                    </p>
                  ) : null}
                  {arrivalPreview?.input === previewInput &&
                  arrivalPreview.error ? (
                    <button
                      type="button"
                      className="mt-2 min-h-11 underline"
                      onClick={() => setPreviewRetry((value) => value + 1)}
                    >
                      Retry arrival preview
                    </button>
                  ) : null}
                </div>
              ) : null}
              <StaffScheduleResourcePicker
                key={appointmentId}
                appointmentId={appointmentId}
                disabled={pendingAction !== null}
                compact={confirmPartnerService}
                reveal={
                  Boolean(scheduleConflict) ||
                  (confirmPartnerService && feedback?.tone === "error")
                }
              />
              {scheduleConflict ? (
                <div
                  role="alert"
                  className="space-y-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-950"
                >
                  <div className="font-semibold">Schedule conflict</div>
                  <p>{scheduleConflict.message}</p>
                  <ul className="list-disc space-y-1 pl-5">
                    {scheduleConflict.conflicts.map((conflict) => (
                      <li key={conflict.id}>
                        {conflict.title}:{" "}
                        {formatEasternInterval(
                          conflict.startAt,
                          conflict.endAt,
                        )}
                      </li>
                    ))}
                  </ul>
                  {canOverrideScheduleConflicts ? (
                    <div className="space-y-3 border-t border-rose-200 pt-3">
                      <p className="font-semibold">Authorized override</p>
                      <label className="flex flex-col gap-1">
                        <span>Operational reason (required)</span>
                        <textarea
                          name="conflictOverrideReason"
                          required
                          minLength={10}
                          maxLength={500}
                          rows={3}
                          placeholder="Explain why capacity can safely be exceeded…"
                          className={`${TEAM_INPUT_COMPACT} min-h-24 resize-y bg-white`}
                        />
                      </label>
                      <input
                        type="hidden"
                        name="conflictFingerprint"
                        value={scheduleConflict.conflictFingerprint}
                      />
                      <label className="flex flex-col gap-1">
                        <span>Jobs and times being acknowledged</span>
                        <textarea
                          name="conflictAcknowledgement"
                          readOnly
                          required
                          value={scheduleConflict.requiredAcknowledgement}
                          rows={4}
                          className={`${TEAM_INPUT_COMPACT} min-h-28 resize-y bg-white`}
                        />
                      </label>
                      <label className="flex min-h-11 items-start gap-3 rounded-xl border border-rose-200 bg-white px-3 py-2">
                        <input
                          type="checkbox"
                          required
                          className="mt-0.5 h-5 w-5 rounded border-slate-300"
                        />
                        <span>
                          I reviewed every conflicting job and Eastern-time
                          interval shown above.
                        </span>
                      </label>
                    </div>
                  ) : (
                    <p className="font-medium">
                      You do not have conflict-override permission. Choose
                      another date or time.
                    </p>
                  )}
                </div>
              ) : null}
              <div>
                <button
                  type="submit"
                  disabled={
                    pendingAction !== null ||
                    !arrivalReady ||
                    Boolean(scheduleConflict && !canOverrideScheduleConflicts)
                  }
                  className={`${teamButtonClass(confirmPartnerService ? "primary" : "secondary", "sm")} w-full`}
                >
                  {pendingAction === "reschedule"
                    ? "Saving…"
                    : scheduleConflict && canOverrideScheduleConflicts
                      ? confirmPartnerService
                        ? "Override and confirm"
                        : "Override and reschedule"
                      : scheduleOnly
                        ? confirmPartnerService
                          ? "Confirm service"
                          : "Schedule service"
                        : "Reschedule"}
                </button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}

      {canUpdateAppointments && !scheduleOnly ? (
        <form
          action="/api/team/appointments/notes"
          className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3"
          onSubmit={(event) => {
            if (event.defaultPrevented) return;
            event.preventDefault();
            void submitMutation(
              event.currentTarget,
              "note",
              "Note added.",
              "Unable to add note",
            );
          }}
        >
          <input type="hidden" name="appointmentId" value={appointmentId} />
          <label
            className="block text-sm font-medium text-slate-700"
            htmlFor={noteFieldId}
          >
            Add appointment note
          </label>
          <textarea
            id={noteFieldId}
            name="body"
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
            rows={3}
            maxLength={2000}
            required
            placeholder="Add service-day context for the team…"
            className={`${TEAM_INPUT_COMPACT} min-h-24 resize-y`}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-slate-500">
              {noteDraft.length}/2000
            </span>
            <button
              type="submit"
              disabled={pendingAction !== null || noteDraft.trim().length === 0}
              className={teamButtonClass("secondary", "sm")}
            >
              {pendingAction === "note" ? "Saving…" : "Add note"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function formatEasternInterval(startAt: string, endAt: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const endFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startAt} - ${endAt}`;
  }
  return `${formatter.format(start)}-${endFormatter.format(end)} Eastern`;
}

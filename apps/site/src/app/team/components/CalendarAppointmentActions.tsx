"use client";

import React from "react";
import { useRouter } from "next/navigation";
import {
  isTeamMutationSuccessEnvelope,
  readTeamMutationError,
  readTeamMutationException,
} from "../lib/mutation-feedback";
import { formatCalendarDayKey, TEAM_TIME_ZONE } from "../lib/calendar-time";
import { CrewPayoutSelector } from "./CrewPayoutSelector";
import { TEAM_INPUT_COMPACT, teamButtonClass } from "./team-ui";

type Props = {
  appointmentId: string;
  appointmentType: string | null;
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
};

type Feedback = {
  tone: "success" | "warning" | "error";
  message: string;
} | null;

type SuccessPayload = {
  ok?: unknown;
  version?: unknown;
  calendarSync?: unknown;
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

  React.useEffect(() => setCurrentVersion(version), [version]);

  const completeDefaultValue =
    finalTotalCents !== null
      ? (finalTotalCents / 100).toFixed(2)
      : quotedTotalCents !== null
        ? (quotedTotalCents / 100).toFixed(2)
        : "";
  const defaultDate = formatCalendarDayKey(new Date(start));
  const defaultTime = formatEasternTimeInput(start);

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
      setFeedback({
        tone: calendarQueued || needsReconciliation ? "warning" : "success",
        message: calendarQueued
          ? `${successMessage} in the CRM.${effectCopy} Google Calendar cleanup is queued; keep this view available until the linked event disappears.`
          : needsReconciliation
            ? `${successMessage} in the CRM.${effectCopy} Google Calendar did not confirm the change. Keep the appointment open and ask an owner to reconcile the calendar.`
            : `${successMessage}${effectCopy}`,
      });
      if (actionName === "note") setNoteDraft("");
      if (actionName === "reschedule") setScheduleConflict(null);
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
    <div className="mt-3 space-y-3">
      {feedback ? (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          aria-live={feedback.tone === "error" ? "assertive" : "polite"}
          className={`rounded-xl border px-3 py-2 text-sm ${feedbackClass}`}
        >
          {feedback.message}
        </div>
      ) : null}

      {canEditStatus ? (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Update appointment
          </div>

          {isQuoteOnly ? (
            <form
              action="/api/team/appointments/status"
              onSubmit={(event) => {
                event.preventDefault();
                void submitMutation(
                  event.currentTarget,
                  "complete",
                  "Quote visit marked done.",
                  "Unable to complete quote visit",
                );
              }}
            >
              <input type="hidden" name="appointmentId" value={appointmentId} />
              <input
                type="hidden"
                name="appointmentType"
                value={appointmentType ?? ""}
              />
              <input type="hidden" name="status" value="completed" />
              <div className="flex flex-col gap-3">
                <p className="text-sm text-slate-600">
                  Mark this in-person quote visit as done. The customer will not
                  be notified by this status change.
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
                event.preventDefault();
                void submitMutation(
                  event.currentTarget,
                  "complete",
                  "Job completed with the confirmed total and crew.",
                  "Unable to complete job",
                );
              }}
            >
              <input type="hidden" name="appointmentId" value={appointmentId} />
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
                  finalTotalCents === null ? "null" : String(finalTotalCents)
                }
              />

              <label className="flex flex-col gap-1 text-sm text-slate-700">
                <span>Final job total</span>
                <input
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
                teamMembers={teamMembers}
                showSplitPercentages={false}
                stacked
              />

              {canManageAppointmentMedia ? (
                <details className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                  <summary className="min-h-11 cursor-pointer py-2 font-semibold">
                    Missing-proof exception
                  </summary>
                  <label className="mt-2 block" htmlFor="calendar-proof-override-reason">
                    <span className="block text-sm leading-6">
                      Use only when required partner proof cannot be captured.
                      The reason is audited and requires a recent MFA check.
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
                  I confirmed the final total and everyone who worked this job.
                </span>
              </label>

              {canSendCustomerMessages ? (
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
                    Request a review message after this completion. Safe default
                    is off; checking this queues a message but does not confirm
                    delivery.
                  </span>
                </label>
              ) : (
                <p className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                  The job will be completed without a review message. Messaging
                  permission is required to request one.
                </p>
              )}

              <div>
                <button
                  type="submit"
                  disabled={pendingAction !== null}
                  className={`${teamButtonClass("primary", "sm")} w-full`}
                >
                  {pendingAction === "complete" ? "Saving…" : "Complete job"}
                </button>
              </div>
            </form>
          ) : (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              You can update this appointment, but completing a job total
              requires payment access.
            </p>
          )}

          <div className="grid grid-cols-1 gap-3">
            <form
              action="/api/team/appointments/status"
              className="space-y-2"
              onSubmit={(event) => {
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
              <input type="hidden" name="appointmentId" value={appointmentId} />
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
              <input type="hidden" name="appointmentId" value={appointmentId} />
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
                    Send a cancellation notice. Safe default is off; delivery is
                    tracked separately in Inbox.
                  </span>
                </label>
              ) : (
                <p className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                  The customer will not be notified. Messaging permission is
                  required to send a cancellation notice.
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

          <form
            action="/api/team/appointments/reschedule"
            className="grid min-w-0 grid-cols-1 gap-3 border-t border-slate-200 pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitMutation(
                event.currentTarget,
                "reschedule",
                "Appointment rescheduled.",
                "Unable to reschedule appointment",
              );
            }}
          >
            <input type="hidden" name="appointmentId" value={appointmentId} />
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              <span>New date</span>
              <input
                type="date"
                name="preferredDate"
                required
                defaultValue={defaultDate}
                onChange={() => setScheduleConflict(null)}
                className={TEAM_INPUT_COMPACT}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              <span>Eastern time</span>
              <input
                type="time"
                name="startTime"
                required
                defaultValue={defaultTime}
                onChange={() => setScheduleConflict(null)}
                className={TEAM_INPUT_COMPACT}
              />
            </label>
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
                      {formatEasternInterval(conflict.startAt, conflict.endAt)}
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
                    You do not have conflict-override permission. Choose another
                    date or time.
                  </p>
                )}
              </div>
            ) : null}
            <div>
              <button
                type="submit"
                disabled={
                  pendingAction !== null ||
                  Boolean(scheduleConflict && !canOverrideScheduleConflicts)
                }
                className={`${teamButtonClass("secondary", "sm")} w-full`}
              >
                {pendingAction === "reschedule"
                  ? "Saving…"
                  : scheduleConflict && canOverrideScheduleConflicts
                    ? "Override and reschedule"
                    : "Reschedule"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {canUpdateAppointments ? (
        <form
          action="/api/team/appointments/notes"
          className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3"
          onSubmit={(event) => {
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

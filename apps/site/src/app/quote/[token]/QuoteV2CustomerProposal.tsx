"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import styles from "./QuoteV2CustomerProposal.module.css";
import {
  calculateQuoteV2LivePricing,
  formatQuoteV2Amount,
  formatQuoteV2AppointmentWindow,
  formatQuoteV2Usd,
  quoteV2ConsentSummary,
  quoteV2DocumentLabel,
  quoteV2ReadOnlyMessage,
  type QuoteV2AvailabilityState,
  type QuoteV2LineItem,
  type QuoteV2PublicAppointment,
  type QuoteV2PublicEnvelope,
} from "./quote-v2-customer-model";
import {
  createQuoteV2PublicHandlers,
  type QuoteV2ActionResult,
  type QuoteV2PublicHandlers,
} from "./quote-v2-public-client";

const CARD =
  "rounded-2xl border border-[color:var(--quote-border)] bg-[color:var(--quote-surface)] shadow-[0_16px_44px_var(--quote-shadow)]";
const MUTED_CARD =
  "rounded-2xl border border-[color:var(--quote-border)] bg-[color:var(--quote-surface-muted)]";
const FIELD =
  "min-h-11 w-full rounded-xl border border-[color:var(--quote-border-strong)] bg-[color:var(--quote-surface)] px-3 py-2 text-base text-[color:var(--quote-text)] placeholder:text-[color:var(--quote-text-soft)] focus:border-[color:var(--quote-focus)] focus:outline-none focus:ring-2 focus:ring-[color:var(--quote-focus)] focus:ring-offset-2 focus:ring-offset-[color:var(--quote-focus-offset)]";
const PRIMARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-xl bg-[color:var(--quote-primary)] px-4 py-3 text-center text-sm font-semibold text-[color:var(--quote-primary-text)] transition hover:bg-[color:var(--quote-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--quote-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--quote-focus-offset)] disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none";
const SECONDARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-xl border border-[color:var(--quote-border-strong)] bg-[color:var(--quote-surface)] px-4 py-3 text-center text-sm font-semibold text-[color:var(--quote-text)] transition hover:bg-[color:var(--quote-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--quote-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--quote-focus-offset)] disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none";
const EYEBROW =
  "text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--quote-text-soft)]";

type ActionPanel = "none" | "accept" | "changes" | "refresh" | "decline";
type Feedback =
  | { tone: "success"; message: string }
  | { tone: "error"; message: string }
  | null;

export interface QuoteV2CustomerProposalProps {
  token: string;
  envelope: QuoteV2PublicEnvelope;
  handlers?: Partial<QuoteV2PublicHandlers>;
  initialAvailability?: QuoteV2AvailabilityState;
  pdfHref?: string;
  acceptedResponseId?: string | null;
}

function formattedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formattedDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0
    ? `${hours} ${hours === 1 ? "hour" : "hours"}`
    : `${hours} hr ${remainder} min`;
}

function AppointmentTimeRange({
  startAt,
  endAt,
  timezone,
}: {
  startAt: string;
  endAt: string;
  timezone: string;
}) {
  const label = formatQuoteV2AppointmentWindow(startAt, endAt, timezone);
  return (
    <p className="mt-1 font-semibold text-[color:var(--quote-text)]">
      <time dateTime={startAt}>
        {label.startDate} · {label.startTime}
      </time>{" "}
      –{" "}
      <time dateTime={endAt}>
        {label.spansLocalDates ? `${label.endDate} · ` : ""}
        {label.endTime}
      </time>
    </p>
  );
}

function AppointmentSummary({
  appointment,
}: {
  appointment: QuoteV2PublicAppointment;
}) {
  const statusCopy = {
    requested: {
      heading: "Appointment requested",
      detail:
        "Your requested service time is recorded and awaiting final confirmation.",
    },
    confirmed: {
      heading: "Appointment confirmed",
      detail: "Your service appointment is confirmed.",
    },
    canceled: {
      heading: "Appointment canceled",
      detail:
        "This appointment is no longer active. Contact the team to reschedule.",
    },
    completed: {
      heading: "Service completed",
      detail: "This service appointment is complete.",
    },
  }[appointment.status];
  const arrival = appointment.promisedArrivalWindow;
  const headingId = "quote-v2-appointment-heading";
  return (
    <section
      className={`${CARD} border-[color:var(--quote-info-border)] p-5 sm:p-6`}
      aria-labelledby={headingId}
      data-appointment-status={appointment.status}
    >
      <p className={EYEBROW}>Appointment</p>
      <h2
        id={headingId}
        className="mt-1 text-xl font-semibold text-[color:var(--quote-text)]"
      >
        {statusCopy.heading}
      </h2>
      <p className="mt-1 text-sm leading-6 text-[color:var(--quote-text-muted)]">
        {statusCopy.detail}
      </p>
      <dl className="mt-4 grid gap-3 text-sm">
        {arrival ? (
          <div>
            <dt className="font-semibold text-[color:var(--quote-text-muted)]">
              Promised arrival window
            </dt>
            <dd>
              <AppointmentTimeRange
                startAt={arrival.startAt}
                endAt={arrival.endAt}
                timezone={appointment.timezone}
              />
              <p className="mt-1 text-[color:var(--quote-text-soft)]">
                The crew is expected to arrive during this window.
              </p>
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="font-semibold text-[color:var(--quote-text-muted)]">
            {arrival
              ? "Scheduled service time"
              : "Scheduled start and duration"}
          </dt>
          <dd>
            <AppointmentTimeRange
              startAt={appointment.startAt}
              endAt={appointment.endAt}
              timezone={appointment.timezone}
            />
            <p className="mt-1 text-[color:var(--quote-text-soft)]">
              {arrival
                ? `Scheduled service duration: ${formattedDuration(appointment.durationMinutes)}.`
                : `This is the scheduled service time (${formattedDuration(appointment.durationMinutes)}), not a separate arrival window.`}
            </p>
          </dd>
        </div>
        <div>
          <dt className="text-[color:var(--quote-text-soft)]">Timezone</dt>
          <dd className="mt-1 font-semibold text-[color:var(--quote-text)]">
            {appointment.timezone}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function optionInstruction(input: {
  mode: "single" | "multiple";
  minimumSelections: number;
  maximumSelections: number;
}): string {
  if (input.mode === "single" && input.minimumSelections === 1) {
    return "Choose one option.";
  }
  if (input.minimumSelections === 0) {
    return `Optional. Choose up to ${input.maximumSelections}.`;
  }
  return `Choose ${input.minimumSelections}–${input.maximumSelections}.`;
}

function resultMessage(result: QuoteV2ActionResult, fallback: string): string {
  return result.ok ? fallback : result.message;
}

function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  const success = feedback.tone === "success";
  return (
    <div
      className={`rounded-xl border p-4 text-sm font-medium ${
        success
          ? "border-[color:var(--quote-success-border)] bg-[color:var(--quote-success-surface)] text-[color:var(--quote-success-text)]"
          : "border-[color:var(--quote-danger-border)] bg-[color:var(--quote-danger-surface)] text-[color:var(--quote-danger-text)]"
      }`}
      role={success ? "status" : "alert"}
      aria-live={success ? "polite" : "assertive"}
    >
      {feedback.message}
    </div>
  );
}

function TotalSummary({
  envelope,
  pricing,
  compact = false,
}: {
  envelope: QuoteV2PublicEnvelope;
  pricing: ReturnType<typeof calculateQuoteV2LivePricing>;
  compact?: boolean;
}) {
  const { document } = envelope;
  const totals = pricing.totals;
  return (
    <div aria-live="polite" aria-atomic="true">
      <p className={EYEBROW}>
        {quoteV2DocumentLabel(document.documentType)} total
      </p>
      <p
        className={`${compact ? "mt-1 text-2xl" : "mt-2 text-4xl sm:text-5xl"} font-semibold tracking-tight text-[color:var(--quote-text)]`}
      >
        {formatQuoteV2Amount(
          document.documentType,
          totals.totalMinCents,
          totals.totalMaxCents,
        )}
      </p>
      {totals.depositCents > 0 ? (
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-[color:var(--quote-text-soft)]">Deposit</dt>
            <dd className="font-semibold text-[color:var(--quote-text)]">
              {formatQuoteV2Usd(totals.depositCents)}
            </dd>
          </div>
          <div>
            <dt className="text-[color:var(--quote-text-soft)]">Balance</dt>
            <dd className="font-semibold text-[color:var(--quote-text)]">
              {formatQuoteV2Amount(
                document.documentType,
                totals.balanceMinCents,
                totals.balanceMaxCents,
              )}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="mt-2 text-sm text-[color:var(--quote-text-muted)]">
          No online deposit is required.
        </p>
      )}
    </div>
  );
}

function AvailabilityChooser({
  state,
  scheduleChoice,
  onScheduleChoice,
  onRetry,
  disabled,
}: {
  state: QuoteV2AvailabilityState;
  scheduleChoice: string;
  onScheduleChoice: (value: string) => void;
  onRetry: () => void;
  disabled: boolean;
}) {
  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <div
        className="rounded-xl border border-[color:var(--quote-info-border)] bg-[color:var(--quote-info-surface)] p-4 text-sm text-[color:var(--quote-info-text)]"
        role="status"
        aria-live="polite"
        data-availability-state={state.kind}
      >
        Checking current appointment windows…
      </div>
    );
  }

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-[color:var(--quote-text)]">
        Scheduling preference
      </legend>
      {state.kind === "available" ? (
        <div data-availability-state="available">
          <p className="text-sm text-[color:var(--quote-text-muted)]">
            Three recommended scheduled service start times are shown first when
            available · {state.timezone}. {state.arrivalWindowMeaning} Selecting
            one does not book it yet.
          </p>
          <div className="mt-3 grid gap-2">
            {state.recommended.slice(0, 3).map((slot) => (
              <label
                key={slot.startAt}
                className={`${MUTED_CARD} flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm`}
              >
                <input
                  type="radio"
                  name="requestedStartAt"
                  value={slot.startAt}
                  checked={scheduleChoice === slot.startAt}
                  onChange={() => onScheduleChoice(slot.startAt)}
                  disabled={disabled}
                  className="h-5 w-5 shrink-0 accent-[color:var(--quote-primary)]"
                />
                <span className="font-semibold text-[color:var(--quote-text)]">
                  {slot.label}
                </span>
              </label>
            ))}
          </div>
          {state.days.some((day) => day.slots.length > 0) ? (
            <details className={`${MUTED_CARD} mt-3 p-3`}>
              <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-[color:var(--quote-text)]">
                See more dates
              </summary>
              <div className="mt-2 space-y-4">
                {state.days
                  .filter((day) => day.slots.length > 0)
                  .map((day) => (
                    <fieldset key={day.date}>
                      <legend className="text-xs font-semibold text-[color:var(--quote-text-soft)]">
                        {formattedDate(`${day.date}T12:00:00`)}
                      </legend>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {day.slots.map((slot) => (
                          <label
                            key={slot.startAt}
                            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-[color:var(--quote-border)] px-3 py-2 text-sm"
                          >
                            <input
                              type="radio"
                              name="requestedStartAt"
                              value={slot.startAt}
                              checked={scheduleChoice === slot.startAt}
                              onChange={() => onScheduleChoice(slot.startAt)}
                              disabled={disabled}
                              className="h-5 w-5 shrink-0 accent-[color:var(--quote-primary)]"
                            />
                            <span>{slot.label}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : state.kind === "empty" ? (
        <div
          className="rounded-xl border border-[color:var(--quote-warning-border)] bg-[color:var(--quote-warning-surface)] p-4 text-sm text-[color:var(--quote-warning-text)]"
          data-availability-state="empty"
          role="status"
        >
          We checked the current calendar and no online windows are open. You
          can still approve and ask the team to schedule with you.
        </div>
      ) : (
        <div
          className="rounded-xl border border-[color:var(--quote-warning-border)] bg-[color:var(--quote-warning-surface)] p-4 text-sm text-[color:var(--quote-warning-text)]"
          data-availability-state="unavailable"
          role="status"
          aria-live="polite"
        >
          <p>{state.message}</p>
          <button
            type="button"
            onClick={onRetry}
            disabled={disabled}
            className={`${SECONDARY_BUTTON} mt-3`}
          >
            Retry availability
          </button>
        </div>
      )}
      <label
        className={`${MUTED_CARD} flex min-h-11 cursor-pointer items-start gap-3 px-3 py-3 text-sm`}
      >
        <input
          type="radio"
          name="requestedStartAt"
          value="staff_followup"
          checked={scheduleChoice === "staff_followup"}
          onChange={() => onScheduleChoice("staff_followup")}
          disabled={disabled}
          className="mt-0.5 h-5 w-5 shrink-0 accent-[color:var(--quote-primary)]"
        />
        <span>
          <span className="block font-semibold text-[color:var(--quote-text)]">
            Approve and have the team contact me
          </span>
          <span className="mt-1 block text-[color:var(--quote-text-muted)]">
            This approves the proposal but does not claim an appointment.
          </span>
        </span>
      </label>
    </fieldset>
  );
}

export function QuoteV2CustomerProposal({
  token,
  envelope,
  handlers,
  initialAvailability = { kind: "idle" },
  pdfHref,
  acceptedResponseId,
}: QuoteV2CustomerProposalProps) {
  const defaults = useMemo(
    () => createQuoteV2PublicHandlers({ token }),
    [token],
  );
  const publicHandlers = useMemo<QuoteV2PublicHandlers>(
    () => ({ ...defaults, ...handlers }),
    [defaults, handlers],
  );
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>(
    envelope.selectedOptionIds,
  );
  const [availability, setAvailability] =
    useState<QuoteV2AvailabilityState>(initialAvailability);
  const [actionPanel, setActionPanel] = useState<ActionPanel>("none");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busyAction, setBusyAction] = useState<
    ActionPanel | "checkout" | "book" | null
  >(null);
  const [locallyPaused, setLocallyPaused] = useState(false);
  const [decisionComplete, setDecisionComplete] = useState(false);
  const [responseId, setResponseId] = useState<string | null>(
    acceptedResponseId ?? envelope.acceptedResponseId ?? null,
  );
  const [activeHoldId, setActiveHoldId] = useState<string | null>(null);
  const [runtimeActions, setRuntimeActions] = useState(envelope.allowedActions);
  const [scheduleChoice, setScheduleChoice] = useState("");
  const [signerName, setSignerName] = useState(
    envelope.document.parties.attentionName ??
      envelope.document.parties.customerName,
  );
  const [signerTitle, setSignerTitle] = useState(
    envelope.document.parties.attentionTitle ?? "",
  );
  const [signerCompany, setSignerCompany] = useState(
    envelope.document.parties.companyName ?? "",
  );
  const [authorityAffirmed, setAuthorityAffirmed] = useState(false);
  const [consentAffirmed, setConsentAffirmed] = useState(false);
  const [acceptErrors, setAcceptErrors] = useState<Record<string, string>>({});
  const [changeCategory, setChangeCategory] = useState<
    "scope" | "pricing" | "timing" | "terms" | "other"
  >("scope");
  const [changeMessage, setChangeMessage] = useState("");
  const [refreshMessage, setRefreshMessage] = useState("");
  const [refreshRequested, setRefreshRequested] = useState(false);
  const [declineCategory, setDeclineCategory] = useState<
    "price" | "scope" | "timing" | "competitor" | "other"
  >("other");
  const [declineNotes, setDeclineNotes] = useState("");
  const actionSectionRef = useRef<HTMLElement>(null);
  const visibleEngagementSentRef = useRef(false);

  const pricing = useMemo(
    () => calculateQuoteV2LivePricing(envelope, selectedOptionIds),
    [envelope, selectedOptionIds],
  );
  const allowed = useMemo(() => new Set(runtimeActions), [runtimeActions]);
  const canAccept =
    allowed.has("accept") && !locallyPaused && !decisionComplete;
  const canChange =
    allowed.has("change") && !locallyPaused && !decisionComplete;
  const canRefresh =
    allowed.has("refresh") &&
    !locallyPaused &&
    !decisionComplete &&
    !refreshRequested;
  const canDecline =
    allowed.has("decline") && !locallyPaused && !decisionComplete;
  const readOnlyMessage = refreshRequested
    ? "Your request was sent. This expired version remains read-only while the team prepares an updated proposal."
    : locallyPaused
      ? "Your change request was sent. Approval, payment, and scheduling are paused while the team reviews it."
      : decisionComplete
        ? "Your response was recorded. Refresh this page to see the next available step."
        : quoteV2ReadOnlyMessage(envelope);

  useEffect(() => {
    setSelectedOptionIds(envelope.selectedOptionIds);
    setRuntimeActions(envelope.allowedActions);
    setResponseId(acceptedResponseId ?? envelope.acceptedResponseId ?? null);
  }, [
    acceptedResponseId,
    envelope.acceptedResponseId,
    envelope.allowedActions,
    envelope.quoteId,
    envelope.selectedOptionIds,
    envelope.versionId,
  ]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const scheduleVisibleEngagement = () => {
      clearTimer();
      if (
        visibleEngagementSentRef.current ||
        globalThis.document.visibilityState !== "visible"
      ) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        if (
          visibleEngagementSentRef.current ||
          globalThis.document.visibilityState !== "visible"
        ) {
          return;
        }
        visibleEngagementSentRef.current = true;
        void publicHandlers
          .recordVisibleEngagement({
            quoteId: envelope.quoteId,
            versionId: envelope.versionId,
            event: "visible",
            visibleMs: 1_500,
          })
          .then((result) => {
            if (!result.ok && result.retryable) {
              visibleEngagementSentRef.current = false;
            }
          });
      }, 1_500);
    };
    scheduleVisibleEngagement();
    globalThis.document.addEventListener(
      "visibilitychange",
      scheduleVisibleEngagement,
    );
    return () => {
      clearTimer();
      globalThis.document.removeEventListener(
        "visibilitychange",
        scheduleVisibleEngagement,
      );
    };
  }, [envelope.quoteId, envelope.versionId, publicHandlers]);

  useEffect(() => {
    if (
      envelope.document.schedulingMode !== "self_schedule" ||
      !allowed.has("availability") ||
      availability.kind !== "idle"
    ) {
      return;
    }
    let active = true;
    void publicHandlers.loadAvailability().then((result) => {
      if (active) setAvailability(result);
    });
    return () => {
      active = false;
    };
  }, [
    allowed,
    availability.kind,
    envelope.document.schedulingMode,
    publicHandlers,
  ]);

  function openPanel(panel: ActionPanel) {
    setFeedback(null);
    setActionPanel(panel);
    globalThis.requestAnimationFrame?.(() => {
      actionSectionRef.current?.focus();
      actionSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  async function retryAvailability() {
    setAvailability({ kind: "loading" });
    setAvailability(await publicHandlers.loadAvailability());
  }

  function toggleOption(line: QuoteV2LineItem) {
    if (!line.optionGroupId) return;
    const group = envelope.document.pricing.optionGroups.find(
      (candidate) => candidate.id === line.optionGroupId,
    );
    if (!group) return;
    setSelectedOptionIds((current) => {
      const next = new Set(current);
      if (group.mode === "single") {
        for (const candidate of envelope.document.pricing.lineItems) {
          if (candidate.optionGroupId === group.id) next.delete(candidate.id);
        }
        next.add(line.id);
      } else if (next.has(line.id)) {
        next.delete(line.id);
      } else {
        const groupCount = envelope.document.pricing.lineItems.filter(
          (candidate) =>
            candidate.optionGroupId === group.id && next.has(candidate.id),
        ).length;
        if (groupCount < group.maximumSelections) next.add(line.id);
      }
      return [...next];
    });
  }

  async function submitAccept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors: Record<string, string> = { ...pricing.errors };
    if (!signerName.trim()) errors["signer.name"] = "Enter the signer’s name.";
    if (!signerTitle.trim()) {
      errors["signer.title"] = "Enter the signer’s title or role.";
    }
    if (!authorityAffirmed) {
      errors["signer.authorityAffirmed"] =
        "Confirm that you are authorized to approve this proposal.";
    }
    if (!consentAffirmed) {
      errors["consentAffirmed"] = "Confirm the proposal consent statement.";
    }
    if (
      envelope.document.schedulingMode === "self_schedule" &&
      allowed.has("availability") &&
      !scheduleChoice
    ) {
      errors["requestedStartAt"] =
        "Choose a recommended scheduled service start or ask the team to contact you.";
    }
    setAcceptErrors(errors);
    if (Object.keys(errors).length > 0) {
      setFeedback({
        tone: "error",
        message: "Review the highlighted approval details and try again.",
      });
      return;
    }

    setBusyAction("accept");
    setFeedback(null);
    let holdId: string | null = null;
    if (
      scheduleChoice &&
      scheduleChoice !== "staff_followup" &&
      allowed.has("hold")
    ) {
      const timezone =
        availability.kind === "available"
          ? availability.timezone
          : "America/New_York";
      const held = await publicHandlers.createHold({
        quoteId: envelope.quoteId,
        versionId: envelope.versionId,
        responseId: null,
        startAt: scheduleChoice,
        timezone,
      });
      if (!held.ok) {
        setBusyAction(null);
        setFeedback({ tone: "error", message: held.message });
        return;
      }
      const value = held.data["holdId"];
      if (typeof value !== "string") {
        setBusyAction(null);
        setFeedback({
          tone: "error",
          message:
            "The selected window could not be reserved. Choose it again before approving.",
        });
        return;
      }
      holdId = value;
      setActiveHoldId(value);
    }
    const result = await publicHandlers.accept({
      decision: "accepted",
      quoteId: envelope.quoteId,
      versionId: envelope.versionId,
      selectedOptionIds: pricing.selectedOptionIds,
      signer: {
        name: signerName.trim(),
        title: signerTitle.trim(),
        company: signerCompany.trim() || null,
        authorityAffirmed: true,
      },
      consentVersion: envelope.document.terms.consentVersion,
      consentAffirmed: true,
      requestedStartAt:
        scheduleChoice && scheduleChoice !== "staff_followup"
          ? scheduleChoice
          : null,
      holdId,
    });
    setBusyAction(null);
    if (result.ok) {
      const recordedResponseId = result.data["responseId"];
      if (typeof recordedResponseId !== "string") {
        setFeedback({
          tone: "error",
          message:
            "Approval was received, but the next step could not be loaded. Refresh the proposal before continuing.",
        });
        return;
      }
      setResponseId(recordedResponseId);
      setDecisionComplete(true);
      if (pricing.totals.depositCents > 0) {
        setRuntimeActions((current) => [
          ...new Set(
            current
              .filter((action) =>
                ["view", "pdf", "availability", "hold"].includes(action),
              )
              .concat("checkout"),
          ),
        ]);
        setFeedback({
          tone: "success",
          message:
            "Approval received. Continue to the secure deposit checkout to confirm the next step.",
        });
        return;
      }
      if (holdId) {
        const booked = await publicHandlers.book({
          quoteId: envelope.quoteId,
          versionId: envelope.versionId,
          responseId: recordedResponseId,
          holdId,
        });
        if (booked.ok) {
          setRuntimeActions((current) =>
            current.filter((action) => action === "view" || action === "pdf"),
          );
          setFeedback({
            tone: "success",
            message: "Approval received and your appointment is confirmed.",
          });
          return;
        }
        setRuntimeActions((current) => [
          ...new Set(
            current
              .filter((action) =>
                ["view", "pdf", "availability", "hold"].includes(action),
              )
              .concat("book"),
          ),
        ]);
        setFeedback({
          tone: "error",
          message:
            "Your approval is recorded, but the appointment was not confirmed. Choose the booking action again or ask the team to contact you.",
        });
        return;
      }
      setFeedback({
        tone: "success",
        message:
          scheduleChoice && scheduleChoice !== "staff_followup"
            ? "Approval received. The selected window will be held or confirmed in the next step."
            : "Approval received. The team will contact you about scheduling.",
      });
      return;
    }
    setAcceptErrors(result.fieldErrors);
    setFeedback({ tone: "error", message: resultMessage(result, "") });
  }

  async function submitChanges(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changeMessage.trim()) {
      setFeedback({
        tone: "error",
        message: "Describe what you would like changed before sending.",
      });
      return;
    }
    setBusyAction("changes");
    setFeedback(null);
    const result = await publicHandlers.requestChanges({
      quoteId: envelope.quoteId,
      versionId: envelope.versionId,
      category: changeCategory,
      message: changeMessage.trim(),
    });
    setBusyAction(null);
    if (result.ok) {
      setLocallyPaused(true);
      setFeedback({
        tone: "success",
        message:
          "Change request received. The team will review it and follow up.",
      });
      return;
    }
    setFeedback({ tone: "error", message: resultMessage(result, "") });
  }

  async function submitRefresh(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyAction("refresh");
    setFeedback(null);
    const result = await publicHandlers.requestUpdatedProposal({
      quoteId: envelope.quoteId,
      versionId: envelope.versionId,
      message: refreshMessage.trim() || null,
    });
    setBusyAction(null);
    if (result.ok) {
      setRefreshRequested(true);
      setRuntimeActions((current) =>
        current.filter((action) => action === "view" || action === "pdf"),
      );
      setActionPanel("none");
      setFeedback({
        tone: "success",
        message:
          "Request received. The team will prepare an updated proposal and follow up.",
      });
      return;
    }
    setFeedback({ tone: "error", message: resultMessage(result, "") });
  }

  async function submitDecline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!signerName.trim()) {
      setFeedback({
        tone: "error",
        message: "Enter your name before declining this proposal.",
      });
      return;
    }
    setBusyAction("decline");
    setFeedback(null);
    const result = await publicHandlers.decline({
      decision: "declined",
      quoteId: envelope.quoteId,
      versionId: envelope.versionId,
      category: declineCategory,
      notes: declineNotes.trim() || null,
      signerName: signerName.trim(),
    });
    setBusyAction(null);
    if (result.ok) {
      setDecisionComplete(true);
      setFeedback({
        tone: "success",
        message: "Your decision was recorded. Thank you for letting us know.",
      });
      return;
    }
    setFeedback({ tone: "error", message: resultMessage(result, "") });
  }

  async function beginCheckout() {
    if (!responseId) {
      setFeedback({
        tone: "error",
        message:
          "Refresh the proposal before starting the deposit checkout, or contact the team for help.",
      });
      return;
    }
    setBusyAction("checkout");
    setFeedback(null);
    const result = await publicHandlers.createCheckout({
      quoteId: envelope.quoteId,
      versionId: envelope.versionId,
      responseId,
      holdId: activeHoldId,
    });
    setBusyAction(null);
    if (!result.ok) {
      setFeedback({ tone: "error", message: result.message });
      return;
    }
    const checkoutUrl = result.data.checkoutUrl;
    if (typeof checkoutUrl !== "string") {
      setFeedback({
        tone: "error",
        message: "The secure checkout is not ready. Try again in a moment.",
      });
      return;
    }
    try {
      const destination = new URL(checkoutUrl, globalThis.location.origin);
      if (
        destination.protocol !== "https:" &&
        destination.hostname !== "localhost"
      ) {
        throw new Error("Unsafe checkout destination");
      }
      globalThis.location.assign(destination.toString());
    } catch {
      setFeedback({
        tone: "error",
        message: "The secure checkout link could not be opened.",
      });
    }
  }

  async function confirmBooking() {
    if (!responseId) {
      setFeedback({
        tone: "error",
        message:
          "Refresh the proposal before confirming the appointment, or contact the team for help.",
      });
      return;
    }
    setBusyAction("book");
    setFeedback(null);
    const result = await publicHandlers.book({
      quoteId: envelope.quoteId,
      versionId: envelope.versionId,
      responseId,
      holdId: activeHoldId,
    });
    setBusyAction(null);
    if (!result.ok) {
      setFeedback({ tone: "error", message: result.message });
      return;
    }
    setRuntimeActions((current) =>
      current.filter((action) => action === "view" || action === "pdf"),
    );
    setFeedback({
      tone: "success",
      message: "Your appointment is confirmed. The team will send the details.",
    });
  }

  const document = envelope.document;
  const projectLabel =
    document.parties.projectName ?? document.parties.serviceAddress;
  const customerLabel = document.parties.companyName
    ? `${document.parties.customerName} · ${document.parties.companyName}`
    : document.parties.customerName;
  const attachments = [...(envelope.attachments ?? [])].sort(
    (left, right) => left.displayOrder - right.displayOrder,
  );

  const actionButtons = (
    <div className="grid gap-2">
      {canAccept ? (
        <button
          type="button"
          className={`${PRIMARY_BUTTON} w-full`}
          onClick={() => openPanel("accept")}
        >
          Approve &amp; continue
        </button>
      ) : null}
      {canChange ? (
        <button
          type="button"
          className={`${SECONDARY_BUTTON} w-full`}
          onClick={() => openPanel("changes")}
        >
          Request changes
        </button>
      ) : null}
      {canRefresh ? (
        <button
          type="button"
          className={`${PRIMARY_BUTTON} w-full`}
          onClick={() => openPanel("refresh")}
        >
          Request updated proposal
        </button>
      ) : null}
      {canDecline ? (
        <button
          type="button"
          className="min-h-11 rounded-xl px-3 py-2 text-sm font-medium text-[color:var(--quote-text-muted)] underline decoration-[color:var(--quote-border-strong)] underline-offset-4 hover:text-[color:var(--quote-danger-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--quote-focus)]"
          onClick={() => openPanel("decline")}
        >
          Decline proposal
        </button>
      ) : null}
      {allowed.has("checkout") ? (
        <button
          type="button"
          className={`${PRIMARY_BUTTON} w-full`}
          onClick={() => void beginCheckout()}
          disabled={busyAction === "checkout"}
        >
          {busyAction === "checkout"
            ? "Opening checkout…"
            : "Pay deposit securely"}
        </button>
      ) : null}
      {allowed.has("book") ? (
        <button
          type="button"
          className={`${PRIMARY_BUTTON} w-full`}
          onClick={() => void confirmBooking()}
          disabled={busyAction === "book"}
        >
          {busyAction === "book"
            ? "Confirming appointment…"
            : "Confirm appointment"}
        </button>
      ) : null}
    </div>
  );

  return (
    <main
      className={`${styles["theme"]} min-h-screen overflow-x-clip pb-24 lg:pb-0`}
    >
      <header className="border-b border-[color:var(--quote-border)] bg-[color:var(--quote-surface)]">
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
          <div className="flex min-w-0 items-start justify-between gap-4">
            <div className="min-w-0">
              <p className={EYEBROW}>{document.issuer.displayName}</p>
              <h1
                className={`${styles["balancedHeading"]} mt-2 text-2xl font-semibold tracking-tight text-[color:var(--quote-text)] sm:text-3xl`}
              >
                {quoteV2DocumentLabel(document.documentType)} for {projectLabel}
              </h1>
              <p className="mt-2 break-words text-sm text-[color:var(--quote-text-muted)]">
                Prepared for {customerLabel}
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-[color:var(--quote-border)] bg-[color:var(--quote-surface-muted)] px-3 py-1 text-xs font-semibold text-[color:var(--quote-text-muted)]">
              {envelope.displayState}
            </span>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[color:var(--quote-border)] pt-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-[color:var(--quote-text-soft)]">Quote</dt>
              <dd className="mt-0.5 break-all font-semibold">
                {envelope.quoteNumber}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--quote-text-soft)]">Version</dt>
              <dd className="mt-0.5 font-semibold">{envelope.versionNumber}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--quote-text-soft)]">Issued</dt>
              <dd className="mt-0.5 font-semibold">
                {formattedDate(envelope.issuedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--quote-text-soft)]">
                Valid through
              </dt>
              <dd className="mt-0.5 font-semibold">
                {formattedDate(envelope.expiresAt)}
              </dd>
            </div>
          </dl>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-5 px-4 py-5 sm:px-6 sm:py-7 lg:grid-cols-[minmax(0,1fr)_340px] lg:px-8">
        <div className="min-w-0 space-y-5">
          {readOnlyMessage ? (
            <section
              className="rounded-xl border border-[color:var(--quote-info-border)] bg-[color:var(--quote-info-surface)] p-4 text-sm text-[color:var(--quote-info-text)]"
              role="status"
              aria-live="polite"
              data-quote-read-only="true"
            >
              {readOnlyMessage}
            </section>
          ) : null}

          {envelope.appointment ? (
            <AppointmentSummary appointment={envelope.appointment} />
          ) : null}

          <section
            className={`${CARD} p-5 sm:p-7`}
            aria-labelledby="quote-v2-summary-heading"
          >
            <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)]">
              <div>
                <h2 id="quote-v2-summary-heading" className="sr-only">
                  Proposal summary
                </h2>
                <TotalSummary envelope={envelope} pricing={pricing} />
                <p className="mt-5 whitespace-pre-wrap text-base leading-7 text-[color:var(--quote-text-muted)]">
                  {document.scope}
                </p>
              </div>
              <dl
                className={`${MUTED_CARD} grid content-start gap-3 p-4 text-sm`}
              >
                <div>
                  <dt className="text-[color:var(--quote-text-soft)]">
                    Service site
                  </dt>
                  <dd className="mt-1 break-words font-semibold text-[color:var(--quote-text)]">
                    {document.parties.serviceAddress}
                  </dd>
                </div>
                <div>
                  <dt className="text-[color:var(--quote-text-soft)]">
                    Expected duration
                  </dt>
                  <dd className="mt-1 font-semibold text-[color:var(--quote-text)]">
                    {formattedDuration(document.estimatedDurationMinutes)}
                  </dd>
                </div>
                {document.parties.purchaseOrder ? (
                  <div>
                    <dt className="text-[color:var(--quote-text-soft)]">
                      PO / reference
                    </dt>
                    <dd className="mt-1 break-words font-semibold text-[color:var(--quote-text)]">
                      {document.parties.purchaseOrder}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
          </section>

          {document.pricing.optionGroups.length > 0 ? (
            <section
              className={`${CARD} p-5 sm:p-7`}
              aria-labelledby="quote-v2-options-heading"
            >
              <p className={EYEBROW}>Your configuration</p>
              <h2
                id="quote-v2-options-heading"
                className="mt-1 text-xl font-semibold sm:text-2xl"
              >
                Select proposal options
              </h2>
              <p className="mt-2 text-sm leading-6 text-[color:var(--quote-text-muted)]">
                Totals update immediately. Your submitted selection is verified
                against this exact version before approval.
              </p>
              <div className="mt-5 space-y-5">
                {document.pricing.optionGroups.map((group) => {
                  const lines = document.pricing.lineItems.filter(
                    (line) => line.optionGroupId === group.id,
                  );
                  const selectedCount = lines.filter((line) =>
                    selectedOptionIds.includes(line.id),
                  ).length;
                  const helpId = `quote-option-help-${group.id}`;
                  const errorId = `quote-option-error-${group.id}`;
                  return (
                    <fieldset
                      key={group.id}
                      aria-describedby={`${helpId}${pricing.errors[group.id] ? ` ${errorId}` : ""}`}
                      aria-invalid={pricing.errors[group.id] ? true : undefined}
                    >
                      <legend className="font-semibold text-[color:var(--quote-text)]">
                        {group.label}
                      </legend>
                      <p
                        id={helpId}
                        className="mt-1 text-xs text-[color:var(--quote-text-soft)]"
                      >
                        {optionInstruction(group)}
                      </p>
                      <div className="mt-3 grid gap-2">
                        {lines.map((line) => {
                          const checked = selectedOptionIds.includes(line.id);
                          const maximumReached =
                            group.mode === "multiple" &&
                            !checked &&
                            selectedCount >= group.maximumSelections;
                          return (
                            <label
                              key={line.id}
                              className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-3 ${
                                checked
                                  ? "border-[color:var(--quote-primary)] bg-[color:var(--quote-success-surface)]"
                                  : "border-[color:var(--quote-border)] bg-[color:var(--quote-surface-muted)]"
                              } ${maximumReached ? "cursor-not-allowed opacity-60" : ""}`}
                            >
                              <input
                                type={
                                  group.mode === "single" ? "radio" : "checkbox"
                                }
                                name={`optionGroup.${group.id}`}
                                value={line.id}
                                checked={checked}
                                disabled={maximumReached || !canAccept}
                                onChange={() => toggleOption(line)}
                                className="mt-0.5 h-5 w-5 shrink-0 accent-[color:var(--quote-primary)]"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-1">
                                  <span className="font-semibold text-[color:var(--quote-text)]">
                                    {line.name}
                                  </span>
                                  <span className="font-semibold text-[color:var(--quote-text)]">
                                    {formatQuoteV2Amount(
                                      document.documentType,
                                      Math.round(
                                        line.quantity * line.unitPriceMinCents,
                                      ),
                                      Math.round(
                                        line.quantity *
                                          (line.unitPriceMaxCents ??
                                            line.unitPriceMinCents),
                                      ),
                                    )}
                                  </span>
                                </span>
                                {line.description ? (
                                  <span className="mt-1 block text-sm leading-5 text-[color:var(--quote-text-muted)]">
                                    {line.description}
                                  </span>
                                ) : null}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      {pricing.errors[group.id] ? (
                        <p
                          id={errorId}
                          className="mt-2 text-sm font-semibold text-[color:var(--quote-danger-text)]"
                          role="alert"
                        >
                          {pricing.errors[group.id]}
                        </p>
                      ) : null}
                    </fieldset>
                  );
                })}
              </div>
              <div className={`${MUTED_CARD} mt-5 p-4`}>
                <TotalSummary envelope={envelope} pricing={pricing} compact />
              </div>
            </section>
          ) : null}

          <section
            className={`${CARD} overflow-hidden`}
            aria-labelledby="quote-v2-pricing-heading"
          >
            <div className="p-5 pb-3 sm:p-7 sm:pb-4">
              <p className={EYEBROW}>Pricing detail</p>
              <h2
                id="quote-v2-pricing-heading"
                className="mt-1 text-xl font-semibold sm:text-2xl"
              >
                Included line items
              </h2>
            </div>
            <ul
              className="divide-y divide-[color:var(--quote-border)]"
              aria-label="Proposal line items"
            >
              {pricing.lines
                .filter((line) => line.selected)
                .map((line) => (
                  <li
                    key={line.id}
                    className="grid min-w-0 gap-2 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-7"
                  >
                    <div className="min-w-0">
                      <p className="break-words font-semibold text-[color:var(--quote-text)]">
                        {line.name}
                      </p>
                      <p className="mt-1 text-sm text-[color:var(--quote-text-muted)]">
                        {line.quantity.toLocaleString("en-US", {
                          maximumFractionDigits: 3,
                        })}{" "}
                        {line.unit}
                        {line.description ? ` · ${line.description}` : ""}
                      </p>
                    </div>
                    <p className="font-semibold text-[color:var(--quote-text)] sm:text-right">
                      {formatQuoteV2Amount(
                        document.documentType,
                        line.amountMinCents,
                        line.amountMaxCents,
                      )}
                    </p>
                  </li>
                ))}
              {pricing.adjustments.map((adjustment) => (
                <li
                  key={adjustment.id}
                  className="flex min-w-0 justify-between gap-3 px-5 py-4 text-sm sm:px-7"
                >
                  <span className="break-words text-[color:var(--quote-text-muted)]">
                    {adjustment.label}
                  </span>
                  <span className="shrink-0 font-semibold text-[color:var(--quote-text)]">
                    {adjustment.kind === "discount" ? "−" : "+"}
                    {formatQuoteV2Amount(
                      document.documentType,
                      adjustment.amountMinCents,
                      adjustment.amountMaxCents,
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <dl className="border-t border-[color:var(--quote-border-strong)] bg-[color:var(--quote-surface-muted)] p-5 text-sm sm:p-7">
              <div className="flex justify-between gap-3">
                <dt>Subtotal</dt>
                <dd className="font-semibold">
                  {formatQuoteV2Amount(
                    document.documentType,
                    pricing.totals.subtotalMinCents,
                    pricing.totals.subtotalMaxCents,
                  )}
                </dd>
              </div>
              <div className="mt-3 flex justify-between gap-3 border-t border-[color:var(--quote-border)] pt-3 text-base">
                <dt className="font-semibold">Total</dt>
                <dd className="text-right font-semibold">
                  {formatQuoteV2Amount(
                    document.documentType,
                    pricing.totals.totalMinCents,
                    pricing.totals.totalMaxCents,
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <section
            className={`${CARD} divide-y divide-[color:var(--quote-border)]`}
            aria-label="Proposal details"
          >
            <details className="group p-5 sm:px-7">
              <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 font-semibold">
                Scope, inclusions &amp; exclusions
                <span aria-hidden="true">⌄</span>
              </summary>
              <div className="mt-3 space-y-5 text-sm leading-6 text-[color:var(--quote-text-muted)]">
                <div>
                  <h3 className="font-semibold text-[color:var(--quote-text)]">
                    Scope
                  </h3>
                  <p className="mt-1 whitespace-pre-wrap">{document.scope}</p>
                </div>
                {document.inclusions.length > 0 ? (
                  <div>
                    <h3 className="font-semibold text-[color:var(--quote-text)]">
                      Included
                    </h3>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {document.inclusions.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {document.exclusions.length > 0 ? (
                  <div>
                    <h3 className="font-semibold text-[color:var(--quote-text)]">
                      Not included
                    </h3>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {document.exclusions.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {document.assumptions.length > 0 ? (
                  <div>
                    <h3 className="font-semibold text-[color:var(--quote-text)]">
                      Assumptions
                    </h3>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {document.assumptions.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </details>
            <details className="group p-5 sm:px-7">
              <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 font-semibold">
                Attachments
                <span aria-hidden="true">⌄</span>
              </summary>
              {attachments.length > 0 ? (
                <ul className="mt-3 grid gap-2">
                  {attachments.map((attachment) => (
                    <li key={attachment.id}>
                      <a
                        href={`/api/public/quotes/${encodeURIComponent(token)}/attachments/${encodeURIComponent(attachment.id)}`}
                        target="_blank"
                        rel="noreferrer"
                        referrerPolicy="no-referrer"
                        className={`${SECONDARY_BUTTON} w-full justify-between gap-3`}
                      >
                        <span className="min-w-0 break-words text-left">
                          {attachment.caption ?? attachment.fileName}
                        </span>
                        <span aria-hidden="true">Open</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-[color:var(--quote-text-muted)]">
                  No customer attachments are included with this version.
                </p>
              )}
            </details>
            <details className="group p-5 sm:px-7">
              <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 font-semibold">
                Payment &amp; scheduling
                <span aria-hidden="true">⌄</span>
              </summary>
              <div className="mt-3 space-y-3 text-sm leading-6 text-[color:var(--quote-text-muted)]">
                <p>{document.terms.paymentTerms}</p>
                <p>
                  Scheduling:{" "}
                  {document.schedulingMode === "self_schedule"
                    ? "Choose an available scheduled service start or ask the team to contact you."
                    : document.schedulingMode === "staff_followup"
                      ? "The team will coordinate scheduling after approval."
                      : "This proposal records approval only; scheduling is handled separately."}
                </p>
                {pricing.totals.depositCents > 0 ? (
                  <p>
                    A {formatQuoteV2Usd(pricing.totals.depositCents)} deposit is
                    required before appointment confirmation.
                  </p>
                ) : null}
              </div>
            </details>
            <details className="group p-5 sm:px-7">
              <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 font-semibold">
                Terms &amp; change rules
                <span aria-hidden="true">⌄</span>
              </summary>
              <div className="mt-3 space-y-5 text-sm leading-6 text-[color:var(--quote-text-muted)]">
                <div>
                  <h3 className="font-semibold text-[color:var(--quote-text)]">
                    Terms
                  </h3>
                  <p className="mt-1 whitespace-pre-wrap">
                    {document.terms.terms}
                  </p>
                </div>
                <div>
                  <h3 className="font-semibold text-[color:var(--quote-text)]">
                    Change orders
                  </h3>
                  <p className="mt-1 whitespace-pre-wrap">
                    {document.terms.changeOrderRules}
                  </p>
                </div>
              </div>
            </details>
          </section>

          <section
            ref={actionSectionRef}
            tabIndex={-1}
            id="quote-v2-response"
            className={`${CARD} scroll-mt-4 p-5 outline-none sm:p-7 ${styles["interactiveOnly"]}`}
            aria-labelledby="quote-v2-response-heading"
          >
            <p className={EYEBROW}>Your response</p>
            <h2
              id="quote-v2-response-heading"
              className="mt-1 text-xl font-semibold sm:text-2xl"
            >
              {actionPanel === "accept"
                ? "Approve this proposal"
                : actionPanel === "changes"
                  ? "Request changes"
                  : actionPanel === "refresh"
                    ? "Request an updated proposal"
                    : actionPanel === "decline"
                      ? "Decline this proposal"
                      : "Ready to respond?"}
            </h2>
            <div className="mt-4">
              <FeedbackBanner feedback={feedback} />
            </div>

            {actionPanel === "none" ? (
              <div className="mt-5">
                {readOnlyMessage ? (
                  <p className="text-sm leading-6 text-[color:var(--quote-text-muted)]">
                    {readOnlyMessage}
                  </p>
                ) : (
                  actionButtons
                )}
              </div>
            ) : null}

            {actionPanel === "accept" && canAccept ? (
              <form
                className="mt-5 space-y-5"
                onSubmit={(event) => void submitAccept(event)}
                noValidate
              >
                <input type="hidden" name="quoteId" value={envelope.quoteId} />
                <input
                  type="hidden"
                  name="versionId"
                  value={envelope.versionId}
                />
                {pricing.selectedOptionIds.map((id) => (
                  <input
                    key={id}
                    type="hidden"
                    name="selectedOptionIds"
                    value={id}
                  />
                ))}
                <div className={`${MUTED_CARD} p-4`}>
                  <p className="text-sm font-semibold text-[color:var(--quote-text)]">
                    Review
                  </p>
                  <dl className="mt-2 grid gap-2 text-sm text-[color:var(--quote-text-muted)] sm:grid-cols-2">
                    <div>
                      <dt>Proposal</dt>
                      <dd className="font-semibold text-[color:var(--quote-text)]">
                        {envelope.quoteNumber} · Version{" "}
                        {envelope.versionNumber}
                      </dd>
                    </div>
                    <div>
                      <dt>Total</dt>
                      <dd className="font-semibold text-[color:var(--quote-text)]">
                        {formatQuoteV2Amount(
                          document.documentType,
                          pricing.totals.totalMinCents,
                          pricing.totals.totalMaxCents,
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>

                {document.schedulingMode === "self_schedule" &&
                allowed.has("availability") ? (
                  <div>
                    <AvailabilityChooser
                      state={availability}
                      scheduleChoice={scheduleChoice}
                      onScheduleChoice={setScheduleChoice}
                      onRetry={() => void retryAvailability()}
                      disabled={busyAction !== null}
                    />
                    {acceptErrors["requestedStartAt"] ? (
                      <p
                        className="mt-2 text-sm font-semibold text-[color:var(--quote-danger-text)]"
                        role="alert"
                      >
                        {acceptErrors["requestedStartAt"]}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <div
                    className={`${MUTED_CARD} p-4 text-sm text-[color:var(--quote-text-muted)]`}
                  >
                    {document.schedulingMode === "staff_followup"
                      ? "After approval, the team will contact you to coordinate scheduling. Approval does not claim an appointment."
                      : "This proposal records approval only. The team will handle fulfillment separately."}
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="text-sm font-semibold text-[color:var(--quote-text)]">
                    Signer name
                    <input
                      name="signer.name"
                      value={signerName}
                      onChange={(event) => setSignerName(event.target.value)}
                      maxLength={240}
                      autoComplete="name"
                      aria-invalid={
                        acceptErrors["signer.name"] ? true : undefined
                      }
                      aria-describedby={
                        acceptErrors["signer.name"]
                          ? "quote-signer-name-error"
                          : undefined
                      }
                      className={`${FIELD} mt-1`}
                    />
                    {acceptErrors["signer.name"] ? (
                      <span
                        id="quote-signer-name-error"
                        className="mt-1 block text-xs text-[color:var(--quote-danger-text)]"
                      >
                        {acceptErrors["signer.name"]}
                      </span>
                    ) : null}
                  </label>
                  <label className="text-sm font-semibold text-[color:var(--quote-text)]">
                    Title or role
                    <input
                      name="signer.title"
                      value={signerTitle}
                      onChange={(event) => setSignerTitle(event.target.value)}
                      maxLength={160}
                      autoComplete="organization-title"
                      placeholder="Facilities manager, owner, customer…"
                      aria-invalid={
                        acceptErrors["signer.title"] ? true : undefined
                      }
                      aria-describedby={
                        acceptErrors["signer.title"]
                          ? "quote-signer-title-error"
                          : undefined
                      }
                      className={`${FIELD} mt-1`}
                    />
                    {acceptErrors["signer.title"] ? (
                      <span
                        id="quote-signer-title-error"
                        className="mt-1 block text-xs text-[color:var(--quote-danger-text)]"
                      >
                        {acceptErrors["signer.title"]}
                      </span>
                    ) : null}
                  </label>
                </div>
                <label className="block text-sm font-semibold text-[color:var(--quote-text)]">
                  Company (optional)
                  <input
                    name="signer.company"
                    value={signerCompany}
                    onChange={(event) => setSignerCompany(event.target.value)}
                    maxLength={240}
                    autoComplete="organization"
                    className={`${FIELD} mt-1`}
                  />
                </label>

                <label
                  className={`${MUTED_CARD} flex min-h-11 cursor-pointer items-start gap-3 p-4 text-sm`}
                >
                  <input
                    type="checkbox"
                    name="signer.authorityAffirmed"
                    checked={authorityAffirmed}
                    onChange={(event) =>
                      setAuthorityAffirmed(event.target.checked)
                    }
                    aria-invalid={
                      acceptErrors["signer.authorityAffirmed"]
                        ? true
                        : undefined
                    }
                    className="mt-0.5 h-5 w-5 shrink-0 accent-[color:var(--quote-primary)]"
                  />
                  <span>
                    I affirm that I am authorized to approve this proposal for
                    the named customer or company.
                    {acceptErrors["signer.authorityAffirmed"] ? (
                      <span className="mt-1 block font-semibold text-[color:var(--quote-danger-text)]">
                        {acceptErrors["signer.authorityAffirmed"]}
                      </span>
                    ) : null}
                  </span>
                </label>
                <label
                  className={`${MUTED_CARD} flex min-h-11 cursor-pointer items-start gap-3 p-4 text-sm`}
                >
                  <input
                    type="checkbox"
                    name="consentAffirmed"
                    checked={consentAffirmed}
                    onChange={(event) =>
                      setConsentAffirmed(event.target.checked)
                    }
                    aria-invalid={
                      acceptErrors["consentAffirmed"] ? true : undefined
                    }
                    className="mt-0.5 h-5 w-5 shrink-0 accent-[color:var(--quote-primary)]"
                  />
                  <span>
                    {quoteV2ConsentSummary(document.documentType)}
                    {acceptErrors["consentAffirmed"] ? (
                      <span className="mt-1 block font-semibold text-[color:var(--quote-danger-text)]">
                        {acceptErrors["consentAffirmed"]}
                      </span>
                    ) : null}
                  </span>
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="submit"
                    className={PRIMARY_BUTTON}
                    disabled={busyAction !== null}
                  >
                    {busyAction === "accept"
                      ? "Recording approval…"
                      : "Approve proposal"}
                  </button>
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    onClick={() => setActionPanel("none")}
                    disabled={busyAction !== null}
                  >
                    Back
                  </button>
                </div>
              </form>
            ) : null}

            {actionPanel === "changes" && canChange ? (
              <form
                className="mt-5 space-y-4"
                onSubmit={(event) => void submitChanges(event)}
              >
                <input type="hidden" name="quoteId" value={envelope.quoteId} />
                <input
                  type="hidden"
                  name="versionId"
                  value={envelope.versionId}
                />
                <label className="block text-sm font-semibold text-[color:var(--quote-text)]">
                  What needs to change?
                  <select
                    name="category"
                    value={changeCategory}
                    onChange={(event) =>
                      setChangeCategory(
                        event.target.value as typeof changeCategory,
                      )
                    }
                    className={`${FIELD} mt-1`}
                  >
                    <option value="scope">Scope</option>
                    <option value="pricing">Pricing</option>
                    <option value="timing">Timing</option>
                    <option value="terms">Terms</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className="block text-sm font-semibold text-[color:var(--quote-text)]">
                  Details
                  <textarea
                    name="message"
                    rows={5}
                    required
                    maxLength={4000}
                    value={changeMessage}
                    onChange={(event) => setChangeMessage(event.target.value)}
                    aria-describedby="quote-v2-change-help"
                    className={`${FIELD} mt-1 resize-y`}
                    placeholder="Describe the update you need."
                  />
                </label>
                <p
                  id="quote-v2-change-help"
                  className="text-xs text-[color:var(--quote-text-soft)]"
                >
                  Your message stays here if sending fails. A request pauses
                  approval, payment, and booking while the team reviews it.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="submit"
                    className={PRIMARY_BUTTON}
                    disabled={busyAction !== null}
                  >
                    {busyAction === "changes"
                      ? "Sending request…"
                      : "Send change request"}
                  </button>
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    onClick={() => setActionPanel("none")}
                    disabled={busyAction !== null}
                  >
                    Back
                  </button>
                </div>
              </form>
            ) : null}

            {actionPanel === "refresh" && canRefresh ? (
              <form
                className="mt-5 space-y-4"
                onSubmit={(event) => void submitRefresh(event)}
              >
                <input type="hidden" name="quoteId" value={envelope.quoteId} />
                <input
                  type="hidden"
                  name="versionId"
                  value={envelope.versionId}
                />
                <div className={`${MUTED_CARD} p-4 text-sm leading-6`}>
                  <p className="font-semibold text-[color:var(--quote-text)]">
                    This version will stay read-only
                  </p>
                  <p className="mt-1 text-[color:var(--quote-text-muted)]">
                    Stonegate will review the same project and send a new,
                    separately versioned proposal. This request does not extend
                    or reopen the expired proposal.
                  </p>
                </div>
                <label className="block text-sm font-semibold text-[color:var(--quote-text)]">
                  Note for the team (optional)
                  <textarea
                    name="message"
                    rows={4}
                    maxLength={2000}
                    value={refreshMessage}
                    onChange={(event) => setRefreshMessage(event.target.value)}
                    aria-describedby="quote-v2-refresh-help"
                    className={`${FIELD} mt-1 resize-y`}
                    placeholder="Share any timing, scope, or pricing context for the update."
                  />
                </label>
                <p
                  id="quote-v2-refresh-help"
                  className="text-xs text-[color:var(--quote-text-soft)]"
                >
                  Your note stays here if sending fails.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="submit"
                    className={PRIMARY_BUTTON}
                    disabled={busyAction !== null}
                  >
                    {busyAction === "refresh"
                      ? "Sending request…"
                      : "Confirm update request"}
                  </button>
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    onClick={() => setActionPanel("none")}
                    disabled={busyAction !== null}
                  >
                    Back
                  </button>
                </div>
              </form>
            ) : null}

            {actionPanel === "decline" && canDecline ? (
              <form
                className="mt-5 space-y-4"
                onSubmit={(event) => void submitDecline(event)}
              >
                <input type="hidden" name="quoteId" value={envelope.quoteId} />
                <input
                  type="hidden"
                  name="versionId"
                  value={envelope.versionId}
                />
                <label className="block text-sm font-semibold text-[color:var(--quote-text)]">
                  Reason
                  <select
                    name="category"
                    value={declineCategory}
                    onChange={(event) =>
                      setDeclineCategory(
                        event.target.value as typeof declineCategory,
                      )
                    }
                    className={`${FIELD} mt-1`}
                  >
                    <option value="price">Price</option>
                    <option value="scope">Scope</option>
                    <option value="timing">Timing</option>
                    <option value="competitor">
                      Selected another provider
                    </option>
                    <option value="other">Other / prefer not to say</option>
                  </select>
                </label>
                <label className="block text-sm font-semibold text-[color:var(--quote-text)]">
                  Name
                  <input
                    name="signerName"
                    value={signerName}
                    onChange={(event) => setSignerName(event.target.value)}
                    maxLength={240}
                    autoComplete="name"
                    className={`${FIELD} mt-1`}
                  />
                </label>
                <label className="block text-sm font-semibold text-[color:var(--quote-text)]">
                  Optional note
                  <textarea
                    name="notes"
                    rows={4}
                    maxLength={2000}
                    value={declineNotes}
                    onChange={(event) => setDeclineNotes(event.target.value)}
                    className={`${FIELD} mt-1 resize-y`}
                  />
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="submit"
                    className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[color:var(--quote-danger-border)] bg-[color:var(--quote-danger-surface)] px-4 py-3 text-sm font-semibold text-[color:var(--quote-danger-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--quote-focus)] disabled:cursor-wait disabled:opacity-60"
                    disabled={busyAction !== null}
                  >
                    {busyAction === "decline"
                      ? "Recording decision…"
                      : "Decline proposal"}
                  </button>
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    onClick={() => setActionPanel("none")}
                    disabled={busyAction !== null}
                  >
                    Back
                  </button>
                </div>
              </form>
            ) : null}
          </section>
        </div>

        <aside className="min-w-0 space-y-5 lg:sticky lg:top-5 lg:self-start">
          <section
            className={`${CARD} hidden p-5 lg:block ${styles["interactiveOnly"]}`}
            aria-label="Proposal actions"
          >
            <TotalSummary envelope={envelope} pricing={pricing} compact />
            <div className="mt-5 border-t border-[color:var(--quote-border)] pt-5">
              {readOnlyMessage ? (
                <p className="text-sm leading-6 text-[color:var(--quote-text-muted)]">
                  {readOnlyMessage}
                </p>
              ) : (
                actionButtons
              )}
            </div>
          </section>
          <section
            className={`${CARD} p-5`}
            aria-labelledby="quote-v2-support-heading"
          >
            <h2
              id="quote-v2-support-heading"
              className="font-semibold text-[color:var(--quote-text)]"
            >
              Questions?
            </h2>
            {document.issuer.supportMessage ? (
              <p className="mt-2 text-sm leading-6 text-[color:var(--quote-text-muted)]">
                {document.issuer.supportMessage}
              </p>
            ) : null}
            <div className="mt-4 grid gap-2 text-sm">
              <a
                href={`tel:${document.issuer.phoneE164}`}
                className={SECONDARY_BUTTON}
              >
                Call {document.issuer.phoneE164}
              </a>
              <a
                href={`mailto:${document.issuer.email}?subject=${encodeURIComponent(`Quote ${envelope.quoteNumber}`)}`}
                className={SECONDARY_BUTTON}
              >
                Email {document.issuer.email}
              </a>
              {allowed.has("pdf") ? (
                <a
                  href={pdfHref ?? `/quote/${encodeURIComponent(token)}/pdf`}
                  className={SECONDARY_BUTTON}
                >
                  Download proposal PDF
                </a>
              ) : null}
            </div>
            <p className="mt-4 border-t border-[color:var(--quote-border)] pt-4 text-xs leading-5 text-[color:var(--quote-text-soft)]">
              Prepared by {document.parties.preparerName} ·{" "}
              {document.issuer.legalName}
            </p>
          </section>
        </aside>
      </div>

      {(canAccept || canChange || canRefresh) && !readOnlyMessage ? (
        <div
          className={`${styles["stickyActions"]} ${styles["interactiveOnly"]} fixed inset-x-0 bottom-0 z-30 border-t border-[color:var(--quote-border)] bg-[color:var(--quote-surface)]/95 px-3 pt-3 shadow-[0_-8px_28px_var(--quote-shadow)] backdrop-blur lg:hidden`}
          aria-label="Proposal actions"
        >
          <div
            className={`mx-auto grid max-w-lg gap-2 ${canRefresh ? "grid-cols-1" : "grid-cols-2"}`}
          >
            {canAccept ? (
              <button
                type="button"
                className={PRIMARY_BUTTON}
                onClick={() => openPanel("accept")}
              >
                Approve &amp; continue
              </button>
            ) : (
              <span />
            )}
            {canChange ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => openPanel("changes")}
              >
                Request changes
              </button>
            ) : null}
            {canRefresh ? (
              <button
                type="button"
                className={PRIMARY_BUTTON}
                onClick={() => openPanel("refresh")}
              >
                Request updated proposal
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  type PartnerAvailability,
  type PartnerDraft,
  type PartnerHold,
  type PartnerRescheduleResult,
} from "../lib/portal-v2";
import {
  PartnerEmptyState,
  PartnerNotice,
  PartnerPanel,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";
import type { PartnerCancellationDecision } from "./PartnerJobActions";

type RescheduleOutcome = PartnerRescheduleResult;

function formatDay(value: string, timezone: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatTime(value: string, timezone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatWindow(
  startAt: string,
  endAt: string,
  timezone: string,
): string {
  return `${formatTime(startAt, timezone)}–${formatTime(endAt, timezone)}`;
}

function errorMessage(status: number, code: string, fallback: string): string {
  if (status === 410 || code === "hold_expired") {
    return "That arrival window hold expired. Choose another available window.";
  }
  if (status === 412 || code === "revision_mismatch") {
    return "This job changed in another session. Return to the job, review the latest details, and try again.";
  }
  if (status === 409 || code === "slot_unavailable") {
    return "That arrival window is no longer available. We refreshed the schedule so you can choose another.";
  }
  return fallback;
}

export function PartnerRescheduleFlow({
  jobId,
  jobEtag,
  currentWindow,
  cancellation,
  scheduleChangeRequiresReview,
}: {
  jobId: string;
  jobEtag: string;
  currentWindow: { startAt: string; endAt: string; timezone: string };
  cancellation: PartnerCancellationDecision;
  scheduleChangeRequiresReview: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<PartnerDraft | null>(null);
  const [availability, setAvailability] =
    React.useState<PartnerAvailability | null>(null);
  const [hold, setHold] = React.useState<PartnerHold | null>(null);
  const [selectedWindowId, setSelectedWindowId] = React.useState<string | null>(
    null,
  );
  const [holdSeconds, setHoldSeconds] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [holding, setHolding] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState<RescheduleOutcome | null>(null);
  const draftRef = React.useRef<PartnerDraft | null>(null);
  const holdRef = React.useRef<PartnerHold | null>(null);
  const completedRef = React.useRef(false);
  const createKeyRef = React.useRef(
    createPortalOperationKey("job-reschedule-draft"),
  );

  const setCurrentDraft = React.useCallback((next: PartnerDraft) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const loadAvailability = React.useCallback(
    async (currentDraft: PartnerDraft): Promise<void> => {
      setLoading(true);
      setMessage(null);
      const from = new Date();
      const to = new Date(from.getTime() + 30 * 86_400_000);
      const result = await partnerPortalFetch<{
        ok: true;
        availability: PartnerAvailability;
      }>(
        `booking-drafts/${encodeURIComponent(currentDraft.id)}/availability?${new URLSearchParams(
          {
            from: from.toISOString(),
            to: to.toISOString(),
          },
        ).toString()}`,
      ).catch(() => null);
      setLoading(false);
      if (!result?.ok) {
        setMessage(
          result?.error.message ??
            "Live availability could not be loaded. Your existing schedule has not changed.",
        );
        return;
      }
      setCurrentDraft(result.data.availability.draft);
      setAvailability(result.data.availability);
    },
    [setCurrentDraft],
  );

  React.useEffect(() => {
    let active = true;
    const start = async (): Promise<void> => {
      const result = await partnerPortalFetch<{
        ok: true;
        draft: PartnerDraft;
      }>(`jobs/${encodeURIComponent(jobId)}/reschedule-draft`, {
        method: "POST",
        headers: {
          "If-Match": jobEtag,
          "Idempotency-Key": createKeyRef.current,
        },
        body: JSON.stringify({}),
      }).catch(() => null);
      if (!active) return;
      if (!result?.ok) {
        setLoading(false);
        setMessage(
          result
            ? errorMessage(
                result.response.status,
                result.error.error,
                result.error.message,
              )
            : "We couldn’t start a schedule change. Your existing schedule has not changed.",
        );
        return;
      }
      if (result.data.draft.rescheduleFromJobId !== jobId) {
        setLoading(false);
        setMessage(
          "The saved schedule change did not match this job. No schedule was changed.",
        );
        return;
      }
      setCurrentDraft(result.data.draft);
      await loadAvailability(result.data.draft);
    };
    void start();
    return () => {
      active = false;
    };
  }, [jobEtag, jobId, loadAvailability, setCurrentDraft]);

  React.useEffect(() => {
    holdRef.current = hold;
    if (!hold) {
      setHoldSeconds(0);
      return;
    }
    const update = (): void => {
      const seconds = Math.max(
        0,
        Math.ceil((new Date(hold.expiresAt).getTime() - Date.now()) / 1_000),
      );
      setHoldSeconds(seconds);
      if (seconds === 0) {
        holdRef.current = null;
        setHold(null);
        setSelectedWindowId(null);
        setMessage(
          "That arrival window hold expired. Choose another available window.",
        );
      }
    };
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [hold]);

  React.useEffect(() => {
    return () => {
      const currentDraft = draftRef.current;
      const currentHold = holdRef.current;
      if (!completedRef.current && currentDraft && currentHold) {
        void fetch(
          `/api/partners/portal/booking-drafts/${encodeURIComponent(currentDraft.id)}/hold?holdId=${encodeURIComponent(currentHold.id)}`,
          { method: "DELETE", keepalive: true },
        );
      }
    };
  }, []);

  const windowsByDate = React.useMemo(() => {
    const groups = new Map<string, PartnerAvailability["windows"]>();
    for (const window of availability?.windows ?? []) {
      if (!window.available) continue;
      const group = groups.get(window.localDate) ?? [];
      group.push(window);
      groups.set(window.localDate, group);
    }
    return [...groups.entries()];
  }, [availability]);

  const timezone = availability?.timezone ?? currentWindow.timezone;
  const willRequireReview = Boolean(
    scheduleChangeRequiresReview ||
      (availability &&
        (!availability.instantConfirmationEligible ||
          availability.reviewReasons.length > 0)),
  );
  const holdWindow = hold
    ? formatWindow(hold.arrivalWindowStartAt, hold.arrivalWindowEndAt, timezone)
    : null;
  const heldDay = hold
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(new Date(hold.arrivalWindowStartAt))
    : null;

  const chooseWindow = async (
    window: PartnerAvailability["windows"][number],
  ): Promise<void> => {
    const currentDraft = draftRef.current;
    if (!currentDraft || holding || submitting) return;
    setHolding(true);
    setMessage(null);
    const result = await partnerPortalFetch<{ ok: true; hold: PartnerHold }>(
      `booking-drafts/${encodeURIComponent(currentDraft.id)}/hold`,
      {
        method: "POST",
        headers: {
          "If-Match": currentDraft.etag,
          "Idempotency-Key": createPortalOperationKey("job-reschedule-hold"),
        },
        body: JSON.stringify({ windowId: window.id }),
      },
    ).catch(() => null);
    setHolding(false);
    if (!result?.ok) {
      const status = result?.response.status ?? 503;
      const code = result?.error.error ?? "service_unavailable";
      setMessage(
        errorMessage(
          status,
          code,
          result?.error.message ?? "That arrival window could not be held.",
        ),
      );
      if (status === 409 || status === 410) void loadAvailability(currentDraft);
      return;
    }
    setSelectedWindowId(window.id);
    setHold(result.data.hold);
  };

  const refresh = async (): Promise<void> => {
    const currentDraft = draftRef.current;
    if (!currentDraft) return;
    if (holdRef.current) {
      await fetch(
        `/api/partners/portal/booking-drafts/${encodeURIComponent(currentDraft.id)}/hold?holdId=${encodeURIComponent(holdRef.current.id)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
      holdRef.current = null;
      setHold(null);
      setSelectedWindowId(null);
    }
    await loadAvailability(currentDraft);
  };

  const submit = async (): Promise<void> => {
    const currentDraft = draftRef.current;
    const currentHold = holdRef.current;
    if (!currentDraft || !currentHold || holdSeconds <= 0) return;
    setSubmitting(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      reschedule: PartnerRescheduleResult;
    }>(`jobs/${encodeURIComponent(jobId)}/reschedule`, {
      method: "POST",
      headers: {
        "If-Match": jobEtag,
        "Idempotency-Key": createPortalOperationKey("job-reschedule-submit"),
      },
      body: JSON.stringify({
        draftId: currentDraft.id,
        holdId: currentHold.id,
        draftEtag: currentDraft.etag,
      }),
    }).catch(() => null);
    setSubmitting(false);
    if (!result?.ok) {
      const status = result?.response.status ?? 503;
      const code = result?.error.error ?? "service_unavailable";
      setMessage(
        errorMessage(
          status,
          code,
          result?.error.message ??
            "The schedule change was not submitted. Your existing schedule remains in place.",
        ),
      );
      if (status === 409 || status === 410) {
        holdRef.current = null;
        setHold(null);
        setSelectedWindowId(null);
        void loadAvailability(currentDraft);
      }
      return;
    }
    completedRef.current = true;
    holdRef.current = null;
    setHold(null);
    setOutcome(result.data.reschedule);
    router.refresh();
  };

  if (outcome) {
    const requestedWindow = formatWindow(
      outcome.arrivalWindowStartAt,
      outcome.arrivalWindowEndAt,
      timezone,
    );
    const requestedDay = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(new Date(outcome.arrivalWindowStartAt));
    return (
      <PartnerPanel>
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
        </div>
        <h2 className="mt-4 text-xl font-semibold text-slate-950">
          {outcome.mode === "instant"
            ? "New schedule confirmed"
            : "Schedule change sent for review"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Requested arrival window:{" "}
          <strong>
            {requestedDay}, {requestedWindow}
          </strong>
          .
        </p>
        {outcome.mode === "review" ? (
          <PartnerNotice tone="warning" className="mt-4">
            {outcome.consequence.label} We’ll notify you when the review is
            complete.
          </PartnerNotice>
        ) : (
          <PartnerNotice tone="success" className="mt-4">
            This two-hour arrival window is now the confirmed promise for your
            job.
          </PartnerNotice>
        )}
        <Link
          href={`/partners/bookings/${encodeURIComponent(jobId)}` as Route}
          className={`${partnerPrimaryButtonClass} mt-5`}
        >
          View updated job
        </Link>
      </PartnerPanel>
    );
  }

  return (
    <div className="space-y-5">
      <PartnerPanel>
        <section
          id="partner-reschedule-policy"
          aria-labelledby="partner-reschedule-policy-title"
          className="mb-5 rounded-xl border border-slate-200 bg-slate-50 p-4"
        >
          <h2
            id="partner-reschedule-policy-title"
            className="font-semibold text-slate-950"
          >
            What happens to your current window
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-700">
            {scheduleChangeRequiresReview
              ? "Stonegate needs to review this change. Your current arrival window will stay scheduled while Stonegate reviews the new window."
              : `This change is before the account’s ${cancellation.cutoffMinutes / 60}-hour cutoff and can confirm now if the new window is still available.`}
          </p>
          <p className="mt-1 text-sm font-medium leading-6 text-slate-800">
            No fee is applied automatically for requesting this schedule change.
          </p>
        </section>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Choose a new arrival window
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
              Select a two-hour window that works for your site. Stonegate plans
              the crew’s exact start inside that window.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || submitting || !draft}
            className={partnerSecondaryButtonClass}
          >
            <RefreshCw
              className={cn(
                "h-4 w-4",
                loading && "animate-spin motion-reduce:animate-none",
              )}
              aria-hidden="true"
            />
            Refresh
          </button>
        </div>

        {availability?.calendar.state !== "current" ? (
          <PartnerNotice tone="warning" className="mt-4">
            Calendar availability is{" "}
            {availability?.calendar.state ?? "being checked"}. You may still
            choose a window, but your current schedule stays in place while
            Stonegate reviews the change.
          </PartnerNotice>
        ) : null}
        {message ? (
          <PartnerNotice tone="error" className="mt-4">
            {message}
          </PartnerNotice>
        ) : null}

        {loading ? (
          <div
            className="mt-6 flex min-h-48 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-600"
            role="status"
          >
            <LoaderCircle
              className="mr-2 h-5 w-5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            Checking live availability…
          </div>
        ) : null}

        {!loading && availability && windowsByDate.length === 0 ? (
          <div className="mt-6">
            <PartnerEmptyState
              title="No arrival windows are currently available"
              description="Your existing schedule is unchanged. Refresh later or contact Stonegate if the job needs urgent attention."
              action={{ href: "/partners/help", label: "Contact support" }}
              icon={<CalendarClock className="h-6 w-6" aria-hidden="true" />}
            />
          </div>
        ) : null}

        {!loading && windowsByDate.length ? (
          <div
            className="mt-6 max-h-[36rem] space-y-5 overflow-y-auto pr-1"
            aria-busy={holding}
          >
            {windowsByDate.map(([date, windows]) => (
              <fieldset key={date}>
                <legend className="px-1 text-sm font-semibold text-slate-950">
                  {formatDay(date, timezone)}
                </legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {windows.map((window) => {
                    const selected = selectedWindowId === window.id;
                    return (
                      <button
                        key={window.id}
                        type="button"
                        onClick={() => void chooseWindow(window)}
                        disabled={holding || submitting}
                        aria-pressed={selected}
                        className={cn(
                          "min-h-14 rounded-xl border px-4 py-3 text-left text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2",
                          selected
                            ? "border-primary-700 bg-primary-700 text-white"
                            : "border-slate-300 bg-white text-slate-800 hover:border-primary-400 hover:bg-primary-50",
                        )}
                      >
                        <span className="block">
                          {formatWindow(window.startAt, window.endAt, timezone)}
                        </span>
                        <span
                          className={cn(
                            "mt-0.5 block text-xs font-normal",
                            selected ? "text-primary-100" : "text-slate-500",
                          )}
                        >
                          Two-hour arrival window
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        ) : null}
      </PartnerPanel>

      {hold ? (
        <PartnerPanel>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
                Selected arrival window
              </p>
              <h2 className="mt-1 text-lg font-semibold text-slate-950">
                {heldDay}, {holdWindow}
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                This window is held while you send the change. Stonegate plans
                the crew’s exact start inside it.
              </p>
            </div>
            <div
              className="inline-flex min-h-11 items-center gap-2 self-start rounded-xl bg-slate-100 px-3 font-semibold tabular-nums text-slate-800 sm:self-center"
              aria-hidden="true"
            >
              <Clock3 className="h-4 w-4" aria-hidden="true" />
              {Math.floor(holdSeconds / 60)}:
              {String(holdSeconds % 60).padStart(2, "0")}
            </div>
            <p className="sr-only">
              This temporary hold expires at{" "}
              {formatTime(hold.expiresAt, timezone)}.
            </p>
          </div>
          {willRequireReview ? (
            <PartnerNotice tone="warning" className="mt-4">
              This change needs Stonegate review. Submitting it will not replace
              your existing schedule unless and until it is approved.
            </PartnerNotice>
          ) : null}
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Link
              href={`/partners/bookings/${encodeURIComponent(jobId)}` as Route}
              className={partnerSecondaryButtonClass}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Keep current schedule
            </Link>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting || holding || holdSeconds <= 0}
              className={partnerPrimaryButtonClass}
              data-partner-analytics="job_reschedule_submit"
              aria-describedby="partner-reschedule-policy"
            >
              {submitting ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <CalendarClock className="h-4 w-4" aria-hidden="true" />
              )}
              {submitting
                ? "Submitting…"
                : willRequireReview
                  ? "Request this window"
                  : "Confirm schedule change"}
            </button>
          </div>
        </PartnerPanel>
      ) : null}
    </div>
  );
}

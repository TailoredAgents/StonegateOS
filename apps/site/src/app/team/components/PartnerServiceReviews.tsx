"use client";
import { useEffect, useRef, useState } from "react";
import {
  loadPartnerServiceReviews,
  type PartnerServiceReview,
  type PartnerServiceReviewDetail,
} from "../actions/partner-service-reviews";
import { CalendarAppointmentActions } from "./CalendarAppointmentActions";
import { teamButtonClass } from "./team-ui";
import { formatCalendarDayKey } from "../lib/calendar-time";
import { teamSurfaceHref } from "../surface-registry";
import {
  PartnerRequestDetailsPanel,
  PartnerRequestScheduleSummary,
} from "./PartnerRequestDetailsPanel";
import {
  partnerReviewCheck,
  requestedPartnerWindow,
} from "../lib/partner-request-presentation";

function preferred(windows: PartnerServiceReview["preferredWindows"]) {
  return (
    windows.map(requestedPartnerWindow).join("; ") || "Staff to arrange a date"
  );
}
function arrival(item: PartnerServiceReview | PartnerServiceReviewDetail) {
  const confirmedWindow =
    "partnerRequest" in item
      ? item.partnerRequest?.scheduling.confirmedWindow
      : null;
  const startAt = confirmedWindow?.startAt ?? item.arrivalStartAt;
  const endAt = confirmedWindow?.endAt ?? item.arrivalEndAt;
  if (!startAt || !endAt) return null;
  const start = new Date(startAt),
    end = new Date(endAt);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end <= start
  )
    return null;
  const format = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  });
  return `${format.formatRange(start, end)} (Eastern)`;
}
const SCHEDULED_HEADINGS = new Map([
  ["confirmed", "Service confirmed"],
  ["in_progress", "Service in progress"],
  ["completed", "Service completed"],
]);
/** Reads partner requests; the existing CRM scheduling form owns every mutation. */
export function PartnerServiceReviews({
  canSchedule,
  accountId,
  includeScheduled = false,
  requestId,
  embedded = false,
  onReady,
  onEditing,
  onChanged,
}: {
  canSchedule: boolean;
  accountId?: string;
  includeScheduled?: boolean;
  requestId?: string;
  embedded?: boolean;
  onReady?: () => void;
  onEditing?: () => void;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<PartnerServiceReview[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState(""),
    [appliedQuery, setAppliedQuery] = useState("");
  const [detail, setDetail] = useState<PartnerServiceReviewDetail | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [returnDetail, setReturnDetail] =
    useState<PartnerServiceReviewDetail | null>(null);
  const [scheduleWarning, setScheduleWarning] = useState<{
    requestId: string;
    message: string;
  } | null>(null);
  const generation = useRef(0),
    focusScheduleOnLoad = useRef(false),
    detailRef = useRef<HTMLDivElement>(null),
    scheduleRef = useRef<HTMLElement>(null);
  async function load(more = false, search = appliedQuery) {
    const current = ++generation.current;
    setBusy(true);
    setMessage("");
    const result = await loadPartnerServiceReviews({
      accountId,
      includeScheduled,
      q: search,
      ...(more && cursor ? { cursor } : {}),
    }).catch(() => null);
    if (current !== generation.current) return;
    setBusy(false);
    if (!result?.ok) {
      setMessage(result?.message ?? "Requests could not be loaded.");
      return;
    }
    setItems((previous) =>
      more
        ? [
            ...previous,
            ...result.items.filter(
              (item) => !previous.some((entry) => entry.id === item.id),
            ),
          ]
        : result.items,
    );
    setCursor(result.nextCursor);
    setAppliedQuery(search);
  }
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setDetail(null);
    setReturnDetail(null);
    setScheduleWarning(null);
    if (requestId && accountId) void open({ id: requestId, accountId });
    else void load();
    return () => {
      generation.current += 1;
    };
  }, [accountId, includeScheduled, requestId]);
  useEffect(() => {
    if (detail) {
      if (!embedded) detailRef.current?.focus();
      else if (focusScheduleOnLoad.current) {
        scheduleRef.current?.focus();
        focusScheduleOnLoad.current = false;
      }
      onReady?.();
    }
  }, [detail]);
  async function open(
    item: Pick<PartnerServiceReview, "id" | "accountId">,
    previous: PartnerServiceReviewDetail | null = null,
  ) {
    if (accountId && item.accountId !== accountId) return;
    setScheduleWarning((previousWarning) =>
      previousWarning?.requestId === item.id ? previousWarning : null,
    );
    const current = ++generation.current;
    setBusy(true);
    setDetail(null);
    setMessage("");
    const result = await loadPartnerServiceReviews({
      id: item.id,
      accountId: item.accountId,
    }).catch(() => null);
    if (current !== generation.current) return;
    setBusy(false);
    if (!result?.ok) {
      setMessage(result?.message ?? "This request could not be loaded.");
      setDetail(previous);
      return;
    }
    setDetail(result.detail);
    setReturnDetail(previous);
  }
  return (
    <section
      className={
        embedded
          ? "min-w-0 space-y-4"
          : "space-y-4 rounded-xl border border-slate-200 bg-white p-5"
      }
      aria-labelledby={embedded ? undefined : "partner-service-reviews-heading"}
    >
      {scheduleWarning ? (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          Service scheduled. Warning: {scheduleWarning.message}
        </p>
      ) : null}
      {!embedded ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2
              id="partner-service-reviews-heading"
              className="text-lg font-semibold text-slate-950"
            >
              {includeScheduled
                ? "Company jobs & service requests"
                : "New service requests needing review"}
            </h2>
            <button
              type="button"
              disabled={busy}
              className={teamButtonClass("secondary", "sm")}
              onClick={() => void load()}
            >
              {includeScheduled ? "Refresh jobs" : "Refresh requests"}
            </button>
          </div>
          <p className="text-sm leading-6 text-slate-600">
            {includeScheduled
              ? "Open a job to see the location, requested work, photos, and current status. Only jobs awaiting initial scheduling can be scheduled here; existing bookings stay unchanged."
              : "These jobs do not have a confirmed arrival window. Review scope, pricing and requirements before using the CRM scheduler below."}
          </p>
          {!accountId ? (
            <form
              method="post"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) void load(false, query);
              }}
              className="flex flex-wrap items-end gap-3"
            >
              <label className="min-w-0 flex-1 text-sm font-semibold">
                Find company
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  type="search"
                  maxLength={100}
                  className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 text-base"
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className={teamButtonClass("secondary", "sm")}
              >
                Search requests
              </button>
            </form>
          ) : null}
          {message ? (
            <p
              role="alert"
              className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
            >
              {message}
            </p>
          ) : null}
          {busy ? (
            <p role="status" className="text-sm">
              Loading…
            </p>
          ) : null}
          <ul className="divide-y divide-slate-200">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void open(item)}
                  className="min-h-11 w-full py-3 text-left"
                >
                  <span className="block font-semibold text-primary-900">
                    {!accountId ? `${item.accountName} · ` : ""}
                    {item.service}
                  </span>
                  <span className="mt-1 block text-sm text-slate-600">
                    {item.siteName} ·{" "}
                    {arrival(item) ??
                      (includeScheduled &&
                      ![
                        "requested",
                        "requested_review",
                        "under_review",
                        "approval_needed",
                      ].includes(item.status)
                        ? "Arrival window not recorded"
                        : preferred(item.preferredWindows))}
                  </span>
                  <span className="mt-1 block text-xs text-slate-500">
                    {item.status.replaceAll("_", " ")} · received{" "}
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                      timeZone: "America/New_York",
                    }).format(new Date(item.createdAt))}
                  </span>
                  {item.originalJob ? (
                    <span className="mt-1 block text-sm font-medium text-primary-800">
                      Additional service · original job{" "}
                      {item.originalJob.id.slice(0, 8).toUpperCase()}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          {!busy && !message && !items.length ? (
            <p className="text-sm text-slate-600">
              {includeScheduled
                ? "No jobs have been linked to this company yet."
                : "No unscheduled partner requests match this view."}
            </p>
          ) : null}
          {cursor ? (
            <button
              type="button"
              disabled={busy}
              className={teamButtonClass("secondary", "sm")}
              onClick={() => void load(true)}
            >
              {includeScheduled ? "Load older jobs" : "Load older requests"}
            </button>
          ) : null}
        </>
      ) : null}
      {embedded && busy ? <p role="status">Loading request details…</p> : null}
      {embedded && message ? (
        <p role="alert">
          {message}{" "}
          <button
            type="button"
            className={teamButtonClass("secondary", "sm")}
            onClick={() =>
              requestId && accountId && void open({ id: requestId, accountId })
            }
          >
            Try again
          </button>
        </p>
      ) : null}
      {detail ? (
        <div
          key={detail.id}
          ref={detailRef}
          tabIndex={-1}
          className={
            embedded
              ? "min-w-0 space-y-5 outline-none"
              : "space-y-4 border-t border-slate-200 pt-5 focus-visible:outline-2 focus-visible:outline-offset-2"
          }
        >
          {!embedded || detail.id !== requestId ? (
            <>
              {embedded && returnDetail ? (
                <p className="text-xs font-semibold text-slate-600">
                  Original job
                </p>
              ) : null}
              <h3 className="text-lg font-semibold">
                {detail.accountName} · {detail.service}
              </h3>
              <p className="text-sm font-medium">
                Status: {detail.status.replaceAll("_", " ")}
                {arrival(detail) ? ` · ${arrival(detail)}` : ""}
              </p>
            </>
          ) : null}
          {returnDetail ? (
            <button
              type="button"
              className={teamButtonClass("secondary", "sm")}
              onClick={() => {
                setDetail(returnDetail);
                setReturnDetail(null);
              }}
            >
              Return to additional service request
            </button>
          ) : null}
          {detail.originalJob ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm leading-6">
              <p>
                This is separate additional work. The original job’s bill,
                payment, and payout stay unchanged. Confirm a separate price and
                schedule for this request.
              </p>
              <button
                type="button"
                disabled={busy}
                className={`${teamButtonClass("secondary", "sm")} mt-2`}
                onClick={() =>
                  void open(
                    { id: detail.originalJob!.id, accountId: detail.accountId },
                    detail,
                  )
                }
              >
                View original job{" "}
                {detail.originalJob.id.slice(0, 8).toUpperCase()}
              </button>
            </div>
          ) : null}
          {!embedded || detail.id !== requestId ? (
            <p className="text-sm">
              {detail.location
                ? [
                    detail.location.name,
                    detail.location.address.line1,
                    detail.location.address.line2,
                    detail.location.address.city,
                    detail.location.address.state,
                    detail.location.address.postalCode,
                  ]
                    .filter(Boolean)
                    .join(", ")
                : "Site details need staff review."}
            </p>
          ) : null}
          {detail.canSchedule && (!embedded || detail.id !== requestId) ? (
            <p className="text-sm">
              <strong>Preferred dates:</strong>{" "}
              {preferred(detail.preferredWindows)}. These are requests, not
              reservations.
            </p>
          ) : null}
          {embedded && canSchedule && detail.canSchedule ? (
            <button
              type="button"
              className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-teal-800 underline underline-offset-4 lg:hidden"
              onClick={() => scheduleRef.current?.focus()}
            >
              Set schedule <span aria-hidden="true">↓</span>
            </button>
          ) : null}
          <div
            className={
              embedded
                ? "grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:gap-8"
                : "space-y-4"
            }
          >
            <div
              className={
                embedded
                  ? "min-w-0 rounded-xl border border-slate-200 bg-white p-4 sm:p-5"
                  : "space-y-4"
              }
            >
              {detail.reasons.filter(
                (reason) =>
                  ![
                    "manual_review_required",
                    "availability_unverified",
                  ].includes(reason),
              ).length ? (
                <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-950">
                  <p className="font-semibold">Check before confirming</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {detail.reasons
                      .filter(
                        (reason) =>
                          ![
                            "manual_review_required",
                            "availability_unverified",
                          ].includes(reason),
                      )
                      .map((reason) => (
                        <li key={reason}>{partnerReviewCheck(reason)}</li>
                      ))}
                  </ul>
                </div>
              ) : null}
              {detail.partnerRequest ? (
                <PartnerRequestDetailsPanel
                  details={detail.partnerRequest}
                  photos={detail.photos}
                  hideHeader={embedded && detail.id === requestId}
                  review={embedded && detail.id === requestId}
                />
              ) : (
                <>
                  <div>
                    <h4 className="font-semibold">Requested work</h4>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6">
                      {detail.description || "Description was not provided."}
                    </p>
                  </div>
                  {detail.scopeFields.length ? (
                    <dl className="grid gap-3 sm:grid-cols-2">
                      {detail.scopeFields.map((field) => (
                        <div key={field.label}>
                          <dt className="text-sm font-semibold">
                            {field.label}
                          </dt>
                          <dd className="whitespace-pre-wrap text-sm">
                            {field.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {detail.crewInstructions ? (
                    <div>
                      <h4 className="font-semibold">Crew instructions</h4>
                      <p className="mt-1 whitespace-pre-wrap text-sm leading-6">
                        {detail.crewInstructions}
                      </p>
                    </div>
                  ) : null}
                  <p className="text-sm">
                    <strong>On-site contact:</strong>{" "}
                    {[
                      detail.onSiteContact.name,
                      detail.onSiteContact.phone,
                      detail.onSiteContact.email,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Not provided"}
                  </p>
                  <p className="text-sm">
                    <strong>Requested proof:</strong> {detail.proof.before}{" "}
                    before photo(s), {detail.proof.after} after photo(s).
                  </p>
                  <div>
                    <h4 className="font-semibold">
                      Photos supplied with this job
                    </h4>
                    {detail.photos.length ? (
                      <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {detail.photos.map((photo) => (
                          <li key={photo.id} className="min-w-0">
                            {photo.url ? (
                              <a
                                href={photo.url}
                                target="_blank"
                                rel="noreferrer"
                                className="block rounded-lg focus-visible:outline-2"
                              >
                                <img
                                  src={photo.url}
                                  alt={
                                    photo.caption ||
                                    photo.category +
                                      " photo supplied for this request"
                                  }
                                  width={320}
                                  height={240}
                                  loading="lazy"
                                  referrerPolicy="no-referrer"
                                  className="aspect-[4/3] w-full rounded-lg object-cover"
                                />
                              </a>
                            ) : (
                              <p className="rounded-lg border border-slate-200 p-3 text-sm">
                                {photo.category} —{" "}
                                {photo.status === "ready"
                                  ? "Preview unavailable; refresh or check storage."
                                  : photo.status}
                              </p>
                            )}
                            <p className="mt-1 text-xs text-slate-600">
                              {photo.caption || photo.category}
                            </p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-slate-600">
                        No photos were attached.
                      </p>
                    )}
                    <p className="mt-2 text-xs text-slate-500">
                      Photo links last five minutes. Reopen this request to
                      refresh them.
                    </p>
                  </div>
                </>
              )}
            </div>
            <aside
              ref={scheduleRef}
              tabIndex={-1}
              aria-label="Service scheduling"
              className={
                embedded
                  ? "min-w-0 scroll-mt-6 space-y-5 rounded-xl border border-slate-200 bg-white p-4 outline-none focus-visible:ring-2 focus-visible:ring-teal-700 sm:p-5 lg:sticky lg:top-6"
                  : "space-y-4"
              }
            >
              {embedded && !SCHEDULED_HEADINGS.get(detail.status) ? (
                detail.partnerRequest ? (
                  <PartnerRequestScheduleSummary
                    details={detail.partnerRequest}
                    hidePreferredDates={canSchedule && detail.canSchedule}
                  />
                ) : canSchedule && detail.canSchedule ? null : (
                  <div className="space-y-2 border-b border-slate-200 pb-4 text-sm">
                    <h4 className="font-semibold">Client’s requested timing</h4>
                    <p>{preferred(detail.preferredWindows)}</p>
                    <p className="text-xs text-slate-500">
                      Awaiting Stonegate confirmation.
                    </p>
                  </div>
                )
              ) : null}
              {canSchedule && detail.canSchedule ? (
                <CalendarAppointmentActions
                  appointmentId={detail.appointment.id}
                  appointmentType={detail.appointment.type}
                  start={detail.appointment.startAt ?? ""}
                  version={detail.appointment.version}
                  quotedTotalCents={null}
                  finalTotalCents={null}
                  isQuoteOnly={false}
                  canEditStatus={false}
                  canUpdateAppointments
                  canCollectPayments={false}
                  canSendCustomerMessages={false}
                  canManageAppointmentMedia={false}
                  canOverrideScheduleConflicts={false}
                  teamMembers={[]}
                  scheduleOnly
                  confirmPartnerService={embedded}
                  partnerPreferredWindows={
                    detail.partnerRequest
                      ? detail.partnerRequest.scheduling.preferredWindows.map(
                          (window) => ({
                            ...window,
                            timezone: window.timezone ?? undefined,
                          }),
                        )
                      : detail.preferredWindows
                  }
                  onScheduleEdited={onEditing}
                  partnerRequest={{
                    id: detail.id,
                    accountId: detail.accountId,
                  }}
                  onScheduled={(warning) => {
                    setScheduleWarning(
                      warning
                        ? { requestId: detail.id, message: warning }
                        : null,
                    );
                    focusScheduleOnLoad.current = embedded;
                    onChanged?.();
                    if (requestId && accountId)
                      void open({ id: requestId, accountId });
                    else {
                      setDetail(null);
                      void load();
                    }
                  }}
                />
              ) : (
                <div className="space-y-3">
                  {embedded && SCHEDULED_HEADINGS.get(detail.status) ? (
                    <div
                      role="status"
                      className="space-y-2 rounded-lg border border-teal-200 bg-teal-50 p-3 text-teal-950"
                    >
                      <h4 className="font-semibold">
                        {SCHEDULED_HEADINGS.get(detail.status)}
                      </h4>
                      <p className="text-sm leading-6">
                        {arrival(detail)
                          ? `Confirmed arrival: ${arrival(detail)}`
                          : "Arrival window not recorded. Review the job in the calendar."}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-600">
                      {detail.status === "approval_needed"
                        ? "Waiting for the client’s approval. You can confirm service after they approve."
                        : detail.canSchedule
                          ? "A team member with scheduling access can confirm this service."
                          : ["confirmed", "in_progress", "completed"].includes(
                                detail.status,
                              )
                            ? "This service is already scheduled. Open the calendar to review it."
                            : detail.status === "canceled"
                              ? "This request was canceled."
                              : detail.status === "declined"
                                ? "This request was declined."
                                : "This request cannot be scheduled here in its current status. Refresh the request or review it in company Jobs."}
                    </p>
                  )}
                  {includeScheduled &&
                  detail.appointment.startAt &&
                  formatCalendarDayKey(new Date(detail.appointment.startAt)) ? (
                    <a
                      href={teamSurfaceHref("calendar", {
                        query: {
                          calView: "day",
                          cal: formatCalendarDayKey(
                            new Date(detail.appointment.startAt),
                          ),
                          eventId: `db:${detail.appointment.id}`,
                        },
                      })}
                      className={teamButtonClass("secondary")}
                    >
                      Open in calendar
                    </a>
                  ) : null}
                  {embedded && SCHEDULED_HEADINGS.get(detail.status) ? (
                    <details className="border-t border-slate-200 pt-3 text-sm">
                      <summary className="min-h-11 cursor-pointer py-3 font-medium text-slate-700">
                        Scheduling details
                      </summary>
                      <div className="pt-2">
                        {detail.partnerRequest ? (
                          <PartnerRequestScheduleSummary
                            details={detail.partnerRequest}
                          />
                        ) : (
                          <p>
                            Client requested:{" "}
                            {preferred(detail.preferredWindows)}
                          </p>
                        )}
                      </div>
                    </details>
                  ) : null}
                </div>
              )}
            </aside>
          </div>
        </div>
      ) : null}
    </section>
  );
}

import React, { type ReactElement } from "react";
import { CopyButton } from "@/components/CopyButton";
import { SubmitButton } from "@/components/SubmitButton";
import { summarizeServiceLabels } from "@/lib/service-labels";
import {
  convertAppointmentToJobAction,
  rescheduleAppointmentAction,
  scheduleQuoteFollowupAction,
  startContactCallAction,
  updateAppointmentBookingDetailsAction,
  updateAppointmentSoldByAction,
} from "../actions";
import { callAdminApi } from "../lib/api";
import {
  formatAppointmentLeadSource,
  formatAppointmentJobDetails,
  formatAppointmentPricing,
  formatAppointmentServiceType,
  formatStoredContactSource,
  parseStoredContactSourceValue,
  type AppointmentBookingDetails,
  type AppointmentLeadSource,
} from "../lib/booking-details";
import { formatDayKey, TEAM_TIME_ZONE } from "../lib/timezone";
import { AppointmentBookingDetailsFields } from "./AppointmentBookingDetailsFields";
import { CrewPayoutSelector } from "./CrewPayoutSelector";
import { labelForPipelineStage } from "./pipeline.stages";
import {
  TEAM_CARD_PADDED,
  TEAM_EMPTY_STATE,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";

type AppointmentStatus =
  | "requested"
  | "confirmed"
  | "completed"
  | "no_show"
  | "canceled";

function fmtUsdCents(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value / 100);
  } catch {
    return `$${(value / 100).toFixed(2)}`;
  }
}

function fmtTimeInputValue(startAtIso: string | null): string {
  if (!startAtIso) return "";
  const dt = new Date(startAtIso);
  if (Number.isNaN(dt.getTime())) return "";
  try {
    return dt.toLocaleTimeString("en-GB", {
      timeZone: TEAM_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

function fmtDateTimeInputValue(startAtIso: string | null): string {
  if (!startAtIso) return "";
  const dt = new Date(startAtIso);
  if (Number.isNaN(dt.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dt);

  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";

  if (!year || !month || !day || !hour || !minute) return "";
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function fmtAppointmentSlot(startAtIso: string | null): string {
  if (!startAtIso) return "Time not set";
  const dt = new Date(startAtIso);
  if (Number.isNaN(dt.getTime())) return "Time not set";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(dt);
}

function fmtFollowUpSlot(startAtIso: string | null): string {
  if (!startAtIso) return "Not scheduled";
  const dt = new Date(startAtIso);
  if (Number.isNaN(dt.getTime())) return "Not scheduled";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(dt);
}

function isQuoteOnlyAppointment(appointmentType: string | null | undefined) {
  const normalized = (appointmentType ?? "").trim().toLowerCase();
  return (
    normalized === "in_person_quote" || normalized === "in_person_estimate"
  );
}

function canReuseLeadSource(source: AppointmentLeadSource | null): boolean {
  if (!source) return false;
  if (source.type === "team_member") {
    return Boolean(source.teamMemberId);
  }
  if (source.type === "referral") {
    return Boolean(source.referralName);
  }
  return true;
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const offsetLabel =
    parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = offsetLabel.match(/^GMT(?:(\+|-)(\d{1,2})(?::?(\d{2}))?)?$/);
  if (!match) return 0;

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes);
}

function getTeamDayParts(date: Date): {
  year: number;
  month: number;
  day: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === "year")?.value ?? "0"),
    month: Number(parts.find((part) => part.type === "month")?.value ?? "0"),
    day: Number(parts.find((part) => part.type === "day")?.value ?? "0"),
  };
}

function makeUtcDateForTeamTime(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offsetMinutes = getTimeZoneOffsetMinutes(utcGuess, TEAM_TIME_ZONE);
  return new Date(utcGuess.getTime() - offsetMinutes * 60_000);
}

function getTeamDayRange(date: Date): { startIso: string; endIso: string } {
  const { year, month, day } = getTeamDayParts(date);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const start = makeUtcDateForTeamTime(year, month, day);
  const end = makeUtcDateForTeamTime(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
  );
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function defaultQuoteFollowUpInputValue(
  appointmentStartAtIso: string | null,
  currentDueAtIso: string | null,
): string {
  if (currentDueAtIso) {
    return fmtDateTimeInputValue(currentDueAtIso);
  }

  const baseDate = appointmentStartAtIso
    ? new Date(appointmentStartAtIso)
    : new Date();
  const validBaseDate = Number.isNaN(baseDate.getTime())
    ? new Date()
    : baseDate;
  const { year, month, day } = getTeamDayParts(validBaseDate);
  const nextLocalDay = new Date(Date.UTC(year, month - 1, day + 1));
  const followUpAt = makeUtcDateForTeamTime(
    nextLocalDay.getUTCFullYear(),
    nextLocalDay.getUTCMonth() + 1,
    nextLocalDay.getUTCDate(),
    9,
    0,
  );
  return fmtDateTimeInputValue(followUpAt.toISOString());
}

function formatMoneySummary(appointment: AppointmentDto): string | null {
  const quoted = fmtUsdCents(appointment.quotedTotalCents);
  const final = fmtUsdCents(appointment.finalTotalCents);
  if (quoted && final) return `${quoted} quoted / ${final} collected`;
  if (final) return `${final} collected`;
  if (quoted) return `${quoted} quoted`;
  return null;
}

function summaryButtonClass(
  variant: "primary" | "secondary" | "danger" = "secondary",
): string {
  return `${teamButtonClass(variant, "sm")} cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden`;
}

function buildMapsHref(property: AppointmentDto["property"]): string {
  const query = [
    property.addressLine1,
    property.city,
    property.state,
    property.postalCode,
  ]
    .filter((part) => part && part.trim().length > 0)
    .join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

interface AppointmentDto {
  id: string;
  appointmentType: string | null;
  status: AppointmentStatus;
  startAt: string | null;
  durationMinutes: number | null;
  travelBufferMinutes: number | null;
  quotedTotalCents: number | null;
  finalTotalCents: number | null;
  bookingDetails: AppointmentBookingDetails | null;
  soldByMemberId: string | null;
  services: string[];
  rescheduleToken: string;
  contact: {
    id: string | null;
    name: string;
    email: string | null;
    phone: string | null;
    source: string | null;
    assignedAssociateMemberId: string | null;
  };
  pipelineStage: string | null;
  quoteStatus: string | null;
  property: {
    id: string | null;
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
  };
  notes: Array<{ id: string; body: string; createdAt: string }>;
  quoteFollowUp: {
    id: string;
    title: string;
    dueAt: string;
    assignedTo: string | null;
    comment: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
}

type TeamMemberDto = {
  id: string;
  name: string;
};

type AppointmentCardItem = {
  appointment: AppointmentDto;
  startDate: Date | null;
  startDayKey: string;
  isQuoteOnly: boolean;
  serviceLabel: string | null;
  leadSourceSummary: string | null;
  pricingSummary: string | null;
  jobDetailsSummary: string | null;
  attentionReasons: string[];
};

type SummaryTileProps = {
  label: string;
  value: string;
  muted?: boolean;
};

function SummaryTile({
  label,
  value,
  muted = false,
}: SummaryTileProps): ReactElement {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/90 px-3 py-3 shadow-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={`mt-1 text-sm font-medium ${
          muted ? "text-slate-500" : "text-slate-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

type AppointmentSectionProps = {
  title: string;
  subtitle: string;
  items: AppointmentCardItem[];
  tone?: "emerald" | "amber" | "sky" | "slate";
  teamMembers: TeamMemberDto[];
  teamMemberNameById: Map<string, string>;
};

function AppointmentSection({
  title,
  subtitle,
  items,
  tone = "slate",
  teamMembers,
  teamMemberNameById,
}: AppointmentSectionProps): ReactElement | null {
  if (items.length === 0) return null;

  const badgeClassName =
    tone === "emerald"
      ? "bg-emerald-100 text-emerald-700"
      : tone === "amber"
        ? "bg-amber-100 text-amber-700"
        : tone === "sky"
          ? "bg-sky-100 text-sky-700"
          : "bg-slate-100 text-slate-700";

  return (
    <section className={TEAM_CARD_PADDED}>
      <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className={TEAM_SECTION_TITLE}>{title}</h2>
          <p className={TEAM_SECTION_SUBTITLE}>{subtitle}</p>
        </div>
        <span
          className={`inline-flex items-center justify-center rounded-full px-3 py-1 text-xs font-semibold ${badgeClassName}`}
        >
          {items.length} {items.length === 1 ? "appointment" : "appointments"}
        </span>
      </div>
      <div className="mt-4 space-y-4">
        {items.map((item) => (
          <AppointmentCard
            key={item.appointment.id}
            item={item}
            teamMembers={teamMembers}
            teamMemberNameById={teamMemberNameById}
          />
        ))}
      </div>
    </section>
  );
}

type AppointmentCardProps = {
  item: AppointmentCardItem;
  teamMembers: TeamMemberDto[];
  teamMemberNameById: Map<string, string>;
};

function AppointmentCard({
  item,
  teamMembers,
  teamMemberNameById,
}: AppointmentCardProps): ReactElement {
  const a = item.appointment;
  const sellerName = a.soldByMemberId
    ? (teamMemberNameById.get(a.soldByMemberId) ?? "Unknown")
    : item.isQuoteOnly
      ? "Set when converted"
      : "Not set";
  const moneySummary = formatMoneySummary(a);
  const serviceSummary = item.isQuoteOnly
    ? (item.serviceLabel ?? "In-person quote")
    : (item.serviceLabel ?? summarizeServiceLabels(a.services ?? []));
  const addressText = [
    a.property.addressLine1,
    a.property.city,
    a.property.state,
    a.property.postalCode,
  ]
    .filter((part) => part && part.trim().length > 0)
    .join(", ");
  const hasAddress = addressText.length > 0;
  const mapsHref = buildMapsHref(a.property);
  const hasPhone = Boolean(a.contact.phone && a.contact.id);
  const isCompleted = a.status === "completed";
  const cardClassName = item.attentionReasons.length
    ? "border-amber-200 bg-amber-50/40"
    : item.isQuoteOnly
      ? "border-sky-200 bg-sky-50/40"
      : isCompleted
        ? "border-slate-200 bg-slate-50/60"
        : "border-emerald-200 bg-white";

  const resolvedSource: AppointmentLeadSource | null =
    a.bookingDetails?.source ?? parseStoredContactSourceValue(a.contact.source);
  const reusableSource = canReuseLeadSource(resolvedSource)
    ? resolvedSource
    : null;
  const notesLabel = a.notes.length
    ? `${a.notes.length} ${a.notes.length === 1 ? "note" : "notes"}`
    : "Notes";
  const quoteFollowUpAssigneeName = a.quoteFollowUp?.assignedTo
    ? (teamMemberNameById.get(a.quoteFollowUp.assignedTo) ?? "Assigned rep")
    : a.contact.assignedAssociateMemberId
      ? (teamMemberNameById.get(a.contact.assignedAssociateMemberId) ??
        "Assigned rep")
      : null;
  const quoteFollowUpSummary = a.quoteFollowUp
    ? `${fmtFollowUpSlot(a.quoteFollowUp.dueAt)}${
        quoteFollowUpAssigneeName ? ` with ${quoteFollowUpAssigneeName}` : ""
      }`
    : "Not scheduled";
  const now = new Date();
  const quoteVisitHasPassed = item.isQuoteOnly
    ? Boolean(item.startDate && item.startDate.getTime() <= now.getTime())
    : false;
  const showFollowUpPanel =
    item.isQuoteOnly && (quoteVisitHasPassed || Boolean(a.quoteFollowUp));

  return (
    <article className={`rounded-3xl border p-4 shadow-sm ${cardClassName}`}>
      <div className="flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-wide">
        <span
          className={`rounded-full px-3 py-1 ${
            item.isQuoteOnly
              ? "bg-sky-100 text-sky-700"
              : "bg-emerald-100 text-emerald-700"
          }`}
        >
          {item.isQuoteOnly ? "In-person quote" : serviceSummary}
        </span>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700">
          {isCompleted ? "Done today" : fmtAppointmentSlot(a.startAt)}
        </span>
        {item.attentionReasons.length ? (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-700">
            Needs attention
          </span>
        ) : null}
        {a.pipelineStage ? (
          <span className="rounded-full bg-white px-3 py-1 text-slate-700">
            Pipeline: {labelForPipelineStage(a.pipelineStage)}
          </span>
        ) : null}
        {a.quoteStatus ? (
          <span className="rounded-full bg-white px-3 py-1 text-slate-700">
            Quote: {a.quoteStatus}
          </span>
        ) : null}
        {item.isQuoteOnly && a.quoteFollowUp ? (
          <span className="rounded-full bg-white px-3 py-1 text-slate-700">
            Follow-up: {fmtFollowUpSlot(a.quoteFollowUp.dueAt)}
          </span>
        ) : null}
        {item.isQuoteOnly && quoteVisitHasPassed && !a.quoteFollowUp ? (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-700">
            No follow-up set
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="text-xl font-semibold text-slate-900">
            {a.contact.name}
          </h3>
          <div className="mt-1 text-sm text-slate-600">
            {fmtAppointmentSlot(a.startAt)}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-700">
            <span>{addressText || "Address not set"}</span>
            {addressText ? (
              <CopyButton value={addressText} label="Copy" />
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <span>{a.contact.phone ?? "Phone not set"}</span>
            {a.contact.phone ? (
              <CopyButton value={a.contact.phone} label="Copy" />
            ) : null}
          </div>
        </div>

        {!isCompleted ? (
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <form action={startContactCallAction}>
              <input
                type="hidden"
                name="contactId"
                value={a.contact.id ?? ""}
              />
              <SubmitButton
                className={teamButtonClass("secondary", "sm")}
                pendingLabel="Calling..."
                disabled={!hasPhone}
              >
                Call
              </SubmitButton>
            </form>

            {hasAddress ? (
              <a
                href={mapsHref}
                target="_blank"
                rel="noreferrer"
                className={teamButtonClass("secondary", "sm")}
              >
                Maps
              </a>
            ) : (
              <span
                className={`${teamButtonClass("secondary", "sm")} cursor-not-allowed opacity-60`}
              >
                Maps
              </span>
            )}
          </div>
        ) : null}
      </div>

      {item.attentionReasons.length ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {item.attentionReasons.map((reason) => (
            <span
              key={reason}
              className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700"
            >
              {reason}
            </span>
          ))}
        </div>
      ) : null}

      <div
        className={`mt-4 grid gap-2 ${
          item.isQuoteOnly
            ? "sm:grid-cols-2 xl:grid-cols-4"
            : "sm:grid-cols-2 xl:grid-cols-5"
        }`}
      >
        <SummaryTile label="Service" value={serviceSummary} />
        <SummaryTile
          label="Money"
          value={
            moneySummary ??
            (item.isQuoteOnly ? "Set when converted" : "Not set")
          }
          muted={!moneySummary}
        />
        <SummaryTile
          label="Where from"
          value={
            item.leadSourceSummary ??
            (item.isQuoteOnly ? "Optional for quote" : "Not set")
          }
          muted={!item.leadSourceSummary}
        />
        {!item.isQuoteOnly ? (
          <SummaryTile
            label="Job details"
            value={item.jobDetailsSummary ?? "Not set"}
            muted={!item.jobDetailsSummary}
          />
        ) : null}
        {!item.isQuoteOnly ? (
          <SummaryTile
            label="Pricing"
            value={item.pricingSummary ?? "Not set"}
            muted={!item.pricingSummary}
          />
        ) : null}
        {item.isQuoteOnly ? (
          <SummaryTile
            label="Follow-up"
            value={quoteFollowUpSummary}
            muted={!a.quoteFollowUp}
          />
        ) : (
          <SummaryTile
            label="Sold by"
            value={sellerName}
            muted={!a.soldByMemberId}
          />
        )}
      </div>

      {!item.isQuoteOnly ? (
        <details className="mt-4 rounded-2xl border border-slate-200 bg-white p-3">
          <summary className={summaryButtonClass("secondary")}>
            Edit seller
          </summary>
          <form
            action={updateAppointmentSoldByAction}
            className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
          >
            <input type="hidden" name="appointmentId" value={a.id} />
            <label className="flex flex-col gap-1">
              <span>Who sold the job?</span>
              <select
                name="soldByMemberId"
                defaultValue={
                  a.soldByMemberId ?? a.contact.assignedAssociateMemberId ?? ""
                }
                required
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
              >
                <option value="">(Select seller)</option>
                {teamMembers.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span>Seller override code</span>
              <input
                name="soldByOverrideCode"
                type="password"
                autoComplete="off"
                placeholder="Required if changing seller"
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
            <div className="sm:col-span-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
              Sales payouts use this seller. Completed jobs update draft payout
              reports immediately. Locked or paid payout periods must be
              unlocked before seller changes.
            </div>
            <div className="sm:col-span-2 flex items-center justify-end">
              <SubmitButton
                className={teamButtonClass("primary", "sm")}
                pendingLabel="Saving..."
              >
                Save seller
              </SubmitButton>
            </div>
          </form>
        </details>
      ) : null}

      {!isCompleted ? (
        <div className="mt-4 space-y-3">
          {item.isQuoteOnly ? (
            <>
              <details className="group rounded-2xl border border-sky-200 bg-white p-3">
                <summary className={summaryButtonClass("primary")}>
                  Convert to job
                </summary>
                <form
                  action={convertAppointmentToJobAction}
                  className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
                >
                  <input type="hidden" name="appointmentId" value={a.id} />
                  {reusableSource ? (
                    <>
                      <input
                        type="hidden"
                        name="resolvedSourceType"
                        value={reusableSource.type}
                      />
                      {reusableSource.teamMemberId ? (
                        <input
                          type="hidden"
                          name="resolvedSourceTeamMemberId"
                          value={reusableSource.teamMemberId}
                        />
                      ) : null}
                      {reusableSource.referralName ? (
                        <input
                          type="hidden"
                          name="resolvedSourceReferralName"
                          value={reusableSource.referralName}
                        />
                      ) : null}
                      <div className="sm:col-span-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800">
                        Where from will stay as{" "}
                        <span className="font-semibold">
                          {item.leadSourceSummary}
                        </span>
                        .
                      </div>
                    </>
                  ) : (
                    <div className="sm:col-span-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                      This quote is missing a lead source. Set it here so the
                      converted job tracks correctly.
                    </div>
                  )}

                  <label className="flex flex-col gap-1">
                    <span>Who sold the job?</span>
                    <select
                      name="soldByMemberId"
                      defaultValue={a.soldByMemberId ?? ""}
                      required
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    >
                      <option value="">(Select seller)</option>
                      {teamMembers.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span>Seller override code</span>
                    <input
                      name="soldByOverrideCode"
                      type="password"
                      autoComplete="off"
                      placeholder="Only needed if changing seller"
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span>Job date and time</span>
                    <input
                      type="datetime-local"
                      name="startAt"
                      required
                      step={300}
                      defaultValue={fmtDateTimeInputValue(a.startAt)}
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    />
                  </label>

                  <div className="sm:col-span-2 text-[11px] text-slate-600">
                    Use the actual job time if you already did the job right
                    after the quote.
                  </div>

                  <AppointmentBookingDetailsFields
                    teamMembers={teamMembers}
                    bookingDetails={a.bookingDetails}
                    quotedTotalCents={a.quotedTotalCents}
                    allowServiceTypeSelection
                    labelClassName="flex flex-col gap-1"
                    fieldClassName="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    hideLeadSource={Boolean(reusableSource)}
                    fixedSource={reusableSource}
                  />

                  <div className="sm:col-span-2 flex items-center justify-end">
                    <SubmitButton
                      className={teamButtonClass("primary", "sm")}
                      pendingLabel="Saving..."
                    >
                      Save converted job
                    </SubmitButton>
                  </div>
                </form>
              </details>

              {showFollowUpPanel ? (
                <details className="group rounded-2xl border border-slate-200 bg-white p-3">
                  <summary className={summaryButtonClass("secondary")}>
                    {a.quoteFollowUp
                      ? "Reschedule follow-up"
                      : "Schedule follow-up"}
                  </summary>
                  <form
                    action={scheduleQuoteFollowupAction}
                    className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
                  >
                    <input type="hidden" name="appointmentId" value={a.id} />

                    <div className="sm:col-span-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                      {a.quoteFollowUp ? (
                        <>
                          Current reminder:{" "}
                          <span className="font-semibold">
                            {quoteFollowUpSummary}
                          </span>
                          . Saving here replaces that reminder.
                        </>
                      ) : (
                        <>
                          Creates one follow-up reminder in Sales HQ for{" "}
                          <span className="font-semibold">
                            {quoteFollowUpAssigneeName ?? "the assigned rep"}
                          </span>
                          .
                        </>
                      )}
                    </div>

                    <label className="flex flex-col gap-1">
                      <span>Follow-up date and time</span>
                      <input
                        type="datetime-local"
                        name="dueAt"
                        required
                        step={300}
                        defaultValue={defaultQuoteFollowUpInputValue(
                          a.startAt,
                          a.quoteFollowUp?.dueAt ?? null,
                        )}
                        className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                      />
                    </label>

                    <label className="flex flex-col gap-1">
                      <span>Notes (optional)</span>
                      <textarea
                        name="note"
                        rows={3}
                        defaultValue={a.quoteFollowUp?.comment ?? ""}
                        placeholder="What should we remember before reaching back out?"
                        className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                      />
                    </label>

                    <div className="sm:col-span-2 flex items-center justify-end">
                      <SubmitButton
                        className={teamButtonClass("primary", "sm")}
                        pendingLabel="Saving..."
                      >
                        {a.quoteFollowUp
                          ? "Save follow-up"
                          : "Schedule follow-up"}
                      </SubmitButton>
                    </div>
                  </form>
                </details>
              ) : null}
            </>
          ) : (
            <details className="group rounded-2xl border border-emerald-200 bg-white p-3">
              <summary className={summaryButtonClass("primary")}>
                Complete job
              </summary>
              <form
                action="/api/team/appointments/status"
                method="post"
                className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
              >
                <input type="hidden" name="appointmentId" value={a.id} />
                <input type="hidden" name="status" value="completed" />

                <label className="flex flex-col gap-1">
                  <span>Amount collected</span>
                  <input
                    name="finalTotal"
                    type="number"
                    min={0}
                    step="0.01"
                    required
                    defaultValue={
                      a.finalTotalCents !== null
                        ? (a.finalTotalCents / 100).toFixed(2)
                        : a.quotedTotalCents !== null
                          ? (a.quotedTotalCents / 100).toFixed(2)
                          : ""
                    }
                    placeholder="e.g. 350.00"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span>Card tips (optional)</span>
                  <input
                    name="cardTip"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="e.g. 20.00"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  />
                </label>

                <div className="sm:col-span-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                  {a.quotedTotalCents !== null
                    ? `Quoted amount is prefilled at ${fmtUsdCents(a.quotedTotalCents)} for speed. Card tips are tracked separately and are not counted in revenue.`
                    : "Card tips are tracked separately and are not counted in revenue."}
                </div>

                <details className="sm:col-span-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
                  <summary className="cursor-pointer font-medium select-none">
                    Commissions
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div className="text-[11px] text-slate-600">
                      Sales commission uses the person in Who sold the job?.
                      Changing that seller requires the secret code.
                    </div>
                    <div className="text-[11px] text-slate-600">
                      Crew payout is locked by the selected crew combo, and at
                      least one crew member is required before completion.
                    </div>
                    <CrewPayoutSelector teamMembers={teamMembers} />
                  </div>
                </details>

                <div className="sm:col-span-2 flex items-center justify-end">
                  <SubmitButton
                    className={teamButtonClass("primary", "sm")}
                    pendingLabel="Saving..."
                  >
                    Mark complete
                  </SubmitButton>
                </div>
              </form>
            </details>
          )}

          <details className="group rounded-2xl border border-slate-200 bg-white p-3">
            <summary className={summaryButtonClass("secondary")}>More</summary>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Quick changes
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <form action="/api/team/appointments/status" method="post">
                    <input type="hidden" name="appointmentId" value={a.id} />
                    <input type="hidden" name="status" value="no_show" />
                    <SubmitButton
                      className={teamButtonClass("secondary", "sm")}
                      pendingLabel="Saving..."
                    >
                      No-show
                    </SubmitButton>
                  </form>
                  <form action="/api/team/appointments/status" method="post">
                    <input type="hidden" name="appointmentId" value={a.id} />
                    <input type="hidden" name="status" value="canceled" />
                    <SubmitButton
                      className={teamButtonClass("danger", "sm")}
                      pendingLabel="Saving..."
                    >
                      Cancel appointment
                    </SubmitButton>
                  </form>
                  <a
                    href={`/schedule?appointmentId=${encodeURIComponent(a.id)}&token=${encodeURIComponent(a.rescheduleToken)}`}
                    className={teamButtonClass("secondary", "sm")}
                  >
                    Reschedule link
                  </a>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Reschedule in console
                </div>
                <form
                  action={rescheduleAppointmentAction}
                  className="mt-3 flex flex-col gap-2"
                >
                  <input type="hidden" name="appointmentId" value={a.id} />
                  <label className="flex flex-col gap-1">
                    <span>Date</span>
                    <input
                      type="date"
                      name="preferredDate"
                      defaultValue={a.startAt ? a.startAt.slice(0, 10) : ""}
                      required
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span>Time</span>
                    <input
                      type="time"
                      name="startTime"
                      defaultValue={fmtTimeInputValue(a.startAt)}
                      step={900}
                      required
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    />
                    <span className="text-[11px] text-slate-500">
                      Times are saved in Eastern time.
                    </span>
                  </label>
                  <SubmitButton
                    className={teamButtonClass("primary", "sm")}
                    pendingLabel="Saving..."
                  >
                    Save new time
                  </SubmitButton>
                </form>
              </div>

              {!item.isQuoteOnly ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 lg:col-span-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Edit booking details
                  </div>
                  <form
                    action={updateAppointmentBookingDetailsAction}
                    className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
                  >
                    <input type="hidden" name="appointmentId" value={a.id} />
                    <AppointmentBookingDetailsFields
                      teamMembers={teamMembers}
                      bookingDetails={a.bookingDetails}
                      quotedTotalCents={a.quotedTotalCents}
                      allowServiceTypeSelection
                      labelClassName="flex flex-col gap-1"
                      fieldClassName="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    />
                    <div className="sm:col-span-2 flex items-center justify-end">
                      <SubmitButton
                        className={teamButtonClass("primary", "sm")}
                        pendingLabel="Saving..."
                      >
                        Save booking details
                      </SubmitButton>
                    </div>
                  </form>
                </div>
              ) : null}

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 lg:col-span-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Notes
                </div>
                {a.notes.length ? (
                  <div className="mt-3 space-y-2">
                    {a.notes.map((note) => (
                      <div
                        key={note.id}
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                      >
                        <div>{note.body}</div>
                        <div className="mt-1 text-[11px] text-slate-500">
                          {new Date(note.createdAt).toLocaleString(undefined, {
                            timeZone: TEAM_TIME_ZONE,
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 text-sm text-slate-500">
                    No notes yet.
                  </div>
                )}
                <form
                  action="/api/team/appointments/notes"
                  method="post"
                  className="mt-3 flex flex-col gap-2 sm:flex-row"
                >
                  <input type="hidden" name="appointmentId" value={a.id} />
                  <input
                    name="body"
                    placeholder="Add note"
                    className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  />
                  <SubmitButton
                    className={teamButtonClass("primary", "sm")}
                    pendingLabel="Saving..."
                  >
                    Save note
                  </SubmitButton>
                </form>
              </div>
            </div>
          </details>
        </div>
      ) : a.notes.length ? (
        <details className="mt-4 rounded-2xl border border-slate-200 bg-white p-3">
          <summary className={summaryButtonClass("secondary")}>
            {notesLabel}
          </summary>
          <div className="mt-3 space-y-2">
            {a.notes.map((note) => (
              <div
                key={note.id}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700"
              >
                <div>{note.body}</div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {new Date(note.createdAt).toLocaleString(undefined, {
                    timeZone: TEAM_TIME_ZONE,
                  })}
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

function buildAttentionReasons(
  appointment: AppointmentDto,
  isQuoteOnly: boolean,
  serviceLabel: string | null,
  leadSourceSummary: string | null,
  pricingSummary: string | null,
  jobDetailsSummary: string | null,
  startDate: Date | null,
  now: Date,
): string[] {
  const reasons: string[] = [];
  const quoteFollowUpDate = appointment.quoteFollowUp?.dueAt
    ? new Date(appointment.quoteFollowUp.dueAt)
    : null;
  const validQuoteFollowUpDate =
    quoteFollowUpDate && !Number.isNaN(quoteFollowUpDate.getTime())
      ? quoteFollowUpDate
      : null;

  if (!appointment.contact.phone?.trim()) {
    reasons.push("Missing phone");
  }

  if (!appointment.property.addressLine1?.trim()) {
    reasons.push("Missing address");
  }

  if (!startDate) {
    reasons.push("Missing time");
  } else if (!isQuoteOnly && startDate.getTime() < now.getTime()) {
    reasons.push("Past due");
  } else if (isQuoteOnly && startDate.getTime() < now.getTime()) {
    if (!validQuoteFollowUpDate) {
      reasons.push("Missing follow-up");
    } else if (validQuoteFollowUpDate.getTime() < now.getTime()) {
      reasons.push("Follow-up overdue");
    }
  }

  if (!isQuoteOnly) {
    if (!appointment.soldByMemberId) {
      reasons.push("Missing seller");
    }
    if (!leadSourceSummary) {
      reasons.push("Missing source");
    }
    if (!pricingSummary) {
      reasons.push("Missing pricing");
    }
    if (!jobDetailsSummary) {
      reasons.push(
        serviceLabel === "Junk removal"
          ? "Missing load size"
          : "Missing job details",
      );
    }
  }

  return Array.from(new Set(reasons));
}

function toAppointmentCardItem(
  appointment: AppointmentDto,
  teamMemberNameById: Map<string, string>,
  now: Date,
): AppointmentCardItem {
  const isQuoteOnly = isQuoteOnlyAppointment(appointment.appointmentType);
  const startDate = appointment.startAt ? new Date(appointment.startAt) : null;
  const validStartDate =
    startDate && !Number.isNaN(startDate.getTime()) ? startDate : null;
  const leadSourceSummary =
    formatAppointmentLeadSource(
      appointment.bookingDetails,
      teamMemberNameById,
    ) ??
    formatStoredContactSource(appointment.contact.source, teamMemberNameById);
  const serviceLabel = formatAppointmentServiceType(appointment.bookingDetails);
  const pricingSummary = formatAppointmentPricing(
    appointment.bookingDetails,
    appointment.quotedTotalCents,
  );
  const jobDetailsSummary = formatAppointmentJobDetails(
    appointment.bookingDetails,
  );
  return {
    appointment,
    startDate: validStartDate,
    startDayKey: validStartDate ? formatDayKey(validStartDate) : "",
    isQuoteOnly,
    serviceLabel,
    leadSourceSummary,
    pricingSummary,
    jobDetailsSummary,
    attentionReasons:
      appointment.status === "confirmed"
        ? buildAttentionReasons(
            appointment,
            isQuoteOnly,
            serviceLabel,
            leadSourceSummary,
            pricingSummary,
            jobDetailsSummary,
            validStartDate,
            now,
          )
        : [],
  };
}

export async function MyDaySection(): Promise<ReactElement> {
  const now = new Date();
  const todayKey = formatDayKey(now);
  const todayRange = getTeamDayRange(now);

  let confirmedAppointments: AppointmentDto[] = [];
  let completedTodayAppointments: AppointmentDto[] = [];
  let loadMessages: string[] = [];
  let teamMembers: TeamMemberDto[] = [];

  try {
    const [confirmedRes, completedTodayRes, membersRes] = await Promise.all([
      callAdminApi("/api/appointments?status=confirmed"),
      callAdminApi(
        `/api/appointments?status=completed&startAtFrom=${encodeURIComponent(todayRange.startIso)}&startAtTo=${encodeURIComponent(todayRange.endIso)}`,
      ),
      callAdminApi("/api/admin/team/directory"),
    ]);

    if (!confirmedRes.ok) {
      loadMessages.push(
        `Appointments request failed (HTTP ${confirmedRes.status})`,
      );
    } else {
      const payload = (await confirmedRes.json()) as {
        ok: boolean;
        data: AppointmentDto[];
      };
      confirmedAppointments = (payload.data ?? []).sort((a, b) => {
        const ax = a.startAt ? Date.parse(a.startAt) : Number.POSITIVE_INFINITY;
        const bx = b.startAt ? Date.parse(b.startAt) : Number.POSITIVE_INFINITY;
        return ax - bx;
      });
    }

    if (!completedTodayRes.ok) {
      loadMessages.push(
        `Done today request failed (HTTP ${completedTodayRes.status})`,
      );
    } else {
      const payload = (await completedTodayRes.json()) as {
        ok: boolean;
        data: AppointmentDto[];
      };
      completedTodayAppointments = (payload.data ?? []).sort((a, b) => {
        const ax = a.startAt ? Date.parse(a.startAt) : Number.POSITIVE_INFINITY;
        const bx = b.startAt ? Date.parse(b.startAt) : Number.POSITIVE_INFINITY;
        return ax - bx;
      });
    }

    if (!membersRes.ok) {
      loadMessages.push(`Team directory failed (HTTP ${membersRes.status})`);
    } else {
      const payload = (await membersRes.json()) as {
        members?: TeamMemberDto[];
      };
      teamMembers = payload.members ?? [];
    }
  } catch (error) {
    loadMessages = [`Appointments request error: ${(error as Error).message}`];
  }

  const teamMemberNameById = new Map(
    teamMembers.map((member) => [member.id, member.name]),
  );

  const confirmedItems = confirmedAppointments.map((appointment) =>
    toAppointmentCardItem(appointment, teamMemberNameById, now),
  );
  const completedTodayItems = completedTodayAppointments.map((appointment) =>
    toAppointmentCardItem(appointment, teamMemberNameById, now),
  );

  const needsAttention = confirmedItems.filter(
    (item) => item.attentionReasons.length > 0,
  );
  const readyItems = confirmedItems.filter(
    (item) => item.attentionReasons.length === 0,
  );
  const todayReady = readyItems.filter((item) => item.startDayKey === todayKey);
  const futureReady = readyItems.filter((item) => item.startDayKey > todayKey);

  const upNext = todayReady[0] ?? futureReady[0] ?? null;
  const laterToday = upNext
    ? todayReady.filter((item) => item.appointment.id !== upNext.appointment.id)
    : todayReady;
  const comingUp = upNext
    ? futureReady.filter(
        (item) => item.appointment.id !== upNext.appointment.id,
      )
    : futureReady;

  const hasAnySections =
    Boolean(upNext) ||
    needsAttention.length > 0 ||
    laterToday.length > 0 ||
    comingUp.length > 0 ||
    completedTodayItems.length > 0;

  return (
    <section className="space-y-6">
      {loadMessages.length ? (
        <div className="space-y-2">
          {loadMessages.map((message) => (
            <p
              key={message}
              className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
            >
              {message}
            </p>
          ))}
        </div>
      ) : null}

      {!hasAnySections ? (
        <p className={TEAM_EMPTY_STATE}>No confirmed visits.</p>
      ) : null}

      {upNext ? (
        <AppointmentSection
          title="Up next"
          subtitle="The next stop that deserves focus right now."
          items={[upNext]}
          tone="emerald"
          teamMembers={teamMembers}
          teamMemberNameById={teamMemberNameById}
        />
      ) : null}

      {needsAttention.length ? (
        <AppointmentSection
          title="Needs attention"
          subtitle="Appointments that are overdue or missing important info."
          items={needsAttention}
          tone="amber"
          teamMembers={teamMembers}
          teamMemberNameById={teamMemberNameById}
        />
      ) : null}

      {laterToday.length ? (
        <AppointmentSection
          title="Later today"
          subtitle="Everything still on deck for the rest of today."
          items={laterToday}
          tone="sky"
          teamMembers={teamMembers}
          teamMemberNameById={teamMemberNameById}
        />
      ) : null}

      {comingUp.length ? (
        <AppointmentSection
          title="Coming up"
          subtitle="Future appointments after today."
          items={comingUp}
          tone="slate"
          teamMembers={teamMembers}
          teamMemberNameById={teamMemberNameById}
        />
      ) : null}

      {completedTodayItems.length ? (
        <AppointmentSection
          title="Done today"
          subtitle="Completed appointments scheduled for today."
          items={completedTodayItems}
          tone="slate"
          teamMembers={teamMembers}
          teamMemberNameById={teamMemberNameById}
        />
      ) : null}
    </section>
  );
}

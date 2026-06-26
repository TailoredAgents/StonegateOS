import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { Inbox, CalendarDays, ContactRound, FileText, Home, MessageSquare, ReceiptText, Settings, ShieldCheck, UserCog } from "lucide-react";
import { hasMobilePermission, resolveMobileSessionFromCookies } from "./lib/session";
import { callAdminApi } from "../team/lib/api";
import {
  createMobileExpenseAction,
  addMobileContactNoteAction,
  addMobileAppointmentNoteAction,
  bookMobileAppointmentAction,
  closeMobileThreadAction,
  createMobileQuoteAction,
  createMobileTeamMemberAction,
  markMobileThreadHandledAction,
  mobileLogoutAction,
  openMobileAppointmentThreadAction,
  openMobileContactThreadAction,
  runMobilePayoutAction,
  rescheduleMobileAppointmentAction,
  sendMobileTeamInviteAction,
  startMobileContactCallAction,
  sendMobileQuoteAction,
  updateMobileAppointmentEtaStatusAction,
  updateMobileAppointmentStatusAction,
  updateMobileContactAction,
  updateMobileTeamMemberAction,
  updateMobileQuoteAction,
  updateMobileQuoteDecisionAction
} from "./actions";
import { formatDayKey, TEAM_TIME_ZONE } from "../team/lib/timezone";
import { OfflineBanner } from "./OfflineBanner";
import { InboxRefresh } from "./InboxRefresh";
import { MobileInboxMediaGallery } from "./MobileInboxMediaGallery";
import { MobileThreadConversation } from "./MobileThreadConversation";
import { MobileAppointmentPricingFields } from "./MobileAppointmentPricingFields";
import { loadMobileOwnerSummary, type MobileOwnerSummary } from "./lib/owner-summary";
import type { AppointmentBookingDetails } from "../team/lib/booking-details";

const navItems: Array<{ id: string; label: string; href: Route; icon: typeof Inbox }> = [
  { id: "inbox", label: "Inbox", href: "/mobile", icon: Inbox },
  { id: "myday", label: "Today", href: "/mobile?screen=myday", icon: Home },
  { id: "contacts", label: "People", href: "/mobile?screen=contacts", icon: ContactRound },
  { id: "calendar", label: "Cal", href: "/mobile?screen=calendar", icon: CalendarDays },
  { id: "quotes", label: "Quotes", href: "/mobile?screen=quotes", icon: FileText },
  { id: "expenses", label: "Spend", href: "/mobile?screen=expenses", icon: ReceiptText },
  { id: "owner", label: "Owner", href: "/mobile?screen=owner", icon: ShieldCheck },
  { id: "access", label: "Access", href: "/mobile?screen=access", icon: UserCog },
  { id: "settings", label: "More", href: "/mobile?screen=settings", icon: Settings }
];

function labelForRole(role: string | null): string {
  if (role === "owner") return "Owner";
  if (role === "sales") return "Sales";
  if (role === "crew") return "Crew";
  if (role === "office") return "Office";
  return "Team";
}

type ThreadSummary = {
  id: string;
  status: string;
  state?: string;
  channel: string;
  subject: string | null;
  sourceFamily?: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  waitingSince?: string | null;
  attentionReason?: string | null;
  needsAttention?: boolean;
  priorityScore?: number;
  closedReason?: string | null;
  closedAt?: string | null;
  doNotContact?: boolean;
  mediaCount?: number;
  contact: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
  } | null;
  property: {
    id: string;
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
    outOfArea?: boolean | null;
  } | null;
  messageCount: number;
};

type MessageDetail = {
  id: string;
  direction: string;
  channel: string;
  body: string;
  mediaUrls?: string[];
  deliveryStatus: string;
  participantName: string | null;
  createdAt: string;
};

type ThreadDetail = {
  id: string;
  status: string;
  state?: string;
  channel: string;
  subject: string | null;
  lastMessageAt: string | null;
  lastInboundAt?: string | null;
  attentionHandledAt?: string | null;
  closedReason?: string | null;
  closedAt?: string | null;
  doNotContact?: boolean;
  doNotContactReason?: string | null;
  contact: ThreadSummary["contact"];
  property: ThreadSummary["property"];
};

type ThreadsResponse = {
  threads?: ThreadSummary[];
};

type ThreadResponse = {
  thread?: ThreadDetail;
  messages?: MessageDetail[];
};

type ContactSummary = {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
  source: string | null;
  pipeline?: {
    stage?: string | null;
    notes?: string | null;
    updatedAt?: string | null;
  };
  properties?: Array<{
    id: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    postalCode: string;
  }>;
  notes?: Array<{
    id: string;
    body: string;
    createdAt: string;
    updatedAt: string;
  }>;
  reminders?: Array<{
    id: string;
    title: string;
    dueAt: string | null;
    status: string | null;
  }>;
  stats?: {
    appointments?: number;
    quotes?: number;
  };
};

type ContactResponse = {
  contacts?: ContactSummary[];
  contact?: ContactSummary;
};

type CalendarEvent = {
  id: string;
  title: string;
  source: "db" | "google";
  start: string;
  end: string;
  appointmentId?: string;
  appointmentType?: string | null;
  rescheduleToken?: string | null;
  contactName?: string | null;
  address?: string | null;
  status?: string | null;
  quotedTotalCents?: number | null;
  finalTotalCents?: number | null;
  bookingDetails?: AppointmentBookingDetails | null;
  eta?: EtaSummary;
  notes?: Array<{ id: string; body: string; createdAt: string }>;
};

type EtaSummary = {
  status: string | null;
  eventType: string | null;
  eventSource: string | null;
  eventAt: string | null;
  locationFreshness: string;
  pendingDraft: {
    id: string;
    reason: string;
    body: string;
    confidence: string;
    createdAt: string;
  } | null;
};

type CalendarFeedResponse = {
  ok?: boolean;
  appointments?: CalendarEvent[];
  externalEvents?: CalendarEvent[];
};

type QuoteSummary = {
  id: string;
  status: string;
  displayStatus: string;
  quoteNumber: string | null;
  services: string[];
  addOns: string[] | null;
  total: number;
  lineItems?: Array<{ id?: string; label?: string; amount?: number; category?: string }> | null;
  notes?: string | null;
  clientScope?: string | null;
  jobDurationMinutes: number;
  viewedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  decisionAt: string | null;
  decisionNotes: string | null;
  refreshRequestedAt: string | null;
  acceptedAppointmentId: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  expiresAt: string | null;
  shareToken: string | null;
  contact: { name: string; email: string | null };
  property: { addressLine1: string; city: string; state: string; postalCode: string };
};

type QuotesResponse = {
  quotes?: QuoteSummary[];
};

type MobileExpense = {
  id: string;
  amountCents: number;
  currency: string;
  category: string | null;
  vendor: string | null;
  memo: string | null;
  method: string | null;
  source: string;
  paidAt: string;
  receipt: { filename: string; contentType: string } | null;
};

type MobileExpensesResponse = {
  expenses?: MobileExpense[];
};

type OwnerHealthStatus = MobileOwnerSummary["health"]["providers"][number]["status"];

type RoleSummary = {
  id: string;
  name: string;
  slug: string;
  permissions: string[];
};

type TeamMemberSummary = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  passwordSet?: boolean;
  active: boolean;
  role: {
    id: string;
    name: string | null;
    slug: string | null;
  } | null;
};

type AccessResponse = {
  roles?: RoleSummary[];
  members?: TeamMemberSummary[];
};

type DetectedAddress = {
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
};

const quoteStatusFilters = ["all", "pending", "sent", "accepted", "declined"] as const;

const mobileQuoteServices = [
  { id: "single-item", label: "Rubbish" },
  { id: "furniture", label: "Furniture" },
  { id: "appliances", label: "Appliances" },
  { id: "yard-waste", label: "Yard Waste" },
  { id: "construction-debris", label: "Construction Debris" },
  { id: "hot-tub", label: "Hot Tub" },
  { id: "other", label: "Other" }
];

function formatRelativeTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60_000));
  if (diffMinutes < 1) return "Now";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDateLabel(dayKey: string): string {
  const date = parseDayKey(dayKey);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(date);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatMobileDateTime(value: string, timezone = TEAM_TIME_ZONE): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatTimeInputValue(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return date.toLocaleTimeString("en-GB", {
      timeZone: TEAM_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  } catch {
    return "";
  }
}

function formatUsdCents(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "$0";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value / 100);
}

function formatUsdDollars(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "$0";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function buildMapsDirectionsHref(address: string | null | undefined): string | null {
  const query = typeof address === "string" ? address.trim() : "";
  if (!query) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`;
}

function quoteServiceAmount(quote: QuoteSummary, serviceId: string): string {
  const line = quote.lineItems?.find((item) => item.id === `service-${serviceId}`);
  if (!line || typeof line.amount !== "number" || !Number.isFinite(line.amount)) return "";
  return line.amount.toFixed(2).replace(/\.00$/, "");
}

function parseDayKey(value: string | null | undefined): Date {
  const raw = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return new Date();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return new Date();
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function addDaysToKey(dayKey: string, days: number): string {
  const date = parseDayKey(dayKey);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDayKey(date);
}

function startOfWeekKey(dayKey: string): string {
  const date = parseDayKey(dayKey);
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return formatDayKey(date);
}

function weekDayKeys(dayKey: string): string[] {
  const start = startOfWeekKey(dayKey);
  return Array.from({ length: 7 }, (_, index) => addDaysToKey(start, index));
}

function dayShortLabel(dayKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    weekday: "short"
  }).format(parseDayKey(dayKey));
}

function dayNumberLabel(dayKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    day: "numeric"
  }).format(parseDayKey(dayKey));
}

function getProjectedEventRange(event: CalendarEvent): { minCents: number; maxCents: number } | null {
  if (event.source !== "db") return null;
  const status = (event.status ?? "").trim().toLowerCase();
  if (status === "canceled" || status === "cancelled") return null;
  const type = (event.appointmentType ?? "").trim().toLowerCase();
  if (type === "in_person_quote" || type === "in_person_estimate") return null;

  const finalTotal = normalizeCents(event.finalTotalCents);
  if (finalTotal !== null) return { minCents: finalTotal, maxCents: finalTotal };

  const pricing = event.bookingDetails?.pricing;
  const rangeMin = normalizeCents(pricing?.rangeMinCents);
  const rangeMax = normalizeCents(pricing?.rangeMaxCents);
  if (
    pricing &&
    (pricing.mode === "range" || pricing.mode === "both") &&
    rangeMin !== null &&
    rangeMax !== null
  ) {
    return { minCents: rangeMin, maxCents: rangeMax };
  }

  const quotedTotal = normalizeCents(event.quotedTotalCents);
  return quotedTotal !== null
    ? { minCents: quotedTotal, maxCents: quotedTotal }
    : null;
}

function normalizeCents(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function formatCompactUsdCents(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value / 100);
}

function isCanceledEvent(event: CalendarEvent): boolean {
  const status = (event.status ?? "").trim().toLowerCase();
  return status === "canceled" || status === "cancelled";
}

function eventDayKey(event: CalendarEvent): string {
  return formatDayKey(new Date(event.start));
}

function eventsForDay(events: CalendarEvent[], dayKey: string): CalendarEvent[] {
  return events
    .filter((event) => eventDayKey(event) === dayKey)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

function projectedRangeForEvents(events: CalendarEvent[]): { minCents: number; maxCents: number } {
  return events.reduce(
    (sum, event) => {
      const range = getProjectedEventRange(event);
      if (!range) return sum;
      return {
        minCents: sum.minCents + range.minCents,
        maxCents: sum.maxCents + range.maxCents
      };
    },
    { minCents: 0, maxCents: 0 }
  );
}

function formatProjectedRange(events: CalendarEvent[]): string {
  const range = projectedRangeForEvents(events);
  if (range.minCents <= 0 && range.maxCents <= 0) return "$0";
  if (range.minCents === range.maxCents) return formatUsdCents(range.maxCents);
  return `${formatUsdCents(range.minCents)} - ${formatUsdCents(range.maxCents)}`;
}

function formatCompactProjectedRange(events: CalendarEvent[]): string {
  const range = projectedRangeForEvents(events);
  if (range.minCents <= 0 && range.maxCents <= 0) return "$0";
  if (range.minCents === range.maxCents) return formatCompactUsdCents(range.maxCents);
  return `${formatCompactUsdCents(range.minCents)}-${formatCompactUsdCents(range.maxCents)}`;
}

function formatEventPricing(event: CalendarEvent): string | null {
  if (event.source !== "db") return null;
  const finalTotal = normalizeCents(event.finalTotalCents);
  if (finalTotal !== null) return `Collected ${formatUsdCents(finalTotal)}`;

  const pricing = event.bookingDetails?.pricing;
  const exact = normalizeCents(event.quotedTotalCents);
  const rangeMin = normalizeCents(pricing?.rangeMinCents);
  const rangeMax = normalizeCents(pricing?.rangeMaxCents);
  const rangeLabel =
    rangeMin !== null && rangeMax !== null
      ? `${formatUsdCents(rangeMin)} - ${formatUsdCents(rangeMax)}`
      : null;
  const exactLabel = exact !== null ? formatUsdCents(exact) : null;

  if (pricing?.mode === "range") return rangeLabel ? `Range ${rangeLabel}` : null;
  if (pricing?.mode === "both") {
    if (rangeLabel && exactLabel) return `${rangeLabel} / exact ${exactLabel}`;
    return rangeLabel ? `Range ${rangeLabel}` : exactLabel ? `Exact ${exactLabel}` : null;
  }
  if (pricing?.mode === "exact") return exactLabel ? `Exact ${exactLabel}` : null;
  return exactLabel ? `Quoted ${exactLabel}` : null;
}

function formatEventAmountBadge(event: CalendarEvent): string | null {
  if (event.source !== "db" || isCanceledEvent(event)) return null;
  const finalTotal = normalizeCents(event.finalTotalCents);
  if (finalTotal !== null) return formatUsdCents(finalTotal);
  const range = getProjectedEventRange(event);
  if (!range) return null;
  if (range.minCents === range.maxCents) return formatUsdCents(range.maxCents);
  return `${formatCompactUsdCents(range.minCents)} - ${formatCompactUsdCents(range.maxCents)}`;
}

function eventTone(event: CalendarEvent): {
  card: string;
  badge: string;
  time: string;
  amount: string;
} {
  if (isCanceledEvent(event)) {
    return {
      card: "border-rose-300/30 bg-rose-300/10",
      badge: "bg-rose-300/15 text-rose-100 ring-1 ring-rose-300/30",
      time: "text-rose-100",
      amount: "text-rose-100"
    };
  }
  if (isQuoteOnlyAppointmentType(event.appointmentType)) {
    return {
      card: "border-sky-300/30 bg-sky-300/10",
      badge: "bg-sky-300/15 text-sky-100 ring-1 ring-sky-300/30",
      time: "text-sky-100",
      amount: "text-sky-100"
    };
  }
  if (event.source !== "db") {
    return {
      card: "border-white/10 bg-white/[0.08]",
      badge: "bg-slate-800 text-slate-300 ring-1 ring-white/10",
      time: "text-cyan-200",
      amount: "text-cyan-200"
    };
  }
  return {
    card: "border-emerald-300/30 bg-emerald-300/10",
    badge: "bg-emerald-300/15 text-emerald-100 ring-1 ring-emerald-300/30",
    time: "text-emerald-100",
    amount: "text-emerald-100"
  };
}

function eventKindLabel(event: CalendarEvent): string {
  if (isCanceledEvent(event)) return "Canceled";
  if (isQuoteOnlyAppointmentType(event.appointmentType)) return "In-person quote";
  if (event.source !== "db") return "Calendar event";
  return event.status ? formatStage(event.status) : "Confirmed";
}

function formatStage(value: string | null | undefined): string {
  if (!value) return "New";
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatChannel(value: string): string {
  if (value === "sms") return "SMS";
  if (value === "dm") return "Messenger";
  if (value === "email") return "Email";
  if (value === "call") return "Call";
  return value || "Thread";
}

function sourceBadgeClass(value: string | null | undefined): string {
  if (value === "Google") return "border-emerald-300/30 bg-emerald-300/10 text-emerald-100";
  if (value === "Facebook") return "border-sky-300/30 bg-sky-300/10 text-sky-100";
  if (value === "Missed Call") return "border-amber-300/30 bg-amber-300/10 text-amber-100";
  if (value === "Website") return "border-cyan-300/30 bg-cyan-300/10 text-cyan-100";
  if (value === "Partner") return "border-violet-300/30 bg-violet-300/10 text-violet-100";
  return "border-white/10 bg-slate-800 text-slate-200";
}

function attentionLabel(thread: ThreadSummary): string {
  if (thread.doNotContact) return "DNC";
  if (thread.closedReason === "lost") return "Lost";
  if (thread.status === "closed") return "Closed";
  if (thread.attentionReason === "follow_up_due") return "Follow-up due";
  if (thread.attentionReason === "needs_reply") return "Needs reply";
  if (thread.attentionReason === "new_lead") return "New";
  if (thread.state === "booked") return "Booked";
  return thread.lastOutboundAt ? "Waiting" : formatStage(thread.state);
}

function attentionBadgeClass(thread: ThreadSummary): string {
  if (thread.doNotContact || thread.status === "closed") return "bg-slate-800 text-slate-300";
  if (thread.needsAttention) return "bg-cyan-300 text-slate-950";
  return "bg-slate-800 text-slate-300";
}

function formatProviderLabel(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function ownerHealthClass(status: OwnerHealthStatus): string {
  if (status === "healthy") return "border-emerald-300/30 bg-emerald-300/10 text-emerald-100";
  if (status === "degraded") return "border-rose-300/30 bg-rose-300/10 text-rose-100";
  return "border-amber-300/30 bg-amber-300/10 text-amber-100";
}

function isQuoteOnlyAppointmentType(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "in_person_quote" || normalized === "in_person_estimate";
}

const mobileEtaActions = [
  ["heading_there", "Heading"],
  ["on_site", "On site"],
  ["need_dump", "Need dump"],
  ["dump_complete", "Dump done"],
  ["finished", "Finished"]
] as const;

function formatEtaStatusLabel(value: string | null | undefined): string {
  if (!value) return "No ETA status";
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function MobileEtaControls({
  event,
  appointmentId,
  calendarDay,
  screen
}: {
  event: CalendarEvent;
  appointmentId: string;
  calendarDay: string;
  screen: "myday" | "calendar";
}) {
  if (!appointmentId || event.source !== "db" || isQuoteOnlyAppointmentType(event.appointmentType) || isCanceledEvent(event)) {
    return null;
  }
  return (
    <div className="rounded-md border border-cyan-300/20 bg-cyan-300/10 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-200">ETA</p>
          <p className="mt-1 truncate text-sm text-cyan-50">
            {formatEtaStatusLabel(event.eta?.status)}
            <span className="text-cyan-200/60"> · </span>
            GPS {event.eta?.locationFreshness ?? "missing"}
          </p>
        </div>
        {event.eta?.pendingDraft ? (
          <span className="shrink-0 rounded-full border border-cyan-300/30 px-2 py-1 text-[11px] font-semibold text-cyan-100">
            Draft
          </span>
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {mobileEtaActions.map(([value, label]) => (
          <form key={value} action={updateMobileAppointmentEtaStatusAction}>
            <input type="hidden" name="appointmentId" value={appointmentId} />
            <input type="hidden" name="date" value={calendarDay} />
            <input type="hidden" name="screen" value={screen} />
            <button
              type="submit"
              name="etaStatus"
              value={value}
              className="w-full rounded-md border border-cyan-300/20 bg-slate-950 px-2 py-2 text-xs font-semibold text-cyan-100"
            >
              {label}
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}

function detectAddressFromMessages(messages: MessageDetail[] | undefined): DetectedAddress | null {
  if (!Array.isArray(messages)) return null;
  const statePattern = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
  const addressPattern = new RegExp(
    `\\b(\\d{1,6}\\s+[A-Za-z0-9.'#\\-\\s]+?)\\s*,\\s*([A-Za-z.'\\-\\s]+?)\\s*,\\s*(${statePattern})\\s+(\\d{5}(?:-\\d{4})?)\\b`,
    "i"
  );

  for (const message of [...messages].reverse()) {
    const match = addressPattern.exec(message.body);
    if (!match) continue;
    return {
      addressLine1: match[1]?.replace(/\s+/g, " ").trim() ?? "",
      city: match[2]?.replace(/\s+/g, " ").trim() ?? "",
      state: (match[3] ?? "").toUpperCase(),
      postalCode: match[4] ?? ""
    };
  }
  return null;
}

function MobileCompleteAppointmentForm({
  event,
  appointmentId,
  calendarDay,
  screen,
  teamMembers
}: {
  event: CalendarEvent;
  appointmentId: string;
  calendarDay: string;
  screen: "myday" | "calendar";
  teamMembers: TeamMemberSummary[];
}) {
  const status = (event.status ?? "").trim().toLowerCase();
  if (!appointmentId || status === "completed") return null;

  const isQuoteOnly = isQuoteOnlyAppointmentType(event.appointmentType);
  const amountDefault =
    normalizeCents(event.finalTotalCents) !== null
      ? (normalizeCents(event.finalTotalCents)! / 100).toFixed(2)
      : normalizeCents(event.quotedTotalCents) !== null
        ? (normalizeCents(event.quotedTotalCents)! / 100).toFixed(2)
        : "";
  const pricingContext = formatEventPricing(event);

  if (isQuoteOnly) {
    return (
      <form action={updateMobileAppointmentStatusAction}>
        <input type="hidden" name="appointmentId" value={appointmentId} />
        <input type="hidden" name="date" value={calendarDay} />
        <input type="hidden" name="screen" value={screen} />
        <input type="hidden" name="appointmentType" value={event.appointmentType ?? ""} />
        <button
          type="submit"
          name="status"
          value="completed"
          className="w-full rounded-md border border-emerald-300/30 bg-emerald-300/10 px-3 py-2 text-sm font-semibold text-emerald-100"
        >
          Quote done
        </button>
      </form>
    );
  }

  return (
    <details className="rounded-md border border-emerald-300/30 bg-emerald-300/10 p-3">
      <summary className="cursor-pointer list-none text-sm font-semibold text-emerald-100">Complete job</summary>
      <form action={updateMobileAppointmentStatusAction} className="mt-3 space-y-3">
        <input type="hidden" name="appointmentId" value={appointmentId} />
        <input type="hidden" name="date" value={calendarDay} />
        <input type="hidden" name="screen" value={screen} />
        <input type="hidden" name="appointmentType" value={event.appointmentType ?? ""} />
        <input type="hidden" name="status" value="completed" />
        {pricingContext ? (
          <div className="rounded-md border border-emerald-300/20 bg-slate-950 px-3 py-2 text-sm font-semibold text-emerald-100">
            {pricingContext}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs font-semibold text-slate-300">Collected $</span>
            <input
              name="finalTotal"
              type="number"
              min={0}
              step="0.01"
              required
              defaultValue={amountDefault}
              className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
              placeholder="350"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-300">Card tip</span>
            <input
              name="cardTip"
              type="number"
              min={0}
              step="0.01"
              className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
              placeholder="0"
            />
          </label>
        </div>
        <div className="rounded-md border border-white/10 bg-slate-950 p-3">
          <p className="text-xs font-semibold text-slate-300">Select who worked</p>
          <div className="mt-2 grid grid-cols-1 gap-2">
            {teamMembers.length ? teamMembers.map((member) => (
              <label key={member.id} className="flex cursor-pointer items-center gap-3 rounded-md border border-white/10 bg-slate-900 px-3 py-3 text-sm text-slate-200">
                <input name="crewMemberId" type="checkbox" value={member.id} className="h-5 w-5 rounded border-slate-500 bg-slate-950 accent-emerald-300" />
                <span className="min-w-0 truncate">{member.name}</span>
              </label>
            )) : (
              <p className="rounded-md border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs leading-5 text-amber-100">
                No active team members loaded. Refresh before marking this job complete.
              </p>
            )}
          </div>
        </div>
        <button type="submit" className="w-full rounded-md bg-emerald-300 px-3 py-2 text-sm font-semibold text-slate-950">
          Mark complete
        </button>
      </form>
    </details>
  );
}

function MobileWeekStrip({
  activeDay,
  days,
  events,
  screen
}: {
  activeDay: string;
  days: string[];
  events: CalendarEvent[];
  screen: "myday" | "calendar";
}) {
  const weekProjectedLabel = formatProjectedRange(events);
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Week</p>
          <h2 className="mt-1 text-lg font-semibold">{formatDateLabel(days[0] ?? activeDay)} - {formatDateLabel(days[6] ?? activeDay)}</h2>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-400">Week projected</p>
          <p className="text-xl font-semibold text-cyan-200">{weekProjectedLabel}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-7 gap-1.5">
        {days.map((dayKey) => {
          const dayEvents = eventsForDay(events, dayKey);
          const dayProjectedLabel = formatCompactProjectedRange(dayEvents);
          const active = dayKey === activeDay;
          const canceledCount = dayEvents.filter(isCanceledEvent).length;
          return (
            <Link
              key={dayKey}
              href={`/mobile?screen=${screen}&date=${encodeURIComponent(dayKey)}` as Route}
              className={[
                "min-w-0 rounded-md border px-1.5 py-2 text-center",
                active
                  ? "border-cyan-300 bg-cyan-300 text-slate-950"
                  : "border-white/10 bg-slate-900 text-slate-200"
              ].join(" ")}
            >
              <span className={active ? "block text-[10px] font-semibold uppercase text-slate-800" : "block text-[10px] font-semibold uppercase text-slate-400"}>
                {dayShortLabel(dayKey)}
              </span>
              <span className="mt-1 block text-base font-semibold leading-none">{dayNumberLabel(dayKey)}</span>
              <span className={active ? "mt-1 block truncate text-[10px] font-semibold text-slate-800" : "mt-1 block truncate text-[10px] font-semibold text-cyan-200"}>
                {dayProjectedLabel}
              </span>
              <span className={active ? "mt-0.5 block text-[10px] text-slate-800" : "mt-0.5 block text-[10px] text-slate-500"}>
                {dayEvents.length}{canceledCount ? `/${canceledCount}x` : ""}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function MobileWeekAgenda({
  days,
  events,
  canOpenMessageThreads
}: {
  days: string[];
  events: CalendarEvent[];
  canOpenMessageThreads: boolean;
}) {
  const weekProjectedLabel = formatProjectedRange(events);
  const weekJobCount = events.filter((event) => event.source === "db" && !isQuoteOnlyAppointmentType(event.appointmentType)).length;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md border border-cyan-300/20 bg-cyan-300/10 p-3">
          <p className="text-xs text-cyan-100">Projected</p>
          <p className="mt-1 text-lg font-semibold text-cyan-100">{weekProjectedLabel}</p>
        </div>
        <div className="rounded-md border border-emerald-300/20 bg-emerald-300/10 p-3">
          <p className="text-xs text-emerald-100">Jobs</p>
          <p className="mt-1 text-lg font-semibold text-emerald-100">{weekJobCount}</p>
        </div>
        <div className="rounded-md border border-white/10 bg-white/[0.08] p-3">
          <p className="text-xs text-slate-400">Stops</p>
          <p className="mt-1 text-lg font-semibold text-white">{events.length}</p>
        </div>
      </div>

      {days.map((dayKey) => {
        const dayEvents = eventsForDay(events, dayKey);
        const dayProjectedLabel = formatProjectedRange(dayEvents);
        const dayJobCount = dayEvents.filter((event) => event.source === "db" && !isQuoteOnlyAppointmentType(event.appointmentType)).length;
        const dayCanceledCount = dayEvents.filter(isCanceledEvent).length;
        return (
          <section key={dayKey} className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.08]">
            <div className="flex items-start justify-between gap-3 border-b border-white/10 bg-slate-900/80 p-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">{dayShortLabel(dayKey)}</p>
                <h3 className="mt-1 text-lg font-semibold">{formatDateLabel(dayKey)}</h3>
                <p className="mt-1 text-xs text-slate-400">
                  {dayJobCount} {dayJobCount === 1 ? "job" : "jobs"}
                  {dayCanceledCount ? ` • ${dayCanceledCount} canceled` : ""}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-400">Day total</p>
                <p className="mt-1 text-xl font-semibold text-cyan-100">{dayProjectedLabel}</p>
              </div>
            </div>

            <div className="space-y-2 p-3">
              {dayEvents.length ? (
                dayEvents.map((event) => {
                  const appointmentId = event.appointmentId ?? (event.id.startsWith("db:") ? event.id.replace(/^db:/, "") : "");
                  const canUpdate = Boolean(appointmentId && event.source === "db");
                  const eventPricing = formatEventPricing(event);
                  const mapsHref = buildMapsDirectionsHref(event.address);
                  const tone = eventTone(event);
                  return (
                    <details key={event.id} className={`group overflow-hidden rounded-md border ${tone.card}`}>
                      <summary className="cursor-pointer list-none px-3 py-2 marker:hidden">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone.badge}`}>
                                {eventKindLabel(event)}
                              </span>
                              <span className={`shrink-0 text-sm font-semibold tabular-nums ${tone.time}`}>
                                {formatTime(event.start)} - {formatTime(event.end)}
                              </span>
                            </div>
                            <h4 className="mt-1 truncate text-base font-semibold text-white">{event.contactName ?? event.title}</h4>
                          </div>
                          <div className="shrink-0 text-xs font-semibold text-cyan-100">
                            <span className="group-open:hidden">Details</span>
                            <span className="hidden group-open:inline">Close</span>
                          </div>
                        </div>
                      </summary>

                      <div className="space-y-3 border-t border-white/10 px-3 pb-3 pt-2">
                        {mapsHref && event.address ? (
                          <a
                            href={mapsHref}
                            target="_blank"
                            rel="noreferrer"
                            className="block rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm font-semibold leading-5 text-cyan-100 underline-offset-4 hover:underline"
                          >
                            {event.address}
                          </a>
                        ) : event.address ? (
                          <p className="rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm leading-5 text-slate-300">{event.address}</p>
                        ) : null}
                        {event.notes?.length ? (
                          <div className="space-y-2 rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm leading-6 text-slate-300">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Notes</p>
                            {event.notes.map((note) => (
                              <p key={note.id}>{note.body}</p>
                            ))}
                          </div>
                        ) : (
                          <div className="rounded-md border border-dashed border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-500">
                            No notes.
                          </div>
                        )}
                        {eventPricing ? (
                          <div className="rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm font-semibold text-cyan-100">
                            {eventPricing}
                          </div>
                        ) : null}
                        <MobileEtaControls
                          event={event}
                          appointmentId={appointmentId}
                          calendarDay={dayKey}
                          screen="calendar"
                        />

                        {canUpdate ? (
                          <div className="grid grid-cols-2 gap-2">
                            {canOpenMessageThreads ? (
                              <form action={openMobileAppointmentThreadAction}>
                                <input type="hidden" name="appointmentId" value={appointmentId} />
                                <input type="hidden" name="date" value={dayKey} />
                                <input type="hidden" name="screen" value="calendar" />
                                <button
                                  type="submit"
                                  className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200"
                                >
                                  <MessageSquare className="h-4 w-4" aria-hidden="true" />
                                  Message
                                </button>
                              </form>
                            ) : null}
                            {!isCanceledEvent(event) ? (
                              <form action={updateMobileAppointmentStatusAction}>
                                <input type="hidden" name="appointmentId" value={appointmentId} />
                                <input type="hidden" name="date" value={dayKey} />
                                <input type="hidden" name="screen" value="calendar" />
                                <button
                                  type="submit"
                                  name="status"
                                  value="canceled"
                                  className="w-full rounded-md border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-sm font-semibold text-rose-100"
                                >
                                  Cancel
                                </button>
                              </form>
                            ) : (
                              <div className="w-full rounded-md border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-center text-sm font-semibold text-rose-100">
                                Canceled
                              </div>
                            )}
                            <details className="col-span-2 rounded-md border border-white/10 bg-slate-900 p-3">
                              <summary className="cursor-pointer list-none text-sm font-semibold text-cyan-100">
                                Reschedule
                              </summary>
                              <form action={rescheduleMobileAppointmentAction} className="mt-3 space-y-3">
                                <input type="hidden" name="appointmentId" value={appointmentId} />
                                <input type="hidden" name="currentDate" value={dayKey} />
                                <label className="block">
                                  <span className="text-xs font-semibold text-slate-300">Date</span>
                                  <input
                                    type="date"
                                    name="preferredDate"
                                    defaultValue={formatDayKey(new Date(event.start))}
                                    required
                                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"
                                  />
                                </label>
                                <label className="block">
                                  <span className="text-xs font-semibold text-slate-300">Time</span>
                                  <input
                                    type="time"
                                    name="startTime"
                                    defaultValue={formatTimeInputValue(event.start)}
                                    step={900}
                                    required
                                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"
                                  />
                                  <span className="mt-1 block text-xs text-slate-500">Eastern time</span>
                                </label>
                                <button
                                  type="submit"
                                  className="w-full rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950"
                                >
                                  Save new time
                                </button>
                              </form>
                            </details>
                          </div>
                        ) : null}
                      </div>
                    </details>
                  );
                })
              ) : (
                <div className="rounded-md border border-dashed border-white/15 bg-slate-900 p-4 text-sm leading-6 text-slate-400">
                  No appointments.
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

async function loadMobileThreads(input: { view?: string; status?: string; q?: string; limit?: number }): Promise<ThreadSummary[]> {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit ?? 25));
  if (input.view) params.set("view", input.view);
  if (input.status) params.set("status", input.status);
  if (input.q) params.set("q", input.q);
  const response = await callAdminApi(`/api/admin/inbox/threads?${params.toString()}`, { method: "GET" });
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => null)) as ThreadsResponse | null;
  return Array.isArray(payload?.threads) ? payload.threads : [];
}

async function loadMobileThread(threadId: string): Promise<ThreadResponse | null> {
  if (!threadId) return null;
  const response = await callAdminApi(`/api/admin/inbox/threads/${encodeURIComponent(threadId)}`, { method: "GET" });
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as ThreadResponse | null;
  return payload?.thread ? payload : null;
}

async function loadMobileContact(contactId: string | null | undefined): Promise<ContactSummary | null> {
  if (!contactId) return null;
  const response = await callAdminApi(`/api/admin/contacts?contactId=${encodeURIComponent(contactId)}&limit=1`, {
    method: "GET"
  });
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as ContactResponse | null;
  return payload?.contacts?.[0] ?? payload?.contact ?? null;
}

async function loadMobileContacts(input: { q: string }): Promise<ContactSummary[]> {
  const params = new URLSearchParams();
  params.set("limit", "25");
  if (input.q) params.set("q", input.q);
  const response = await callAdminApi(`/api/admin/contacts?${params.toString()}`, { method: "GET" });
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => null)) as ContactResponse | null;
  return Array.isArray(payload?.contacts) ? payload.contacts : [];
}

async function loadMobileCalendarRange(startDayKey: string, days: number): Promise<CalendarEvent[]> {
  const start = parseDayKey(startDayKey);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + Math.max(1, days));

  const response = await callAdminApi(
    `/api/admin/calendar/feed?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`,
    { method: "GET" }
  );
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => null)) as CalendarFeedResponse | null;
  const events = [...(payload?.appointments ?? []), ...(payload?.externalEvents ?? [])];
  return events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

async function loadMobileQuotes(status: string): Promise<QuoteSummary[]> {
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  const query = params.toString();
  const response = await callAdminApi(`/api/quotes${query ? `?${query}` : ""}`, { method: "GET" });
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => null)) as QuotesResponse | null;
  return Array.isArray(payload?.quotes) ? payload.quotes : [];
}

async function loadMobileExpenses(): Promise<MobileExpense[]> {
  const response = await callAdminApi("/api/admin/expenses?limit=12", { method: "GET" });
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => null)) as MobileExpensesResponse | null;
  return Array.isArray(payload?.expenses) ? payload.expenses : [];
}

async function loadMobileAccess(): Promise<{ roles: RoleSummary[]; members: TeamMemberSummary[] }> {
  const [rolesResponse, membersResponse] = await Promise.all([
    callAdminApi("/api/admin/roles", { method: "GET" }),
    callAdminApi("/api/admin/team/members", { method: "GET" })
  ]);

  const rolesPayload = rolesResponse.ok
    ? ((await rolesResponse.json().catch(() => null)) as AccessResponse | null)
    : null;
  const membersPayload = membersResponse.ok
    ? ((await membersResponse.json().catch(() => null)) as AccessResponse | null)
    : null;

  return {
    roles: Array.isArray(rolesPayload?.roles) ? rolesPayload.roles : [],
    members: Array.isArray(membersPayload?.members) ? membersPayload.members : []
  };
}

async function loadMobileTeamMembers(): Promise<TeamMemberSummary[]> {
  const response = await callAdminApi("/api/admin/team/members", { method: "GET" });
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => null)) as AccessResponse | null;
  return Array.isArray(payload?.members) ? payload.members.filter((member) => member.active !== false) : [];
}

function findLaunchMember(members: TeamMemberSummary[], name: string): TeamMemberSummary | null {
  const target = name.trim().toLowerCase();
  return (
    members.find((member) => {
      const memberName = member.name.trim().toLowerCase();
      const email = member.email?.trim().toLowerCase() ?? "";
      return memberName === target || memberName.startsWith(`${target} `) || email.startsWith(`${target}@`);
    }) ?? null
  );
}

export default async function MobileHomePage({
  searchParams
}: {
  searchParams?: Promise<{
    screen?: string;
    setup?: string;
    threadId?: string;
    contactId?: string;
    sent?: string;
    note?: string;
    task?: string;
    contact?: string;
    status?: string;
    view?: string;
    q?: string;
    date?: string;
    appointment?: string;
    booked?: string;
    upload?: string;
    quote?: string;
    quoteStatus?: string;
    expense?: string;
    payout?: string;
    account?: string;
    invite?: string;
    password?: string;
    call?: string;
    handled?: string;
    closed?: string;
    error?: string;
  }>;
}) {
  const session = await resolveMobileSessionFromCookies();
  if (!session) {
    redirect("/mobile/login");
  }

  const params = (await searchParams) ?? {};
  const requestedScreen = typeof params.screen === "string" ? params.screen : "inbox";
  const activeScreen = session.allowedScreens.includes(requestedScreen) ? requestedScreen : "inbox";
  const visibleNav = navItems.filter((item) => session.allowedScreens.includes(item.id));
  const activeLabel = navItems.find((item) => item.id === activeScreen)?.label ?? "Inbox";
  const needsPasswordSetup = params.setup === "1" && !session.teamMember.passwordSet;
  const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
  const contactId = typeof params.contactId === "string" ? params.contactId.trim() : "";
  const requestedInboxView = typeof params.view === "string" ? params.view.trim() : "";
  const inboxView = requestedInboxView === "attention" || requestedInboxView === "google" ? requestedInboxView : "all";
  const inboxStatus = typeof params.status === "string" && params.status.trim() ? params.status.trim() : "";
  const inboxQuery = typeof params.q === "string" ? params.q.trim() : "";
  const calendarDay = typeof params.date === "string" && params.date.trim() ? params.date.trim() : formatDayKey(new Date());
  const quoteStatus =
    typeof params.quoteStatus === "string" &&
    quoteStatusFilters.includes(params.quoteStatus as (typeof quoteStatusFilters)[number])
      ? params.quoteStatus
      : "all";
  const sent = params.sent === "1";
  const noteSaved = params.note === "1";
  const contactSaved = params.contact === "1";
  const appointmentSaved = params.appointment === "1";
  const appointmentBooked = params.booked === "1";
  const uploadSaved = params.upload === "1";
  const quoteSaved = params.quote === "1";
  const quoteSent = params.quote === "sent";
  const quoteUpdated = params.quote === "updated";
  const expenseSaved = params.expense === "1";
  const payoutAction = typeof params.payout === "string" ? params.payout : "";
  const accountCreated = params.account === "created";
  const accountUpdated = params.account === "updated";
  const inviteSent = params.invite === "sent";
  const passwordSaved = params.password === "saved";
  const callStarted = params.call === "started";
  const handledSaved = params.handled === "1";
  const threadClosed = params.closed === "1";
  const error = typeof params.error === "string" && params.error.trim().length ? params.error.trim() : null;
  const [threads, inboxCountThreads] =
    activeScreen === "inbox"
      ? await Promise.all([
          loadMobileThreads({ view: inboxView, status: inboxStatus, q: inboxQuery }),
          loadMobileThreads({ view: "all", limit: 200 })
        ])
      : [[], []];
  const inboxCounts = {
    attention: inboxCountThreads.filter((thread) => thread.needsAttention).length,
    google: inboxCountThreads.filter((thread) => thread.sourceFamily === "Google" && thread.status !== "closed" && !thread.doNotContact).length,
    facebook: inboxCountThreads.filter((thread) => thread.sourceFamily === "Facebook" && thread.status !== "closed" && !thread.doNotContact).length,
    due: inboxCountThreads.filter((thread) => thread.attentionReason === "follow_up_due").length
  };
  const contacts = activeScreen === "contacts" || activeScreen === "quotes" ? await loadMobileContacts({ q: inboxQuery }) : [];
  const contactDetail = activeScreen === "contacts" && contactId ? await loadMobileContact(contactId) : null;
  const calendarWeekDays = weekDayKeys(calendarDay);
  const calendarWeekEvents =
    activeScreen === "calendar" || activeScreen === "myday"
      ? (await loadMobileCalendarRange(calendarWeekDays[0] ?? calendarDay, 8)).filter((event) =>
          calendarWeekDays.includes(eventDayKey(event))
        )
      : [];
  const calendarEvents = eventsForDay(calendarWeekEvents, calendarDay);
  const visibleTodayEvents = activeScreen === "myday" ? calendarEvents.filter((event) => !isCanceledEvent(event)) : calendarEvents;
  const teamMembers = activeScreen === "myday" ? await loadMobileTeamMembers() : [];
  const allQuotes = activeScreen === "quotes" ? await loadMobileQuotes("all") : [];
  const quotes = quoteStatus === "all" ? allQuotes : allQuotes.filter((quote) => quote.status === quoteStatus);
  const expenses = activeScreen === "expenses" ? await loadMobileExpenses() : [];
  const ownerSummary = activeScreen === "owner" && session.isOwner ? await loadMobileOwnerSummary() : null;
  const accessData = activeScreen === "access" && session.isOwner ? await loadMobileAccess() : null;
  const canOpenMessageThreads = hasMobilePermission(session.teamMember.permissions, "messages.read");
  const canStartMessageThreads = hasMobilePermission(session.teamMember.permissions, "messages.send");
  const canWriteExpenses = hasMobilePermission(session.teamMember.permissions, "expenses.write");
  const calendarWeekProjectedLabel = formatProjectedRange(calendarWeekEvents);
  const selectedThread = activeScreen === "inbox" && threadId ? await loadMobileThread(threadId) : null;
  const selectedContact = selectedThread?.thread?.contact?.id
    ? await loadMobileContact(selectedThread.thread.contact.id)
    : null;
  const detectedThreadAddress = selectedThread ? detectAddressFromMessages(selectedThread.messages) : null;
  const selectedThreadMediaMessages =
    selectedThread?.messages?.filter((message) => Array.isArray(message.mediaUrls) && message.mediaUrls.length > 0) ?? [];
  const quoteStatusCounts = quoteStatusFilters.reduce(
    (counts, status) => ({
      ...counts,
      [status]: status === "all" ? allQuotes.length : allQuotes.filter((quote) => quote.status === status).length
    }),
    {} as Record<(typeof quoteStatusFilters)[number], number>
  );
  const openQuoteValue = allQuotes
    .filter((quote) => quote.status === "pending" || quote.status === "sent")
    .reduce((sum, quote) => sum + (typeof quote.total === "number" && Number.isFinite(quote.total) ? quote.total : 0), 0);
  const ownerRole = accessData?.roles.find((role) => role.slug === "owner") ?? null;
  const salesRole = accessData?.roles.find((role) => role.slug === "sales") ?? null;
  const launchAccounts = accessData
    ? [
        { name: "Jeffrey", expectedRole: "owner", role: ownerRole, member: findLaunchMember(accessData.members, "Jeffrey") },
        { name: "Austin", expectedRole: "owner", role: ownerRole, member: findLaunchMember(accessData.members, "Austin") },
        { name: "Devon", expectedRole: "sales", role: salesRole, member: findLaunchMember(accessData.members, "Devon") }
      ]
    : [];
  const mobileJobEvents = visibleTodayEvents.filter((event) => event.source === "db" && !isQuoteOnlyAppointmentType(event.appointmentType));

  return (
    <main className="min-h-dvh bg-slate-950 text-white">
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
        <header className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/95 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">StonegateOS</p>
              <h1 className="mt-1 text-xl font-semibold">{activeLabel}</h1>
            </div>
            <div className="min-w-0 rounded-md border border-white/10 bg-white/[0.08] px-3 py-2 text-right">
              <p className="truncate text-sm font-semibold">{session.teamMember.name}</p>
              <p className="text-xs text-slate-300">{labelForRole(session.teamMember.roleSlug)}</p>
            </div>
          </div>
        </header>

        <section className="flex-1 space-y-4 px-4 py-4">
          <OfflineBanner />
          {activeScreen === "inbox" ? <InboxRefresh threadId={threadId} /> : null}

          {needsPasswordSetup ? (
            <div className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-100">
              <p className="font-semibold">Set your password</p>
              <p className="mt-1 leading-6">Minimum 10 characters. This lets you sign in without waiting for a magic link.</p>
              <form action="/mobile/password" method="post" className="mt-3 space-y-3">
                <input type="hidden" name="next" value="/mobile?setup=1" />
                <input
                  name="password"
                  type="password"
                  minLength={10}
                  required
                  className="w-full rounded-md border border-amber-300/20 bg-slate-950 px-3 py-2 text-sm text-white"
                  placeholder="New password"
                />
                <input
                  name="confirmPassword"
                  type="password"
                  minLength={10}
                  required
                  className="w-full rounded-md border border-amber-300/20 bg-slate-950 px-3 py-2 text-sm text-white"
                  placeholder="Confirm password"
                />
                <button type="submit" className="w-full rounded-md bg-amber-200 px-3 py-2 text-sm font-semibold text-slate-950">
                  Save password
                </button>
              </form>
            </div>
          ) : null}

          {sent ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Message queued.
            </div>
          ) : null}
          {noteSaved ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Note saved.
            </div>
          ) : null}
          {contactSaved ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Contact updated.
            </div>
          ) : null}
          {appointmentSaved ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Appointment updated.
            </div>
          ) : null}
          {appointmentBooked ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Appointment booked.
            </div>
          ) : null}
          {uploadSaved ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Upload saved.
            </div>
          ) : null}
          {quoteSaved ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Quote created.
            </div>
          ) : null}
          {quoteSent ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Quote sent.
            </div>
          ) : null}
          {quoteUpdated ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Quote updated.
            </div>
          ) : null}
          {payoutAction ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              {payoutAction === "create"
                ? "Payout run created."
                : payoutAction === "lock"
                  ? "Payout run locked."
                  : payoutAction === "paid"
                    ? "Payout run marked paid."
                    : "Payout updated."}
            </div>
          ) : null}
          {accountCreated ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Team account created.
            </div>
          ) : null}
          {accountUpdated ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Team account updated.
            </div>
          ) : null}
          {inviteSent ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Mobile login link requested.
            </div>
          ) : null}
          {passwordSaved ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Password saved.
            </div>
          ) : null}
          {callStarted ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Ringing your phone now. Answer to connect with the customer.
            </div>
          ) : null}
          {handledSaved ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Thread marked handled.
            </div>
          ) : null}
          {threadClosed ? (
            <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-100">
              Thread closed.
            </div>
          ) : null}
          {error ? (
            <div className="rounded-lg border border-rose-300/30 bg-rose-300/10 p-4 text-sm text-rose-100">
              {error}
            </div>
          ) : null}

          {activeScreen === "inbox" ? (
            <div className="space-y-4">
              {selectedThread?.thread ? (
                <div className="rounded-lg border border-white/10 bg-white/[0.08]">
                  <div className="border-b border-white/10 p-4">
                    <Link href={`/mobile?view=${encodeURIComponent(inboxView)}` as Route} className="text-sm font-semibold text-cyan-200">
                      Back to inbox
                    </Link>
                    <div className="mt-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="truncate text-lg font-semibold">{selectedThread.thread.contact?.name ?? "Contact"}</h2>
                        <p className="mt-1 text-sm text-slate-300">
                          {formatChannel(selectedThread.thread.channel)}
                          {selectedThread.thread.property?.addressLine1 ? ` • ${selectedThread.thread.property.addressLine1}` : ""}
                        </p>
                      </div>
                      {selectedThread.thread.contact?.id && (selectedThread.thread.contact.phone || selectedContact?.phoneE164 || selectedContact?.phone) ? (
                        <form action={startMobileContactCallAction}>
                          <input type="hidden" name="contactId" value={selectedThread.thread.contact.id} />
                          <input type="hidden" name="threadId" value={selectedThread.thread.id} />
                          <input type="hidden" name="returnTo" value={`/mobile?threadId=${encodeURIComponent(threadId)}`} />
                          <button type="submit" className="rounded-md bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950">
                            Call
                          </button>
                        </form>
                      ) : null}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {selectedThread.thread.doNotContact ? (
                        <span className="rounded-full bg-rose-300/15 px-2.5 py-1 text-xs font-semibold text-rose-100">DNC</span>
                      ) : null}
                      {selectedThread.thread.closedReason ? (
                        <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">
                          {formatStage(selectedThread.thread.closedReason)}
                        </span>
                      ) : null}
                      <form action={markMobileThreadHandledAction}>
                        <input type="hidden" name="threadId" value={selectedThread.thread.id} />
                        <button type="submit" className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200">
                          Mark handled
                        </button>
                      </form>
                      <details className="relative">
                        <summary className="cursor-pointer list-none rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200">
                          Close
                        </summary>
                        <div className="absolute right-0 z-20 mt-2 w-64 rounded-md border border-white/10 bg-slate-950 p-3 shadow-xl">
                          <form action={closeMobileThreadAction} className="space-y-2">
                            <input type="hidden" name="threadId" value={selectedThread.thread.id} />
                            <button name="closeReason" value="lost" className="w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-left text-sm font-semibold text-slate-100">
                              Lost
                            </button>
                            <label className="block rounded-md border border-white/10 bg-slate-900 p-2">
                              <span className="text-xs font-semibold text-slate-300">DNC note</span>
                              <input
                                name="doNotContactReason"
                                className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-2 py-2 text-sm text-white outline-none focus:border-cyan-300"
                                placeholder="Stop request, wrong number..."
                              />
                              <button name="closeReason" value="do_not_contact" className="mt-2 w-full rounded-md border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-left text-sm font-semibold text-rose-100">
                                Do Not Contact
                              </button>
                            </label>
                            <button name="closeReason" value="closed" className="w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-left text-sm font-semibold text-slate-100">
                              Closed
                            </button>
                          </form>
                        </div>
                      </details>
                    </div>
                  </div>

                  {selectedThreadMediaMessages.length ? (
                    <div className="border-b border-white/10 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold text-white">Thread photos</h3>
                        <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">
                          {selectedThreadMediaMessages.reduce((sum, message) => sum + (message.mediaUrls?.length ?? 0), 0)}
                        </span>
                      </div>
                      <div className="mt-3 space-y-3">
                        {selectedThreadMediaMessages.slice(-8).map((message) => (
                          <MobileInboxMediaGallery key={`strip-${message.id}`} messageId={message.id} count={message.mediaUrls?.length ?? 0} compact />
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <MobileThreadConversation
                    threadId={selectedThread.thread.id}
                    channel={selectedThread.thread.channel}
                    initialMessages={selectedThread.messages ?? []}
                    doNotContact={selectedThread.thread.doNotContact === true}
                  />
                </div>
              ) : (
                <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-base font-semibold">
                      {inboxView === "google" ? "Google Leads" : inboxView === "all" ? "All Messages" : "Needs Attention"}
                    </h2>
                    <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">{threads.length}</span>
                  </div>

                  <div className="mt-4 grid grid-cols-4 gap-2">
                    <div className="rounded-md border border-white/10 bg-slate-900 px-2 py-2 text-center">
                      <p className="text-[10px] font-semibold text-slate-400">Attention</p>
                      <p className="mt-0.5 text-sm font-semibold text-white">{inboxCounts.attention}</p>
                    </div>
                    <div className="rounded-md border border-white/10 bg-slate-900 px-2 py-2 text-center">
                      <p className="text-[10px] font-semibold text-slate-400">Google</p>
                      <p className="mt-0.5 text-sm font-semibold text-emerald-100">{inboxCounts.google}</p>
                    </div>
                    <div className="rounded-md border border-white/10 bg-slate-900 px-2 py-2 text-center">
                      <p className="text-[10px] font-semibold text-slate-400">Facebook</p>
                      <p className="mt-0.5 text-sm font-semibold text-sky-100">{inboxCounts.facebook}</p>
                    </div>
                    <div className="rounded-md border border-white/10 bg-slate-900 px-2 py-2 text-center">
                      <p className="text-[10px] font-semibold text-slate-400">Due</p>
                      <p className="mt-0.5 text-sm font-semibold text-amber-100">{inboxCounts.due}</p>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {[
                      { id: "attention", label: "Needs Attention" },
                      { id: "google", label: "Google Leads" },
                      { id: "all", label: "All Messages" }
                    ].map((view) => {
                      const href = `/mobile?view=${view.id}${inboxQuery ? `&q=${encodeURIComponent(inboxQuery)}` : ""}` as Route;
                      return (
                        <Link
                          key={view.id}
                          href={href}
                          className={`rounded-md border px-2 py-2 text-center text-xs font-semibold ${
                            inboxView === view.id
                              ? "border-cyan-300 bg-cyan-300 text-slate-950"
                              : "border-white/10 bg-slate-900 text-slate-200"
                          }`}
                        >
                          {view.label}
                        </Link>
                      );
                    })}
                  </div>

                  <form action="/mobile" className="mt-4">
                    <input type="hidden" name="screen" value="inbox" />
                    <input type="hidden" name="view" value={inboxView} />
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-300">Search</span>
                      <input
                        name="q"
                        defaultValue={inboxQuery}
                        className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                        placeholder="Name, phone, message..."
                      />
                    </label>
                  </form>

                  <div className="mt-4 space-y-2">
                    {threads.length > 0 ? (
                      threads.map((thread) => {
                        const source = thread.sourceFamily ?? "Other";
                        const phone = thread.contact?.phone ?? null;
                        const threadHref = `/mobile?threadId=${encodeURIComponent(thread.id)}&view=${encodeURIComponent(inboxView)}` as Route;
                        return (
                          <div key={thread.id} className="rounded-md border border-white/10 bg-slate-900 p-3">
                            <Link href={threadHref} className="block">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                    <p className="truncate text-sm font-semibold text-white">{thread.contact?.name ?? thread.subject ?? "Thread"}</p>
                                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${sourceBadgeClass(source)}`}>
                                      {source}
                                    </span>
                                  </div>
                                  <p className="mt-1 line-clamp-2 text-sm leading-5 text-slate-300">
                                    {thread.lastMessagePreview ?? "No preview"}
                                  </p>
                                </div>
                                <div className="shrink-0 text-right">
                                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${attentionBadgeClass(thread)}`}>
                                    {attentionLabel(thread)}
                                  </span>
                                  <p className="mt-1 text-xs text-slate-400">
                                    {formatRelativeTime(thread.waitingSince ?? thread.lastMessageAt)}
                                  </p>
                                </div>
                              </div>
                              <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-slate-400">
                                <span>{formatChannel(thread.channel)}</span>
                                {thread.property?.addressLine1 ? <span className="truncate">{thread.property.addressLine1}</span> : null}
                                {(thread.mediaCount ?? 0) > 0 ? <span className="ml-auto shrink-0">{thread.mediaCount} photos</span> : null}
                              </div>
                            </Link>
                            {phone && thread.contact?.id ? (
                              <form action={startMobileContactCallAction} className="mt-3">
                                <input type="hidden" name="contactId" value={thread.contact.id} />
                                <input type="hidden" name="threadId" value={thread.id} />
                                <input type="hidden" name="returnTo" value={`/mobile?view=${encodeURIComponent(inboxView)}`} />
                                <button type="submit" className="w-full rounded-md border border-cyan-300/40 bg-cyan-300/10 px-3 py-2 text-sm font-semibold text-cyan-100">
                                  Call
                                </button>
                              </form>
                            ) : null}
                          </div>
                        );
                      })
                    ) : (
                      <div className="rounded-md border border-dashed border-white/15 bg-slate-900 p-4 text-sm leading-6 text-slate-300">
                        No inbox threads found for this view.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selectedContact ? (
                <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Contact</p>
                      <h2 className="mt-1 truncate text-lg font-semibold">{selectedContact.name}</h2>
                      <p className="mt-1 text-sm text-slate-300">
                        {selectedContact.phoneE164 ?? selectedContact.phone ?? "No phone"}
                        {selectedContact.email ? ` • ${selectedContact.email}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      {(selectedContact.phoneE164 ?? selectedContact.phone) ? (
                        <form action={startMobileContactCallAction}>
                          <input type="hidden" name="contactId" value={selectedContact.id} />
                          <input type="hidden" name="threadId" value={threadId} />
                          <input type="hidden" name="returnTo" value={`/mobile?threadId=${encodeURIComponent(threadId)}`} />
                          <button type="submit" className="rounded-md bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950">
                            Call
                          </button>
                        </form>
                      ) : null}
                      <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">
                        {formatStage(selectedContact.pipeline?.stage)}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                      <p className="text-xs text-slate-400">Appointments</p>
                      <p className="mt-1 text-xl font-semibold">{selectedContact.stats?.appointments ?? 0}</p>
                    </div>
                    <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                      <p className="text-xs text-slate-400">Quotes</p>
                      <p className="mt-1 text-xl font-semibold">{selectedContact.stats?.quotes ?? 0}</p>
                    </div>
                  </div>

                  {selectedContact.properties?.length ? (
                    <div className="mt-4">
                      <p className="text-xs font-semibold text-slate-300">Properties</p>
                      <div className="mt-2 space-y-2">
                        {selectedContact.properties.slice(0, 2).map((property) => (
                          <div key={property.id} className="rounded-md border border-white/10 bg-slate-900 p-3 text-sm text-slate-200">
                            <p>{property.addressLine1}</p>
                            <p className="mt-1 text-xs text-slate-400">
                              {[property.city, property.state, property.postalCode].filter(Boolean).join(", ")}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {selectedContact.notes?.length ? (
                    <div className="mt-4">
                      <p className="text-xs font-semibold text-slate-300">Recent Notes</p>
                      <div className="mt-2 space-y-2">
                        {selectedContact.notes.slice(0, 3).map((note) => (
                          <div key={note.id} className="rounded-md border border-white/10 bg-slate-900 p-3 text-sm leading-6 text-slate-200">
                            <p>{note.body}</p>
                            <p className="mt-1 text-xs text-slate-400">{formatRelativeTime(note.updatedAt)}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <details className="mt-4 rounded-md border border-white/10 bg-slate-900 p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-slate-100">Edit basic info</summary>
                    <form action={updateMobileContactAction} className="mt-3 space-y-3">
                      <input type="hidden" name="contactId" value={selectedContact.id} />
                      <input type="hidden" name="threadId" value={threadId} />
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-300">First</span>
                          <input
                            name="firstName"
                            required
                            defaultValue={selectedContact.firstName}
                            className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-300">Last</span>
                          <input
                            name="lastName"
                            required
                            defaultValue={selectedContact.lastName}
                            className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                          />
                        </label>
                      </div>
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-300">Phone</span>
                        <input
                          name="phone"
                          defaultValue={selectedContact.phoneE164 ?? selectedContact.phone ?? ""}
                          className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-300">Email</span>
                        <input
                          name="email"
                          type="email"
                          defaultValue={selectedContact.email ?? ""}
                          className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                        />
                      </label>
                      <button type="submit" className="w-full rounded-md border border-white/10 px-4 py-3 text-sm font-semibold text-white">
                        Save contact
                      </button>
                    </form>
                  </details>

                  <details className="mt-3 rounded-md border border-white/10 bg-slate-900 p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-slate-100">Book appointment</summary>
                    <form action={bookMobileAppointmentAction} className="mt-3 space-y-3">
                      <input type="hidden" name="contactId" value={selectedContact.id} />
                      <input type="hidden" name="threadId" value={threadId} />
                      {selectedContact.properties?.length ? (
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-300">Property</span>
                          <select
                            name="propertyId"
                            defaultValue={selectedContact.properties[0]?.id ?? ""}
                            className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                          >
                            {selectedContact.properties.map((property) => (
                              <option key={property.id} value={property.id}>
                                {[property.addressLine1, property.city, property.state].filter(Boolean).join(", ")}
                              </option>
                            ))}
                            <option value="">Add a new address below</option>
                          </select>
                          <span className="mt-1 block text-xs leading-5 text-slate-400">
                            Pick a saved address, or choose add new to save a different one.
                          </span>
                        </label>
                      ) : (
                        <input type="hidden" name="propertyId" value="" />
                      )}
                      <div className="rounded-md border border-white/10 bg-slate-950 p-3">
                        <p className="text-xs font-semibold text-slate-300">Add new address</p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">
                          Only used when you choose add new above, or when this contact has no saved address.
                        </p>
                        {detectedThreadAddress ? (
                          <p className="mt-1 text-xs leading-5 text-cyan-100">
                            Found in the thread and prefilled for faster new-address booking.
                          </p>
                        ) : null}
                        <div className="mt-2 space-y-2">
                          <label className="block">
                            <span className="text-xs font-semibold text-slate-400">Street</span>
                            <input
                              name="addressLine1"
                              defaultValue={detectedThreadAddress?.addressLine1 ?? ""}
                              className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                              placeholder="123 Main St"
                            />
                          </label>
                          <label className="block">
                            <span className="text-xs font-semibold text-slate-400">Unit / details</span>
                            <input
                              name="addressLine2"
                              className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                              placeholder="Apt, gate, building..."
                            />
                          </label>
                          <div className="grid grid-cols-[1fr_4rem_6rem] gap-2">
                            <label className="block">
                              <span className="text-xs font-semibold text-slate-400">City</span>
                              <input
                                name="city"
                                defaultValue={detectedThreadAddress?.city ?? ""}
                                className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                              />
                            </label>
                            <label className="block">
                              <span className="text-xs font-semibold text-slate-400">State</span>
                              <input
                                name="state"
                                defaultValue={detectedThreadAddress?.state ?? "GA"}
                                maxLength={2}
                                className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-2 py-2 text-base uppercase text-white outline-none focus:border-cyan-300"
                              />
                            </label>
                            <label className="block">
                              <span className="text-xs font-semibold text-slate-400">ZIP</span>
                              <input
                                name="postalCode"
                                defaultValue={detectedThreadAddress?.postalCode ?? ""}
                                inputMode="numeric"
                                className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-2 py-2 text-base text-white outline-none focus:border-cyan-300"
                              />
                            </label>
                          </div>
                        </div>
                      </div>
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-300">Start</span>
                        <input
                          name="startAt"
                          type="datetime-local"
                          required
                          className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-300">Minutes</span>
                        <input
                          name="durationMinutes"
                          type="number"
                          min="15"
                          step="15"
                          defaultValue="60"
                          className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                        />
                      </label>
                      <MobileAppointmentPricingFields sourceTeamMemberId={session.teamMember.id} />
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-300">Notes</span>
                        <textarea
                          name="notes"
                          rows={3}
                          className="mt-1 w-full resize-none rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                          placeholder="Gate code, job details, crew notes..."
                        />
                      </label>
                      <button type="submit" className="w-full rounded-md bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950">
                        Book appointment
                      </button>
                    </form>
                  </details>

                  <form action={addMobileContactNoteAction} className="mt-4 border-t border-white/10 pt-4">
                    <input type="hidden" name="contactId" value={selectedContact.id} />
                    <input type="hidden" name="threadId" value={threadId} />
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-300">Add note</span>
                      <textarea
                        name="body"
                        required
                        rows={3}
                        className="mt-1 w-full resize-none rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                        placeholder="Add customer context..."
                      />
                    </label>
                    <button type="submit" className="mt-3 w-full rounded-md border border-white/10 px-4 py-3 text-sm font-semibold text-white">
                      Save note
                    </button>
                  </form>
                </div>
              ) : null}
            </div>
          ) : activeScreen === "myday" ? (
            <div className="space-y-4">
              <MobileWeekStrip
                activeDay={calendarDay}
                days={calendarWeekDays}
                events={calendarWeekEvents}
                screen="myday"
              />

              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">My Day</p>
                <h2 className="mt-1 text-lg font-semibold">{formatDateLabel(calendarDay)}</h2>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                    <p className="text-xs text-slate-400">Stops</p>
                    <p className="mt-1 text-xl font-semibold">{visibleTodayEvents.length}</p>
                  </div>
                  <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                    <p className="text-xs text-slate-400">Jobs</p>
                    <p className="mt-1 text-xl font-semibold">{mobileJobEvents.length}</p>
                  </div>
                  <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                    <p className="text-xs text-slate-400">Projected</p>
                    <p className="mt-1 text-lg font-semibold text-cyan-200">{formatProjectedRange(visibleTodayEvents)}</p>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Link href="/mobile" className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-center text-sm font-semibold text-slate-200">
                    Inbox
                  </Link>
                  <Link href="/mobile?screen=calendar" className="rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-center text-sm font-semibold text-slate-950">
                    Calendar
                  </Link>
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-semibold">Today&apos;s Appointments</h2>
                  <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">{visibleTodayEvents.length}</span>
                </div>
                <div className="mt-3 space-y-2">
                  {visibleTodayEvents.length > 0 ? (
                    visibleTodayEvents.map((event) => {
                      const appointmentId = event.appointmentId ?? (event.id.startsWith("db:") ? event.id.replace(/^db:/, "") : "");
                      const canUpdate = Boolean(appointmentId && event.source === "db");
                      const eventAmountLabel = formatEventAmountBadge(event);
                      const eventPricing = formatEventPricing(event);
                      const mapsHref = buildMapsDirectionsHref(event.address);
                      const tone = eventTone(event);
                      return (
                        <div key={event.id} className={`rounded-md border p-3 ${tone.card}`}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className={`text-sm font-semibold ${tone.time}`}>
                                {formatTime(event.start)} - {formatTime(event.end)}
                              </p>
                              <p className="mt-1 truncate text-sm font-semibold text-white">{event.contactName ?? event.title}</p>
                              {mapsHref && event.address ? (
                                <a
                                  href={mapsHref}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 block text-sm font-semibold leading-5 text-cyan-100 underline-offset-4 hover:underline"
                                >
                                  {event.address}
                                </a>
                              ) : event.address ? (
                                <p className="mt-1 text-sm leading-5 text-slate-300">{event.address}</p>
                              ) : null}
                            </div>
                            <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${tone.badge}`}>
                              {eventKindLabel(event)}
                            </span>
                          </div>
                          {event.notes?.length ? (
                            <details className="mt-3 rounded-md border border-white/10 bg-slate-950 p-3" open={event.notes.length <= 2}>
                              <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
                                Notes ({event.notes.length})
                              </summary>
                              <div className="mt-2 space-y-2">
                                {event.notes.slice(0, 5).map((note) => (
                                  <div key={note.id} className="rounded-md border border-white/10 bg-slate-900 px-3 py-2">
                                    <p className="whitespace-pre-wrap text-sm leading-5 text-slate-200">{note.body}</p>
                                    <p className="mt-1 text-[11px] text-slate-500">
                                      {new Date(note.createdAt).toLocaleString("en-US", {
                                        timeZone: TEAM_TIME_ZONE,
                                        month: "short",
                                        day: "numeric",
                                        hour: "numeric",
                                        minute: "2-digit"
                                      })}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            </details>
                          ) : null}
                          {eventPricing ? (
                            <div className="mt-3 rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm font-semibold text-cyan-100">
                              {eventPricing}
                            </div>
                          ) : null}
                          <div className="mt-3">
                            <MobileEtaControls
                              event={event}
                              appointmentId={appointmentId}
                              calendarDay={calendarDay}
                              screen="myday"
                            />
                          </div>
                          {canUpdate ? (
                            <details className="mt-3 rounded-md border border-white/10 bg-slate-950 p-3">
                              <summary className="cursor-pointer list-none text-sm font-semibold text-cyan-100">Add note</summary>
                              <form action={addMobileAppointmentNoteAction} className="mt-3 space-y-3">
                                <input type="hidden" name="appointmentId" value={appointmentId} />
                                <input type="hidden" name="date" value={calendarDay} />
                                <textarea
                                  name="body"
                                  required
                                  rows={3}
                                  className="w-full resize-none rounded-md border border-white/10 bg-slate-900 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                                  placeholder="Gate code, call notes, customer context..."
                                />
                                <button type="submit" className="w-full rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950">
                                  Save note
                                </button>
                              </form>
                            </details>
                          ) : null}
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Link
                              href={`/mobile?screen=calendar&date=${encodeURIComponent(calendarDay)}` as Route}
                              className="rounded-md border border-white/10 px-3 py-2 text-xs font-semibold text-slate-200"
                            >
                              Open
                            </Link>
                            {mapsHref ? (
                              <a
                                href={mapsHref}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded-md border border-white/10 px-3 py-2 text-xs font-semibold text-slate-200"
                              >
                                Map
                              </a>
                            ) : null}
                            {canUpdate && canOpenMessageThreads ? (
                              <form action={openMobileAppointmentThreadAction}>
                                <input type="hidden" name="appointmentId" value={appointmentId} />
                                <input type="hidden" name="date" value={calendarDay} />
                                <input type="hidden" name="screen" value="myday" />
                                <button
                                  type="submit"
                                  className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-2 text-xs font-semibold text-slate-200"
                                >
                                  <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                                  Message
                                </button>
                              </form>
                            ) : null}
                            {eventAmountLabel ? <span className={`ml-auto py-2 text-xs font-semibold ${tone.amount}`}>{eventAmountLabel}</span> : null}
                          </div>
                          {canUpdate ? (
                            <div className="mt-3">
                              <MobileCompleteAppointmentForm
                                event={event}
                                appointmentId={appointmentId}
                                calendarDay={calendarDay}
                                screen="myday"
                                teamMembers={teamMembers}
                              />
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  ) : (
                    <div className="rounded-md border border-dashed border-white/15 bg-slate-900 p-4 text-sm leading-6 text-slate-300">
                      No appointments today.
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : activeScreen === "contacts" ? (
            <div className="space-y-4">
              {contactDetail ? (
                <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                  <Link href="/mobile?screen=contacts" className="text-sm font-semibold text-cyan-200">
                    Back to contacts
                  </Link>
                  <div className="mt-4 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Contact</p>
                      <h2 className="mt-1 truncate text-lg font-semibold">{contactDetail.name}</h2>
                      <p className="mt-1 text-sm text-slate-300">
                        {contactDetail.phoneE164 ?? contactDetail.phone ?? "No phone"}
                        {contactDetail.email ? ` • ${contactDetail.email}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      {canStartMessageThreads && (contactDetail.phoneE164 ?? contactDetail.phone) ? (
                        <form action={openMobileContactThreadAction}>
                          <input type="hidden" name="contactId" value={contactDetail.id} />
                          <input type="hidden" name="channel" value="sms" />
                          <input type="hidden" name="returnTo" value={`/mobile?screen=contacts&contactId=${encodeURIComponent(contactDetail.id)}`} />
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1.5 rounded-md border border-cyan-300/40 bg-cyan-300/10 px-3 py-2 text-sm font-semibold text-cyan-100"
                          >
                            <MessageSquare className="h-4 w-4" aria-hidden="true" />
                            Message
                          </button>
                        </form>
                      ) : null}
                      {(contactDetail.phoneE164 ?? contactDetail.phone) ? (
                        <form action={startMobileContactCallAction}>
                          <input type="hidden" name="contactId" value={contactDetail.id} />
                          <input type="hidden" name="returnTo" value={`/mobile?screen=contacts&contactId=${encodeURIComponent(contactDetail.id)}`} />
                          <button type="submit" className="rounded-md bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950">
                            Call
                          </button>
                        </form>
                      ) : null}
                      <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">
                        {formatStage(contactDetail.pipeline?.stage)}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                      <p className="text-xs text-slate-400">Appointments</p>
                      <p className="mt-1 text-xl font-semibold">{contactDetail.stats?.appointments ?? 0}</p>
                    </div>
                    <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                      <p className="text-xs text-slate-400">Quotes</p>
                      <p className="mt-1 text-xl font-semibold">{contactDetail.stats?.quotes ?? 0}</p>
                    </div>
                  </div>

                  <details className="mt-4 rounded-md border border-cyan-300/30 bg-cyan-300/10 p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-cyan-100">Book appointment</summary>
                    <form action={bookMobileAppointmentAction} className="mt-3 space-y-3">
                      <input type="hidden" name="contactId" value={contactDetail.id} />
                      <input type="hidden" name="returnTo" value={`/mobile?screen=contacts&contactId=${encodeURIComponent(contactDetail.id)}`} />
                      {contactDetail.properties?.length ? (
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-300">Property</span>
                          <select
                            name="propertyId"
                            defaultValue={contactDetail.properties[0]?.id ?? ""}
                            className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                          >
                            {contactDetail.properties.map((property) => (
                              <option key={property.id} value={property.id}>
                                {[property.addressLine1, property.city, property.state].filter(Boolean).join(", ")}
                              </option>
                            ))}
                            <option value="">Add a new address below</option>
                          </select>
                        </label>
                      ) : (
                        <input type="hidden" name="propertyId" value="" />
                      )}
                      <div className="rounded-md border border-white/10 bg-slate-950 p-3">
                        <p className="text-xs font-semibold text-slate-300">Add new address</p>
                        <div className="mt-2 space-y-2">
                          <label className="block">
                            <span className="text-xs font-semibold text-slate-400">Street</span>
                            <input
                              name="addressLine1"
                              className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                              placeholder="123 Main St"
                            />
                          </label>
                          <label className="block">
                            <span className="text-xs font-semibold text-slate-400">Unit / details</span>
                            <input
                              name="addressLine2"
                              className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                              placeholder="Apt, gate, building..."
                            />
                          </label>
                          <div className="grid grid-cols-[1fr_4rem_6rem] gap-2">
                            <label className="block">
                              <span className="text-xs font-semibold text-slate-400">City</span>
                              <input
                                name="city"
                                className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                              />
                            </label>
                            <label className="block">
                              <span className="text-xs font-semibold text-slate-400">State</span>
                              <input
                                name="state"
                                defaultValue="GA"
                                maxLength={2}
                                className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-2 py-2 text-base uppercase text-white outline-none focus:border-cyan-300"
                              />
                            </label>
                            <label className="block">
                              <span className="text-xs font-semibold text-slate-400">ZIP</span>
                              <input
                                name="postalCode"
                                inputMode="numeric"
                                className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-2 py-2 text-base text-white outline-none focus:border-cyan-300"
                              />
                            </label>
                          </div>
                        </div>
                      </div>
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-300">Start</span>
                        <input
                          name="startAt"
                          type="datetime-local"
                          required
                          className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-300">Minutes</span>
                        <input
                          name="durationMinutes"
                          type="number"
                          min="15"
                          step="15"
                          defaultValue="60"
                          className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                        />
                      </label>
                      <MobileAppointmentPricingFields sourceTeamMemberId={session.teamMember.id} />
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-300">Notes</span>
                        <textarea
                          name="notes"
                          rows={3}
                          className="mt-1 w-full resize-none rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                          placeholder="Gate code, job details, crew notes..."
                        />
                      </label>
                      <button type="submit" className="w-full rounded-md bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950">
                        Book appointment
                      </button>
                    </form>
                  </details>

                  {contactDetail.properties?.length ? (
                    <div className="mt-4 space-y-2">
                      <p className="text-xs font-semibold text-slate-300">Properties</p>
                      {contactDetail.properties.slice(0, 3).map((property) => (
                        <div key={property.id} className="rounded-md border border-white/10 bg-slate-900 p-3 text-sm text-slate-200">
                          <p>{property.addressLine1}</p>
                          <p className="mt-1 text-xs text-slate-400">
                            {[property.city, property.state, property.postalCode].filter(Boolean).join(", ")}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {contactDetail.notes?.length ? (
                    <div className="mt-4 space-y-2">
                      <p className="text-xs font-semibold text-slate-300">Recent Notes</p>
                      {contactDetail.notes.slice(0, 3).map((note) => (
                        <div key={note.id} className="rounded-md border border-white/10 bg-slate-900 p-3 text-sm leading-6 text-slate-200">
                          <p>{note.body}</p>
                          <p className="mt-1 text-xs text-slate-400">{formatRelativeTime(note.updatedAt)}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <details className="mt-4 rounded-md border border-white/10 bg-slate-900 p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-slate-100">Edit basic info</summary>
                    <form action={updateMobileContactAction} className="mt-3 space-y-3">
                      <input type="hidden" name="contactId" value={contactDetail.id} />
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-300">First</span>
                          <input
                            name="firstName"
                            required
                            defaultValue={contactDetail.firstName}
                            className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-300">Last</span>
                          <input
                            name="lastName"
                            required
                            defaultValue={contactDetail.lastName}
                            className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                          />
                        </label>
                      </div>
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-300">Phone</span>
                        <input
                          name="phone"
                          defaultValue={contactDetail.phoneE164 ?? contactDetail.phone ?? ""}
                          className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-300">Email</span>
                        <input
                          name="email"
                          type="email"
                          defaultValue={contactDetail.email ?? ""}
                          className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                        />
                      </label>
                      <button type="submit" className="w-full rounded-md border border-white/10 px-4 py-3 text-sm font-semibold text-white">
                        Save contact
                      </button>
                    </form>
                  </details>

                  <details className="mt-3 rounded-md border border-white/10 bg-slate-900 p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-slate-100">Add note</summary>
                    <form action={addMobileContactNoteAction} className="mt-3 space-y-3">
                      <input type="hidden" name="contactId" value={contactDetail.id} />
                      <textarea
                        name="body"
                        required
                        rows={3}
                        className="w-full resize-none rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                        placeholder="Add customer context..."
                      />
                      <button type="submit" className="w-full rounded-md border border-white/10 px-4 py-3 text-sm font-semibold text-white">
                        Save note
                      </button>
                    </form>
                  </details>
                </div>
              ) : (
                <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-base font-semibold">Contacts</h2>
                    <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">{contacts.length}</span>
                  </div>
                  <form action="/mobile" className="mt-4">
                    <input type="hidden" name="screen" value="contacts" />
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-300">Search</span>
                      <input
                        name="q"
                        defaultValue={inboxQuery}
                        className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                        placeholder="Name, phone, email, address..."
                      />
                    </label>
                    <button type="submit" className="mt-3 w-full rounded-md bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950">
                      Search contacts
                    </button>
                  </form>
                  <div className="mt-4 space-y-2">
                    {contacts.length > 0 ? (
                      contacts.map((contact) => (
                        <Link
                          key={contact.id}
                          href={`/mobile?screen=contacts&contactId=${encodeURIComponent(contact.id)}` as Route}
                          className="block rounded-md border border-white/10 bg-slate-900 p-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-white">{contact.name}</p>
                              <p className="mt-1 truncate text-sm text-slate-300">
                                {contact.phoneE164 ?? contact.phone ?? contact.email ?? "No contact info"}
                              </p>
                              {contact.properties?.[0]?.addressLine1 ? (
                                <p className="mt-1 truncate text-xs text-slate-400">{contact.properties[0].addressLine1}</p>
                              ) : null}
                            </div>
                            <span className="shrink-0 rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">
                              {formatStage(contact.pipeline?.stage)}
                            </span>
                          </div>
                        </Link>
                      ))
                    ) : (
                      <div className="rounded-md border border-dashed border-white/15 bg-slate-900 p-4 text-sm leading-6 text-slate-300">
                        No contacts found.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : activeScreen === "quotes" ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Quotes</p>
                    <h2 className="mt-1 text-lg font-semibold">Quote pipeline</h2>
                    <p className="mt-1 text-sm text-slate-300">
                      {quoteStatusCounts.pending + quoteStatusCounts.sent} open worth {formatUsdDollars(openQuoteValue)}
                    </p>
                  </div>
                  <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">{quotes.length}</span>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  {quoteStatusFilters.map((status) => (
                    <Link
                      key={status}
                      href={`/mobile?screen=quotes${status === "all" ? "" : `&quoteStatus=${status}`}` as Route}
                      className={`rounded-md border px-3 py-2 text-center text-xs font-semibold capitalize ${
                        quoteStatus === status
                          ? "border-cyan-300 bg-cyan-300 text-slate-950"
                          : "border-white/10 bg-slate-900 text-slate-200"
                      }`}
                    >
                      <span className="block capitalize">{status}</span>
                      <span className="mt-0.5 block text-[10px] opacity-75">{quoteStatusCounts[status]}</span>
                    </Link>
                  ))}
                </div>
              </div>

              <details className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <summary className="cursor-pointer list-none text-sm font-semibold text-cyan-100">
                  Create quote
                </summary>
                <form action={createMobileQuoteAction} className="mt-4 space-y-3">
                  <label className="block">
                    <span className="text-xs font-semibold text-slate-300">Contact / property</span>
                    <select
                      name="contactProperty"
                      required
                      className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                    >
                      <option value="">Choose contact</option>
                      {contacts.flatMap((contact) =>
                        (contact.properties ?? []).map((property) => (
                          <option key={`${contact.id}:${property.id}`} value={`${contact.id}:${property.id}`}>
                            {contact.name} - {property.addressLine1}, {property.city}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  <div className="space-y-2">
                    {mobileQuoteServices.map((service) => (
                      <div key={service.id} className="grid grid-cols-[1fr_7rem] gap-2 rounded-md border border-white/10 bg-slate-950 p-2">
                        <label className="flex items-center gap-2 text-sm text-slate-200">
                          <input name="services" type="checkbox" value={service.id} className="rounded border-slate-600 bg-slate-900" />
                          {service.label}
                        </label>
                        <input
                          name={`servicePrice:${service.id}`}
                          inputMode="decimal"
                          className="w-full rounded-md border border-white/10 bg-slate-900 px-2 py-1 text-sm text-white outline-none focus:border-cyan-300"
                          placeholder="$"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-300">Duration</span>
                      <select name="jobDurationMinutes" defaultValue="120" className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white">
                        <option value="60">1h</option>
                        <option value="120">2h</option>
                        <option value="180">3h</option>
                        <option value="240">Half day</option>
                        <option value="480">Full day</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-300">Deposit</span>
                      <select name="depositRate" defaultValue="0" className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white">
                        <option value="0">None</option>
                        <option value="0.1">10%</option>
                        <option value="0.25">25%</option>
                        <option value="0.5">50%</option>
                      </select>
                    </label>
                  </div>
                  <label className="block">
                    <span className="text-xs font-semibold text-slate-300">Client scope</span>
                    <textarea
                      name="clientScope"
                      rows={3}
                      className="mt-1 w-full resize-none rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                      placeholder="What the customer will see on the quote..."
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-slate-300">Internal notes</span>
                    <textarea
                      name="notes"
                      rows={2}
                      className="mt-1 w-full resize-none rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-200">
                    <input name="sendQuote" type="checkbox" className="rounded border-slate-600 bg-slate-900" />
                    Send SMS/email after creating
                  </label>
                  <button type="submit" className="w-full rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950">
                    Create quote
                  </button>
                </form>
              </details>

              <div className="space-y-3">
                {quotes.length > 0 ? (
                  quotes.map((quote) => {
                    const address = [quote.property.addressLine1, quote.property.city, quote.property.state, quote.property.postalCode]
                      .filter(Boolean)
                      .join(", ");
                    return (
                      <div key={quote.id} className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-cyan-200">{quote.contact.name}</p>
                            <h3 className="mt-1 text-xl font-semibold">{formatUsdDollars(quote.total)}</h3>
                            {address ? <p className="mt-1 text-sm leading-5 text-slate-300">{address}</p> : null}
                            {quote.contact.email ? <p className="mt-1 truncate text-xs text-slate-500">{quote.contact.email}</p> : null}
                          </div>
                          <span className="shrink-0 rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold capitalize text-slate-300">
                            {formatStage(quote.displayStatus ?? quote.status)}
                          </span>
                        </div>
                        <p className="mt-3 text-sm text-slate-300">{quote.services.map(formatStage).join(", ")}</p>
                        {quote.notes ? <p className="mt-2 text-sm leading-5 text-slate-400">{quote.notes}</p> : null}
                        {quote.clientScope ? <p className="mt-2 text-sm leading-5 text-slate-300">{quote.clientScope}</p> : null}
                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
                          <div className="rounded-md border border-white/10 bg-slate-900 px-3 py-2">
                            <p className="text-slate-500">Updated</p>
                            <p className="mt-0.5 font-semibold text-slate-200">{formatRelativeTime(quote.updatedAt) || "Unknown"}</p>
                          </div>
                          <div className="rounded-md border border-white/10 bg-slate-900 px-3 py-2">
                            <p className="text-slate-500">{quote.sentAt ? "Sent" : "Expires"}</p>
                            <p className="mt-0.5 font-semibold text-slate-200">
                              {quote.sentAt ? formatRelativeTime(quote.sentAt) : quote.expiresAt ? formatMobileDateTime(quote.expiresAt) : "Not sent"}
                            </p>
                          </div>
                          <div className="rounded-md border border-white/10 bg-slate-900 px-3 py-2">
                            <p className="text-slate-500">Viewed</p>
                            <p className="mt-0.5 font-semibold text-slate-200">
                              {quote.viewedAt ? `${quote.viewCount}x ${formatRelativeTime(quote.lastViewedAt)}` : "No"}
                            </p>
                          </div>
                          <div className="rounded-md border border-white/10 bg-slate-900 px-3 py-2">
                            <p className="text-slate-500">Booking</p>
                            <p className="mt-0.5 font-semibold text-slate-200">
                              {quote.acceptedAppointmentId ? "Booked" : quote.refreshRequestedAt ? "Refresh requested" : `${Math.round((quote.jobDurationMinutes ?? 120) / 60 * 10) / 10}h`}
                            </p>
                          </div>
                        </div>
                        {quote.status === "pending" || quote.status === "sent" ? (
                          <details className="mt-3 rounded-md border border-white/10 bg-slate-900 p-3">
                            <summary className="cursor-pointer list-none text-sm font-semibold text-cyan-100">
                              Edit quote
                            </summary>
                            <form action={updateMobileQuoteAction} className="mt-3 space-y-3">
                              <input type="hidden" name="quoteId" value={quote.id} />
                              <div className="grid grid-cols-2 gap-2">
                                <label className="block">
                                  <span className="text-xs font-semibold text-slate-300">Duration</span>
                                  <select name="jobDurationMinutes" defaultValue={String(quote.jobDurationMinutes ?? 120)} className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white">
                                    <option value="60">1h</option>
                                    <option value="120">2h</option>
                                    <option value="180">3h</option>
                                    <option value="240">Half day</option>
                                    <option value="480">Full day</option>
                                  </select>
                                </label>
                                <label className="block">
                                  <span className="text-xs font-semibold text-slate-300">Deposit</span>
                                  <select name="depositRate" defaultValue="0" className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white">
                                    <option value="0">None</option>
                                    <option value="0.1">10%</option>
                                    <option value="0.25">25%</option>
                                    <option value="0.5">50%</option>
                                  </select>
                                </label>
                              </div>
                              <div className="space-y-2">
                                {mobileQuoteServices.map((service) => {
                                  const checked = quote.services.includes(service.id);
                                  return (
                                    <div key={service.id} className="grid grid-cols-[1fr_7rem] gap-2 rounded-md border border-white/10 bg-slate-950 p-2">
                                      <label className="flex items-center gap-2 text-sm text-slate-200">
                                        <input
                                          name="services"
                                          type="checkbox"
                                          value={service.id}
                                          defaultChecked={checked}
                                          className="rounded border-slate-600 bg-slate-900"
                                        />
                                        {service.label}
                                      </label>
                                      <input
                                        name={`servicePrice:${service.id}`}
                                        inputMode="decimal"
                                        defaultValue={quoteServiceAmount(quote, service.id)}
                                        className="w-full rounded-md border border-white/10 bg-slate-900 px-2 py-1 text-sm text-white outline-none focus:border-cyan-300"
                                        placeholder="$"
                                      />
                                    </div>
                                  );
                                })}
                              </div>
                              <label className="block">
                                <span className="text-xs font-semibold text-slate-300">Client scope</span>
                                <textarea
                                  name="clientScope"
                                  rows={3}
                                  defaultValue={quote.clientScope ?? ""}
                                  className="mt-1 w-full resize-none rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                                />
                              </label>
                              <label className="block">
                                <span className="text-xs font-semibold text-slate-300">Notes</span>
                                <textarea
                                  name="notes"
                                  rows={3}
                                  defaultValue={quote.notes ?? ""}
                                  className="mt-1 w-full resize-none rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                                />
                              </label>
                              <button
                                type="submit"
                                className="w-full rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950"
                              >
                                Save quote
                              </button>
                            </form>
                          </details>
                        ) : null}
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          {quote.status === "pending" || quote.status === "sent" ? (
                            <form action={sendMobileQuoteAction}>
                              <input type="hidden" name="quoteId" value={quote.id} />
                              <button
                                type="submit"
                                className="w-full rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950"
                              >
                                Send
                              </button>
                            </form>
                          ) : null}
                          <form action={updateMobileQuoteDecisionAction}>
                            <input type="hidden" name="quoteId" value={quote.id} />
                            <button
                              type="submit"
                              name="decision"
                              value="accepted"
                              className="w-full rounded-md border border-emerald-300/30 bg-emerald-300/10 px-3 py-2 text-sm font-semibold text-emerald-100"
                            >
                              Accepted
                            </button>
                          </form>
                          <form action={updateMobileQuoteDecisionAction}>
                            <input type="hidden" name="quoteId" value={quote.id} />
                            <button
                              type="submit"
                              name="decision"
                              value="declined"
                              className="w-full rounded-md border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-sm font-semibold text-rose-100"
                            >
                              Declined
                            </button>
                          </form>
                          {quote.shareToken ? (
                            <a
                              href={`/quote/${quote.shareToken}?preview=1`}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-center text-sm font-semibold text-slate-200"
                            >
                              Open link
                            </a>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="rounded-lg border border-dashed border-white/15 bg-slate-900 p-4 text-sm leading-6 text-slate-300">
                    No quotes found.
                  </div>
                )}
              </div>
            </div>
          ) : activeScreen === "calendar" ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Calendar</p>
                    <h2 className="mt-1 text-lg font-semibold">
                      {formatDateLabel(calendarWeekDays[0] ?? calendarDay)} - {formatDateLabel(calendarWeekDays[6] ?? calendarDay)}
                    </h2>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-400">Week projected</p>
                    <p className="text-xl font-semibold text-cyan-200">{calendarWeekProjectedLabel}</p>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <Link
                    href={`/mobile?screen=calendar&date=${encodeURIComponent(addDaysToKey(calendarDay, -7))}` as Route}
                    className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-center text-sm font-semibold text-slate-200"
                  >
                    Prev wk
                  </Link>
                  <Link
                    href="/mobile?screen=calendar"
                    className="rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-center text-sm font-semibold text-slate-950"
                  >
                    Today
                  </Link>
                  <Link
                    href={`/mobile?screen=calendar&date=${encodeURIComponent(addDaysToKey(calendarDay, 7))}` as Route}
                    className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-center text-sm font-semibold text-slate-200"
                  >
                    Next wk
                  </Link>
                </div>
                <form action="/mobile" className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                  <input type="hidden" name="screen" value="calendar" />
                  <input
                    type="date"
                    name="date"
                    defaultValue={calendarDay}
                    className="min-w-0 rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm font-semibold text-white outline-none focus:border-cyan-300"
                  />
                  <button type="submit" className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200">
                    Go
                  </button>
                </form>
              </div>

              <MobileWeekStrip
                activeDay={calendarDay}
                days={calendarWeekDays}
                events={calendarWeekEvents}
                screen="calendar"
              />

              <MobileWeekAgenda
                days={calendarWeekDays}
                events={calendarWeekEvents}
                canOpenMessageThreads={canOpenMessageThreads}
              />
            </div>
          ) : activeScreen === "owner" && ownerSummary ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Owner Snapshot</p>
                <h2 className="mt-1 text-lg font-semibold">{formatDateLabel(ownerSummary.todayKey)}</h2>
                <p className="mt-1 text-sm text-slate-300">Collected cash, projected work, payouts, leads, and provider health.</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-200">Today Collected</p>
                  <p className="mt-2 text-2xl font-semibold">{formatUsdCents(ownerSummary.collectedTodayCents)}</p>
                  <p className="mt-1 text-xs text-emerald-100">{ownerSummary.collectedTodayCount} completed jobs</p>
                </div>
                <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-200">Projected</p>
                  <p className="mt-2 text-2xl font-semibold">{formatUsdCents(ownerSummary.projectedTodayCents)}</p>
                  <p className="mt-1 text-xs text-cyan-100">{ownerSummary.bookedJobsToday} booked jobs today</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">Week Collected</p>
                  <p className="mt-2 text-2xl font-semibold">{formatUsdCents(ownerSummary.collectedWeekCents)}</p>
                  <p className="mt-1 text-xs text-slate-400">{ownerSummary.collectedWeekCount} completed jobs</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">Month Collected</p>
                  <p className="mt-2 text-2xl font-semibold">{formatUsdCents(ownerSummary.collectedMonthCents)}</p>
                  <p className="mt-1 text-xs text-slate-400">{ownerSummary.collectedMonthCount} completed jobs</p>
                </div>
                <Link href="/mobile" className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">Open Leads</p>
                  <p className="mt-2 text-2xl font-semibold">{ownerSummary.openInboxLeads}</p>
                  <p className="mt-1 text-xs text-slate-400">Inbox threads</p>
                </Link>
                <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">30 Days</p>
                  <p className="mt-2 text-2xl font-semibold">{formatUsdCents(ownerSummary.collectedLast30DaysCents)}</p>
                  <p className="mt-1 text-xs text-slate-400">{ownerSummary.collectedLast30DaysCount} completed jobs</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">Year Collected</p>
                  <p className="mt-2 text-2xl font-semibold">{formatUsdCents(ownerSummary.collectedYearCents)}</p>
                  <p className="mt-1 text-xs text-slate-400">{ownerSummary.collectedYearCount} completed jobs</p>
                </div>
                <div className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-200">Lifetime</p>
                  <p className="mt-2 text-2xl font-semibold">{formatUsdCents(ownerSummary.collectedLifetimeCents)}</p>
                  <p className="mt-1 text-xs text-emerald-100">{ownerSummary.collectedLifetimeCount} completed jobs</p>
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold">Payout Runs</h2>
                    <p className="mt-1 text-sm text-slate-300">
                      Current payout due {ownerSummary.currentPayout ? formatUsdCents(ownerSummary.currentPayout.totalsCents.total) : "$0"} before card tips.
                    </p>
                  </div>
                  <form action={runMobilePayoutAction}>
                    <input type="hidden" name="action" value="create" />
                    <button type="submit" className="rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-950">
                      Create
                    </button>
                  </form>
                </div>
                {ownerSummary.currentPayout ? (
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                      <p className="text-slate-500">Sales</p>
                      <p className="mt-1 font-semibold text-slate-100">{formatUsdCents(ownerSummary.currentPayout.totalsCents.sales)}</p>
                    </div>
                    <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                      <p className="text-slate-500">Crew</p>
                      <p className="mt-1 font-semibold text-slate-100">{formatUsdCents(ownerSummary.currentPayout.totalsCents.crew)}</p>
                    </div>
                    <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                      <p className="text-slate-500">Management</p>
                      <p className="mt-1 font-semibold text-slate-100">{formatUsdCents(ownerSummary.currentPayout.totalsCents.marketing)}</p>
                    </div>
                    <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                      <p className="text-slate-500">Card tips</p>
                      <p className="mt-1 font-semibold text-slate-100">{formatUsdCents(ownerSummary.currentPayout.cardTipsCents)}</p>
                    </div>
                  </div>
                ) : null}
                <div className="mt-4 space-y-3">
                  {ownerSummary.payoutRuns.length > 0 ? (
                    ownerSummary.payoutRuns.map((run) => (
                      <div key={run.id} className="rounded-md border border-white/10 bg-slate-900 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-semibold">
                              {run.status.toUpperCase()} - {formatUsdCents(run.totalCents)}
                            </p>
                            <p className="mt-1 text-xs text-slate-400">
                              {formatMobileDateTime(run.periodStart, run.timezone)} to {formatMobileDateTime(run.periodEnd, run.timezone)}
                            </p>
                          </div>
                          <span className="shrink-0 rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold capitalize text-slate-300">
                            {run.status}
                          </span>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                          <span className="rounded-md border border-white/10 px-2 py-1 text-slate-300">
                            Reimbursements {formatUsdCents(run.reimbursementTotalCents)}
                          </span>
                          <span className="rounded-md border border-white/10 px-2 py-1 text-slate-300">
                            Adjustments {formatUsdCents(run.otherAdjustmentsTotalCents)}
                          </span>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <a
                            href={`/api/team/commissions/payout-runs/${run.id}/report`}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-center text-sm font-semibold text-slate-200"
                          >
                            Report
                          </a>
                          {run.status !== "draft" ? (
                            <a
                              href={`/api/team/commissions/payout-runs/${run.id}/export`}
                              className="rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-center text-sm font-semibold text-slate-200"
                            >
                              CSV
                            </a>
                          ) : null}
                          {run.status === "draft" ? (
                            <form action={runMobilePayoutAction}>
                              <input type="hidden" name="action" value="lock" />
                              <input type="hidden" name="payoutRunId" value={run.id} />
                              <button type="submit" className="w-full rounded-md border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-sm font-semibold text-amber-100">
                                Lock
                              </button>
                            </form>
                          ) : null}
                          {run.status === "locked" ? (
                            <form action={runMobilePayoutAction}>
                              <input type="hidden" name="action" value="paid" />
                              <input type="hidden" name="payoutRunId" value={run.id} />
                              <button type="submit" className="w-full rounded-md border border-emerald-300 bg-emerald-300 px-3 py-2 text-sm font-semibold text-slate-950">
                                Mark Paid
                              </button>
                            </form>
                          ) : null}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="rounded-md border border-dashed border-white/15 bg-slate-900 p-3 text-sm text-slate-300">
                      No payout runs yet.
                    </p>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-semibold">Provider Health</h2>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                      ownerSummary.health.blockers > 0
                        ? "bg-rose-300/15 text-rose-100"
                        : ownerSummary.health.warnings > 0
                          ? "bg-amber-300/15 text-amber-100"
                          : "bg-emerald-300/15 text-emerald-100"
                    }`}
                  >
                    {ownerSummary.health.blockers > 0
                      ? `${ownerSummary.health.blockers} blockers`
                      : ownerSummary.health.warnings > 0
                        ? `${ownerSummary.health.warnings} warnings`
                        : "Healthy"}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {ownerSummary.health.providers.length > 0 ? (
                    ownerSummary.health.providers.map((provider) => (
                      <div key={provider.provider} className={`rounded-md border px-3 py-2 text-xs font-semibold ${ownerHealthClass(provider.status)}`}>
                        <p>{formatProviderLabel(provider.provider)}</p>
                        <p className="mt-1 capitalize opacity-80">{provider.status}</p>
                      </div>
                    ))
                  ) : (
                    <p className="col-span-2 text-sm text-slate-300">Provider health is unavailable.</p>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-semibold">Today&apos;s Work</h2>
                  <Link href="/mobile?screen=calendar" className="text-sm font-semibold text-cyan-200">
                    Calendar
                  </Link>
                </div>
                <div className="mt-3 space-y-2">
                  {ownerSummary.nextAppointments.length > 0 ? (
                    ownerSummary.nextAppointments.map((appointment) => {
                      const mapsHref = buildMapsDirectionsHref(appointment.address);
                      return (
                        <div key={appointment.id} className="rounded-md border border-white/10 bg-slate-900 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold">{appointment.contactName ?? appointment.title}</p>
                              <p className="mt-1 text-xs text-slate-400">{appointment.time}</p>
                              {mapsHref && appointment.address ? (
                                <a
                                  href={mapsHref}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 block text-xs font-semibold leading-5 text-cyan-100 underline-offset-4 hover:underline"
                                >
                                  {appointment.address}
                                </a>
                              ) : null}
                            </div>
                            <span className="shrink-0 text-sm font-semibold text-cyan-100">{formatUsdCents(appointment.projectedCents)}</span>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <p className="rounded-md border border-dashed border-white/15 bg-slate-900 p-3 text-sm text-slate-300">
                      No booked work today.
                    </p>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-semibold">Open Leads</h2>
                  <Link href="/mobile" className="text-sm font-semibold text-cyan-200">
                    Inbox
                  </Link>
                </div>
                <div className="mt-3 space-y-2">
                  {ownerSummary.inboxLeads.length > 0 ? (
                    ownerSummary.inboxLeads.map((lead) => (
                      <Link key={lead.id} href={`/mobile?threadId=${encodeURIComponent(lead.id)}` as Route} className="block rounded-md border border-white/10 bg-slate-900 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="truncate text-sm font-semibold">{lead.contactName}</p>
                          <span className="text-xs text-slate-500">{formatRelativeTime(lead.lastMessageAt)}</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">{lead.preview}</p>
                      </Link>
                    ))
                  ) : (
                    <p className="rounded-md border border-dashed border-white/15 bg-slate-900 p-3 text-sm text-slate-300">
                      No open inbox leads.
                    </p>
                  )}
                </div>
              </div>

            </div>
          ) : activeScreen === "access" && accessData ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Launch Accounts</p>
                <h2 className="mt-1 text-lg font-semibold">Owner-only access setup</h2>
                <p className="mt-1 text-sm leading-6 text-slate-300">
                  Confirm Jeffrey and Austin are owners, Devon is sales, and each person has an active account.
                </p>
              </div>

              <div className="space-y-3">
                {launchAccounts.map((entry) => {
                  const member = entry.member;
                  const roleOk = member?.role?.slug === entry.expectedRole;
                  const ready = Boolean(member?.active && roleOk && member.email && member.passwordSet);
                  return (
                    <div key={entry.name} className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h2 className="text-base font-semibold">{entry.name}</h2>
                          <p className="mt-1 text-sm text-slate-300">
                            Expected role: <span className="font-semibold capitalize text-slate-100">{entry.expectedRole}</span>
                          </p>
                        </div>
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                            ready
                              ? "bg-emerald-300/15 text-emerald-100"
                              : member
                                ? "bg-amber-300/15 text-amber-100"
                                : "bg-rose-300/15 text-rose-100"
                          }`}
                        >
                          {ready ? "Ready" : member ? "Needs review" : "Missing"}
                        </span>
                      </div>

                      {member ? (
                        <form action={updateMobileTeamMemberAction} className="mt-4 space-y-3">
                          <input type="hidden" name="memberId" value={member.id} />
                          <label className="block">
                            <span className="text-xs font-semibold text-slate-300">Name</span>
                            <input
                              name="name"
                              defaultValue={member.name}
                              required
                              className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"
                            />
                          </label>
                          <label className="block">
                            <span className="text-xs font-semibold text-slate-300">Email</span>
                            <input
                              name="email"
                              type="email"
                              defaultValue={member.email ?? ""}
                              required
                              className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"
                            />
                          </label>
                          <label className="block">
                            <span className="text-xs font-semibold text-slate-300">Phone for SMS login links</span>
                            <input
                              name="phone"
                              defaultValue={member.phone ?? ""}
                              placeholder="6785551234"
                              className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"
                            />
                          </label>
                          <label className="block">
                            <span className="text-xs font-semibold text-slate-300">Role</span>
                            <select
                              name="roleId"
                              defaultValue={member.role?.id ?? entry.role?.id ?? ""}
                              required
                              className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"
                            >
                              <option value="">Choose role</option>
                              {accessData.roles.map((role) => (
                                <option key={role.id} value={role.id}>
                                  {role.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="rounded-md border border-white/10 bg-slate-900 px-3 py-2">
                              <p className="text-slate-400">Active</p>
                              <p className="mt-1 font-semibold">{member.active ? "Yes" : "No"}</p>
                            </div>
                            <div className="rounded-md border border-white/10 bg-slate-900 px-3 py-2">
                              <p className="text-slate-400">Password</p>
                              <p className="mt-1 font-semibold">{member.passwordSet ? "Set" : "Not set"}</p>
                            </div>
                          </div>
                          <label className="flex items-center gap-2 text-sm text-slate-200">
                            <input type="checkbox" name="active" defaultChecked={member.active} className="h-4 w-4 rounded border-white/20 bg-slate-950" />
                            Active
                          </label>
                          <button
                            type="submit"
                            className="w-full rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950"
                          >
                            Save account
                          </button>
                        </form>
                      ) : (
                        <form action={createMobileTeamMemberAction} className="mt-4 space-y-3">
                          <input type="hidden" name="name" value={entry.name} />
                          <input type="hidden" name="roleId" value={entry.role?.id ?? ""} />
                          <label className="block">
                            <span className="text-xs font-semibold text-slate-300">{entry.name} email</span>
                            <input
                              name="email"
                              type="email"
                              required
                              placeholder={`${entry.name.toLowerCase()}@stonegatejunkremoval.com`}
                              className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"
                            />
                          </label>
                          <button
                            type="submit"
                            disabled={!entry.role}
                            className="w-full rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Create {entry.name}
                          </button>
                          {!entry.role ? <p className="text-xs text-rose-100">Required role is missing.</p> : null}
                        </form>
                      )}

                      {member?.email || member?.phone ? (
                        <form action={sendMobileTeamInviteAction} className="mt-3">
                          <input type="hidden" name="identifier" value={member.email ?? member.phone ?? ""} />
                          <button
                            type="submit"
                            className="w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm font-semibold text-cyan-100"
                          >
                            Send mobile login link
                          </button>
                        </form>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <h2 className="text-base font-semibold">All Team Accounts</h2>
                <div className="mt-3 space-y-2">
                  {accessData.members.map((member) => (
                    <div key={member.id} className="rounded-md border border-white/10 bg-slate-900 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{member.name}</p>
                          <p className="mt-1 truncate text-xs text-slate-400">{member.email ?? member.phone ?? "No login contact"}</p>
                        </div>
                        <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.08] px-2 py-1 text-xs font-semibold capitalize text-slate-200">
                          {member.role?.slug ?? "none"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : activeScreen === "expenses" ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Spend</p>
                <h2 className="mt-1 text-lg font-semibold">Add expense</h2>
                <p className="mt-1 text-sm text-slate-300">Enter the amount, choose the type, and save it before the day moves on.</p>
              </div>

              {expenseSaved ? (
                <div className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm font-semibold text-emerald-100">
                  Expense saved.
                </div>
              ) : null}

              <form action={createMobileExpenseAction} className="space-y-3 rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <label className="block">
                  <span className="text-xs font-semibold text-slate-300">Amount</span>
                  <input
                    name="amount"
                    inputMode="decimal"
                    placeholder="0.00"
                    required
                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-4 py-4 text-2xl font-semibold text-white outline-none focus:border-cyan-300"
                  />
                </label>

                <label className="block">
                  <span className="text-xs font-semibold text-slate-300">Category</span>
                  <select
                    name="category"
                    defaultValue=""
                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                    required
                  >
                    <option value="">Pick one</option>
                    <option value="Dump">Dump</option>
                    <option value="Gas">Gas</option>
                    <option value="Food">Food</option>
                    <option value="Equipment">Equipment</option>
                    <option value="Vehicle">Vehicle</option>
                    <option value="Insurance">Insurance</option>
                    <option value="Software">Software</option>
                  </select>
                </label>

                <button
                  type="submit"
                  disabled={!canWriteExpenses}
                  className="w-full rounded-md border border-cyan-300 bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Save expense
                </button>
                {!canWriteExpenses ? <p className="text-xs text-rose-100">Your account can view expenses but cannot add them.</p> : null}
              </form>

              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-semibold">Recent expenses</h2>
                  <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">{expenses.length}</span>
                </div>
                <div className="mt-3 space-y-2">
                  {expenses.length > 0 ? (
                    expenses.map((expense) => (
                      <div key={expense.id} className="rounded-md border border-white/10 bg-slate-900 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-white">{formatUsdCents(expense.amountCents)}</p>
                            <p className="mt-1 truncate text-xs text-slate-400">
                              {formatMobileDateTime(expense.paidAt)}
                              {expense.category ? ` - ${expense.category}` : ""}
                            </p>
                            {expense.vendor || expense.memo ? (
                              <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-300">
                                {[expense.vendor, expense.memo].filter(Boolean).join(" - ")}
                              </p>
                            ) : null}
                          </div>
                          {expense.receipt ? (
                            <a
                              href={`/api/mobile/expenses/${encodeURIComponent(expense.id)}/receipt`}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 rounded-md border border-white/10 px-2 py-1 text-xs font-semibold text-cyan-100"
                            >
                              Receipt
                            </a>
                          ) : null}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="rounded-md border border-dashed border-white/15 bg-slate-900 p-3 text-sm text-slate-300">
                      No expenses logged yet.
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : activeScreen === "settings" ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Account</p>
                <h2 className="mt-1 text-lg font-semibold">{session.teamMember.name}</h2>
                <div className="mt-4 space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-slate-900 px-3 py-2">
                    <span className="text-slate-400">Role</span>
                    <span className="font-semibold">{labelForRole(session.teamMember.roleSlug)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-slate-900 px-3 py-2">
                    <span className="text-slate-400">Email</span>
                    <span className="truncate font-semibold">{session.teamMember.email ?? "Not set"}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-slate-900 px-3 py-2">
                    <span className="text-slate-400">Password</span>
                    <span className="font-semibold">{session.teamMember.passwordSet ? "Set" : "Not set"}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-slate-900 px-3 py-2">
                    <span className="text-slate-400">Session</span>
                    <span className="font-semibold">30 days</span>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <h2 className="text-base font-semibold">Access</h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  {session.allowedScreens.map((screen) => (
                    <span key={screen} className="rounded-full border border-white/10 bg-slate-900 px-3 py-1 text-xs font-semibold capitalize text-slate-200">
                      {screen}
                    </span>
                  ))}
                </div>
              </div>

              {!session.teamMember.passwordSet ? (
                <div className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-4">
                  <h2 className="text-base font-semibold text-amber-100">Set password</h2>
                  <p className="mt-1 text-sm leading-6 text-amber-100">Minimum 10 characters.</p>
                  <form action="/mobile/password" method="post" className="mt-3 space-y-3">
                    <input type="hidden" name="next" value="/mobile?screen=settings" />
                    <input
                      name="password"
                      type="password"
                      minLength={10}
                      required
                      className="w-full rounded-md border border-amber-300/20 bg-slate-950 px-3 py-2 text-sm text-white"
                      placeholder="New password"
                    />
                    <input
                      name="confirmPassword"
                      type="password"
                      minLength={10}
                      required
                      className="w-full rounded-md border border-amber-300/20 bg-slate-950 px-3 py-2 text-sm text-white"
                      placeholder="Confirm password"
                    />
                    <button type="submit" className="w-full rounded-md bg-amber-200 px-3 py-2 text-sm font-semibold text-slate-950">
                      Save password
                    </button>
                  </form>
                </div>
              ) : null}

              <form action={mobileLogoutAction} className="rounded-lg border border-rose-300/30 bg-rose-300/10 p-4">
                <button type="submit" className="w-full rounded-md border border-rose-300/30 bg-rose-300/10 px-4 py-3 text-sm font-semibold text-rose-100">
                  Log out
                </button>
              </form>
            </div>
          ) : (
            <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{activeLabel}</h2>
                <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">Planned</span>
              </div>
              <div className="mt-4 rounded-md border border-dashed border-white/15 bg-slate-900 p-4 text-sm leading-6 text-slate-300">
                This mobile screen is planned for a later milestone. Inbox is the first connected workflow.
              </div>
            </div>
          )}

          <div className="rounded-lg border border-white/10 bg-slate-900 p-4">
            <h2 className="text-base font-semibold">Allowed mobile screens</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {session.allowedScreens.map((screen) => (
                <span key={screen} className="rounded-full border border-white/10 bg-white/[0.08] px-3 py-1 text-xs font-semibold capitalize text-slate-200">
                  {screen}
                </span>
              ))}
            </div>
          </div>
        </section>

        <nav className="sticky bottom-0 border-t border-white/10 bg-slate-950/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur">
          <div className="grid grid-flow-col auto-cols-[minmax(3.75rem,1fr)] gap-1 overflow-x-auto">
            {visibleNav.map((item) => {
              const Icon = item.icon;
              const active = item.id === activeScreen;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={`flex min-h-14 flex-col items-center justify-center rounded-md px-1 text-[10px] font-semibold leading-none ${
                    active ? "bg-cyan-300 text-slate-950" : "text-slate-300"
                  }`}
                >
                  <Icon className="mb-1 h-5 w-5" aria-hidden="true" />
                  <span className="max-w-full truncate whitespace-nowrap">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </main>
  );
}

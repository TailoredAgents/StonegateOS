import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { Inbox, CalendarDays, ContactRound, FileText, Home, Settings, ShieldCheck, UserCog } from "lucide-react";
import { resolveMobileSessionFromCookies } from "./lib/session";
import { callAdminApi } from "../team/lib/api";
import {
  addMobileContactNoteAction,
  addMobileAppointmentAttachmentAction,
  addMobileAppointmentNoteAction,
  bookMobileAppointmentAction,
  createMobileTeamMemberAction,
  createMobileQuoteAction,
  mobileLogoutAction,
  rescheduleMobileAppointmentAction,
  sendMobileTeamInviteAction,
  sendMobileThreadMessageAction,
  sendMobileQuoteAction,
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
import { loadMobileOwnerSummary, type MobileOwnerSummary } from "./lib/owner-summary";

const navItems: Array<{ id: string; label: string; href: Route; icon: typeof Inbox }> = [
  { id: "inbox", label: "Inbox", href: "/mobile", icon: Inbox },
  { id: "myday", label: "Today", href: "/mobile?screen=myday", icon: Home },
  { id: "contacts", label: "People", href: "/mobile?screen=contacts", icon: ContactRound },
  { id: "calendar", label: "Cal", href: "/mobile?screen=calendar", icon: CalendarDays },
  { id: "quotes", label: "Quotes", href: "/mobile?screen=quotes", icon: FileText },
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
  channel: string;
  subject: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
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
  channel: string;
  subject: string | null;
  lastMessageAt: string | null;
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
  notes?: Array<{ id: string; body: string; createdAt: string }>;
};

type CalendarFeedResponse = {
  ok?: boolean;
  appointments?: CalendarEvent[];
  externalEvents?: CalendarEvent[];
};

type QuoteSummary = {
  id: string;
  status: string;
  services: string[];
  addOns: string[] | null;
  total: number;
  lineItems?: Array<{ id?: string; label?: string; amount?: number; category?: string }> | null;
  notes?: string | null;
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

function getProjectedEventCents(event: CalendarEvent): number {
  if (event.source !== "db") return 0;
  const status = (event.status ?? "").trim().toLowerCase();
  if (status === "canceled" || status === "cancelled") return 0;
  const type = (event.appointmentType ?? "").trim().toLowerCase();
  if (type === "in_person_quote" || type === "in_person_estimate") return 0;
  return normalizeCents(event.finalTotalCents) ?? normalizeCents(event.quotedTotalCents) ?? 0;
}

function normalizeCents(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
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

function formatProviderLabel(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isMediaPlaceholderBody(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "" || normalized === "media message" || normalized === "message received";
}

function ownerHealthClass(status: OwnerHealthStatus): string {
  if (status === "healthy") return "border-emerald-300/30 bg-emerald-300/10 text-emerald-100";
  if (status === "degraded") return "border-rose-300/30 bg-rose-300/10 text-rose-100";
  return "border-amber-300/30 bg-amber-300/10 text-amber-100";
}

function phoneHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const normalized = phone.replace(/[^\d+]/g, "");
  return normalized ? `tel:${normalized}` : null;
}

function isQuoteOnlyAppointmentType(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "in_person_quote" || normalized === "in_person_estimate";
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

async function loadMobileThreads(input: { status: string; q: string }): Promise<ThreadSummary[]> {
  const params = new URLSearchParams();
  params.set("limit", "25");
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

async function loadMobileCalendar(dayKey: string): Promise<CalendarEvent[]> {
  const start = parseDayKey(dayKey);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 2);

  const response = await callAdminApi(
    `/api/admin/calendar/feed?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`,
    { method: "GET" }
  );
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => null)) as CalendarFeedResponse | null;
  const events = [...(payload?.appointments ?? []), ...(payload?.externalEvents ?? [])];
  return events
    .filter((event) => formatDayKey(new Date(event.start)) === dayKey)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
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
    q?: string;
    date?: string;
    appointment?: string;
    booked?: string;
    upload?: string;
    quote?: string;
    quoteStatus?: string;
    account?: string;
    invite?: string;
    password?: string;
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
  const inboxStatus = typeof params.status === "string" && params.status.trim() ? params.status.trim() : "open";
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
  const accountCreated = params.account === "created";
  const accountUpdated = params.account === "updated";
  const inviteSent = params.invite === "sent";
  const passwordSaved = params.password === "saved";
  const error = typeof params.error === "string" && params.error.trim().length ? params.error.trim() : null;
  const threads = activeScreen === "inbox" ? await loadMobileThreads({ status: inboxStatus, q: inboxQuery }) : [];
  const contacts = activeScreen === "contacts" ? await loadMobileContacts({ q: inboxQuery }) : [];
  const contactDetail = activeScreen === "contacts" && contactId ? await loadMobileContact(contactId) : null;
  const calendarEvents = activeScreen === "calendar" || activeScreen === "myday" ? await loadMobileCalendar(calendarDay) : [];
  const teamMembers = activeScreen === "calendar" || activeScreen === "myday" ? await loadMobileTeamMembers() : [];
  const quotes = activeScreen === "quotes" ? await loadMobileQuotes(quoteStatus) : [];
  const ownerSummary = activeScreen === "owner" && session.isOwner ? await loadMobileOwnerSummary() : null;
  const accessData = activeScreen === "access" && session.isOwner ? await loadMobileAccess() : null;
  const projectedCents = calendarEvents.reduce((sum, event) => sum + getProjectedEventCents(event), 0);
  const selectedThread = activeScreen === "inbox" && threadId ? await loadMobileThread(threadId) : null;
  const selectedContact = selectedThread?.thread?.contact?.id
    ? await loadMobileContact(selectedThread.thread.contact.id)
    : null;
  const detectedThreadAddress = selectedThread ? detectAddressFromMessages(selectedThread.messages) : null;
  const selectedThreadMediaMessages =
    selectedThread?.messages?.filter((message) => Array.isArray(message.mediaUrls) && message.mediaUrls.length > 0) ?? [];
  const selectedPhone = phoneHref(selectedThread?.thread?.contact?.phone);
  const ownerRole = accessData?.roles.find((role) => role.slug === "owner") ?? null;
  const salesRole = accessData?.roles.find((role) => role.slug === "sales") ?? null;
  const launchAccounts = accessData
    ? [
        { name: "Jeffrey", expectedRole: "owner", role: ownerRole, member: findLaunchMember(accessData.members, "Jeffrey") },
        { name: "Austin", expectedRole: "owner", role: ownerRole, member: findLaunchMember(accessData.members, "Austin") },
        { name: "Devon", expectedRole: "sales", role: salesRole, member: findLaunchMember(accessData.members, "Devon") }
      ]
    : [];
  const mobileJobEvents = calendarEvents.filter((event) => event.source === "db" && !isQuoteOnlyAppointmentType(event.appointmentType));

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
          {error ? (
            <div className="rounded-lg border border-rose-300/30 bg-rose-300/10 p-4 text-sm text-rose-100">
              {error}
            </div>
          ) : null}

          <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-4">
            <p className="text-sm font-semibold text-cyan-100">Mobile shell is active</p>
            <p className="mt-1 text-sm leading-6 text-slate-300">
              Inbox, contact detail, and calendar appointment controls are now connected to live CRM data.
            </p>
          </div>

          {activeScreen === "inbox" ? (
            <div className="space-y-4">
              {selectedThread?.thread ? (
                <div className="rounded-lg border border-white/10 bg-white/[0.08]">
                  <div className="border-b border-white/10 p-4">
                    <Link href="/mobile" className="text-sm font-semibold text-cyan-200">
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
                      {selectedPhone ? (
                        <a href={selectedPhone} className="rounded-md bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950">
                          Call
                        </a>
                      ) : null}
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

                  <div className="space-y-3 p-4">
                    {(selectedThread.messages ?? []).length > 0 ? (
                      selectedThread.messages?.map((message) => {
                        const outbound = message.direction === "outbound";
                        const mediaCount = message.mediaUrls?.length ?? 0;
                        const hasMedia = mediaCount > 0;
                        const showBody = !isMediaPlaceholderBody(message.body) || !hasMedia;
                        return (
                          <div key={message.id} className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
                            <div
                              className={`max-w-[82%] rounded-lg px-3 py-2 text-sm leading-6 ${
                                outbound ? "bg-cyan-300 text-slate-950" : "bg-slate-800 text-slate-100"
                              }`}
                            >
                              {showBody ? <p className="whitespace-pre-wrap break-words">{message.body || "Message received"}</p> : null}
                              {hasMedia ? <MobileInboxMediaGallery messageId={message.id} count={mediaCount} /> : null}
                              <p className={`mt-1 text-[11px] ${outbound ? "text-slate-700" : "text-slate-400"}`}>
                                {formatRelativeTime(message.createdAt)} • {message.deliveryStatus}
                              </p>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="rounded-md border border-dashed border-white/15 bg-slate-900 p-4 text-sm text-slate-300">
                        No messages yet.
                      </div>
                    )}
                  </div>

                  <form action={sendMobileThreadMessageAction} className="border-t border-white/10 p-4">
                    <input type="hidden" name="threadId" value={selectedThread.thread.id} />
                    <input type="hidden" name="channel" value={selectedThread.thread.channel} />
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-300">Reply</span>
                      <textarea
                        name="body"
                        required
                        rows={3}
                        className="mt-1 w-full resize-none rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                        placeholder="Type a reply..."
                      />
                    </label>
                    <button type="submit" className="mt-3 w-full rounded-md bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950">
                      Send reply
                    </button>
                  </form>
                </div>
              ) : (
                <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-base font-semibold">Open threads</h2>
                    <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">{threads.length}</span>
                  </div>

                  <form action="/mobile" className="mt-4 space-y-3">
                    <input type="hidden" name="screen" value="inbox" />
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-300">Search</span>
                      <input
                        name="q"
                        defaultValue={inboxQuery}
                        className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                        placeholder="Name, phone, message..."
                      />
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {["open", "pending", "closed"].map((status) => (
                        <button
                          key={status}
                          type="submit"
                          name="status"
                          value={status}
                          className={`rounded-md border px-3 py-2 text-xs font-semibold capitalize ${
                            inboxStatus === status
                              ? "border-cyan-300 bg-cyan-300 text-slate-950"
                              : "border-white/10 bg-slate-900 text-slate-200"
                          }`}
                        >
                          {status}
                        </button>
                      ))}
                    </div>
                  </form>

                  <div className="mt-4 space-y-2">
                    {threads.length > 0 ? (
                      threads.map((thread) => (
                        <Link
                          key={thread.id}
                          href={`/mobile?threadId=${encodeURIComponent(thread.id)}` as Route}
                          className="block rounded-md border border-white/10 bg-slate-900 p-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-white">{thread.contact?.name ?? thread.subject ?? "Thread"}</p>
                              <p className="mt-1 line-clamp-2 text-sm leading-5 text-slate-300">
                                {thread.lastMessagePreview ?? "No preview"}
                              </p>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="text-xs font-semibold text-cyan-200">{formatChannel(thread.channel)}</p>
                              <p className="mt-1 text-xs text-slate-400">{formatRelativeTime(thread.lastMessageAt)}</p>
                            </div>
                          </div>
                          {thread.property?.addressLine1 ? (
                            <p className="mt-2 truncate text-xs text-slate-400">{thread.property.addressLine1}</p>
                          ) : null}
                        </Link>
                      ))
                    ) : (
                      <div className="rounded-md border border-dashed border-white/15 bg-slate-900 p-4 text-sm leading-6 text-slate-300">
                        No open inbox threads found.
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
                    <span className="shrink-0 rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">
                      {formatStage(selectedContact.pipeline?.stage)}
                    </span>
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
                            <option value="">Add new property below</option>
                          </select>
                        </label>
                      ) : (
                        <input type="hidden" name="propertyId" value="" />
                      )}
                      <div className="rounded-md border border-white/10 bg-slate-950 p-3">
                        <p className="text-xs font-semibold text-slate-300">New property address</p>
                        {detectedThreadAddress ? (
                          <p className="mt-1 text-xs leading-5 text-cyan-100">
                            Found in the thread and prefilled. Booking will save it to the contact.
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
                        <span className="text-xs font-semibold text-slate-300">Type</span>
                        <select
                          name="appointmentType"
                          defaultValue="job"
                          className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                        >
                          <option value="job">Job</option>
                          <option value="in_person_quote">In-person quote</option>
                        </select>
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold text-slate-300">Start</span>
                        <input
                          name="startAt"
                          type="datetime-local"
                          required
                          className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                        />
                      </label>
                      <div className="grid grid-cols-2 gap-2">
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
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-300">Quoted $</span>
                          <input
                            name="quotedTotal"
                            inputMode="decimal"
                            className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
                            placeholder="450"
                          />
                        </label>
                      </div>
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

                  {selectedContact.properties?.length ? (
                    <details className="mt-3 rounded-md border border-white/10 bg-slate-900 p-3">
                      <summary className="cursor-pointer text-sm font-semibold text-slate-100">Create quote</summary>
                      <form action={createMobileQuoteAction} className="mt-3 space-y-3">
                        <input type="hidden" name="contactId" value={selectedContact.id} />
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
                          </select>
                        </label>
                        <div className="space-y-2">
                          <p className="text-xs font-semibold text-slate-300">Services and price</p>
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
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-300">Notes</span>
                          <textarea
                            name="notes"
                            rows={3}
                            className="mt-1 w-full resize-none rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                            placeholder="Scope, exclusions, or customer details..."
                          />
                        </label>
                        <label className="flex items-center gap-2 text-sm text-slate-200">
                          <input name="sendQuote" type="checkbox" className="rounded border-slate-600 bg-slate-900" defaultChecked={Boolean(selectedContact.email)} />
                          Send now
                        </label>
                        <button type="submit" className="w-full rounded-md bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950">
                          Create quote
                        </button>
                      </form>
                    </details>
                  ) : null}

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
              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">My Day</p>
                <h2 className="mt-1 text-lg font-semibold">{formatDateLabel(calendarDay)}</h2>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                    <p className="text-xs text-slate-400">Stops</p>
                    <p className="mt-1 text-xl font-semibold">{calendarEvents.length}</p>
                  </div>
                  <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                    <p className="text-xs text-slate-400">Jobs</p>
                    <p className="mt-1 text-xl font-semibold">{mobileJobEvents.length}</p>
                  </div>
                  <div className="rounded-md border border-white/10 bg-slate-900 p-3">
                    <p className="text-xs text-slate-400">Projected</p>
                    <p className="mt-1 text-lg font-semibold text-cyan-200">{formatUsdCents(projectedCents)}</p>
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
                  <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">{calendarEvents.length}</span>
                </div>
                <div className="mt-3 space-y-2">
                  {calendarEvents.length > 0 ? (
                    calendarEvents.map((event) => {
                      const appointmentId = event.appointmentId ?? (event.id.startsWith("db:") ? event.id.replace(/^db:/, "") : "");
                      const canUpdate = Boolean(appointmentId && event.source === "db");
                      const eventAmount = getProjectedEventCents(event);
                      const mapsHref = event.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.address)}` : null;
                      return (
                        <div key={event.id} className="rounded-md border border-white/10 bg-slate-900 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-cyan-200">
                                {formatTime(event.start)} - {formatTime(event.end)}
                              </p>
                              <p className="mt-1 truncate text-sm font-semibold text-white">{event.contactName ?? event.title}</p>
                              {event.address ? <p className="mt-1 text-sm leading-5 text-slate-300">{event.address}</p> : null}
                            </div>
                            <span className="shrink-0 rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold capitalize text-slate-300">
                              {event.status ?? event.source}
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
                            {eventAmount > 0 ? <span className="ml-auto py-2 text-xs font-semibold text-cyan-200">{formatUsdCents(eventAmount)}</span> : null}
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
                    <span className="shrink-0 rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">
                      {formatStage(contactDetail.pipeline?.stage)}
                    </span>
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
                    <h2 className="mt-1 text-lg font-semibold">Mobile quote list</h2>
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
                      {status}
                    </Link>
                  ))}
                </div>
              </div>

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
                          </div>
                          <span className="shrink-0 rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold capitalize text-slate-300">
                            {quote.status}
                          </span>
                        </div>
                        <p className="mt-3 text-sm text-slate-300">{quote.services.map(formatStage).join(", ")}</p>
                        {quote.notes ? <p className="mt-2 text-sm leading-5 text-slate-400">{quote.notes}</p> : null}
                        <p className="mt-1 text-xs text-slate-500">
                          Updated {formatRelativeTime(quote.updatedAt)}
                          {quote.sentAt ? ` • Sent ${formatRelativeTime(quote.sentAt)}` : ""}
                        </p>
                        {quote.status === "pending" || quote.status === "sent" ? (
                          <details className="mt-3 rounded-md border border-white/10 bg-slate-900 p-3">
                            <summary className="cursor-pointer list-none text-sm font-semibold text-cyan-100">
                              Edit quote
                            </summary>
                            <form action={updateMobileQuoteAction} className="mt-3 space-y-3">
                              <input type="hidden" name="quoteId" value={quote.id} />
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
                              href={`/quote/${quote.shareToken}`}
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
                    <h2 className="mt-1 text-lg font-semibold">{formatDateLabel(calendarDay)}</h2>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-400">Projected</p>
                    <p className="text-xl font-semibold text-cyan-200">{formatUsdCents(projectedCents)}</p>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <Link
                    href={`/mobile?screen=calendar&date=${encodeURIComponent(addDaysToKey(calendarDay, -1))}` as Route}
                    className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-center text-sm font-semibold text-slate-200"
                  >
                    Prev
                  </Link>
                  <Link
                    href="/mobile?screen=calendar"
                    className="rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-center text-sm font-semibold text-slate-950"
                  >
                    Today
                  </Link>
                  <Link
                    href={`/mobile?screen=calendar&date=${encodeURIComponent(addDaysToKey(calendarDay, 1))}` as Route}
                    className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-center text-sm font-semibold text-slate-200"
                  >
                    Next
                  </Link>
                </div>
              </div>

              <div className="space-y-3">
                {calendarEvents.length > 0 ? (
                  calendarEvents.map((event) => {
                    const appointmentId = event.appointmentId ?? (event.id.startsWith("db:") ? event.id.replace(/^db:/, "") : "");
                    const status = (event.status ?? "").trim().toLowerCase();
                    const canUpdate = Boolean(appointmentId && event.source === "db");
                    const eventAmount = getProjectedEventCents(event);
                    return (
                      <div key={event.id} className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-cyan-200">
                              {formatTime(event.start)} - {formatTime(event.end)}
                            </p>
                            <h3 className="mt-1 truncate text-base font-semibold">{event.contactName ?? event.title}</h3>
                            {event.address ? <p className="mt-1 text-sm leading-5 text-slate-300">{event.address}</p> : null}
                          </div>
                          <span className="shrink-0 rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold capitalize text-slate-300">
                            {event.status ?? event.source}
                          </span>
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                          <span className="text-slate-400">{event.appointmentType ? formatStage(event.appointmentType) : "Calendar event"}</span>
                          {eventAmount > 0 ? <span className="font-semibold text-cyan-200">{formatUsdCents(eventAmount)}</span> : null}
                        </div>
                        {event.notes?.length ? (
                          <div className="mt-3 rounded-md border border-white/10 bg-slate-900 p-3 text-sm leading-6 text-slate-300">
                            {event.notes[0]?.body}
                          </div>
                        ) : null}
                        {canUpdate ? (
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            {status !== "canceled" ? (
                              <form action={updateMobileAppointmentStatusAction}>
                                <input type="hidden" name="appointmentId" value={appointmentId} />
                                <input type="hidden" name="date" value={calendarDay} />
                                <button
                                  type="submit"
                                  name="status"
                                  value="canceled"
                                  className="w-full rounded-md border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-sm font-semibold text-rose-100"
                                >
                                  Cancel
                                </button>
                              </form>
                            ) : null}
                            <div className="col-span-2">
                              <MobileCompleteAppointmentForm
                                event={event}
                                appointmentId={appointmentId}
                                calendarDay={calendarDay}
                                screen="calendar"
                                teamMembers={teamMembers}
                              />
                            </div>
                            <details className="col-span-2 rounded-md border border-white/10 bg-slate-900 p-3">
                              <summary className="cursor-pointer list-none text-sm font-semibold text-cyan-100">
                                Reschedule
                              </summary>
                              <form action={rescheduleMobileAppointmentAction} className="mt-3 space-y-3">
                                <input type="hidden" name="appointmentId" value={appointmentId} />
                                <input type="hidden" name="currentDate" value={calendarDay} />
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
                            <details className="col-span-2 rounded-md border border-white/10 bg-slate-900 p-3">
                              <summary className="cursor-pointer list-none text-sm font-semibold text-cyan-100">
                                Upload photo or receipt
                              </summary>
                              <form action={addMobileAppointmentAttachmentAction} className="mt-3 space-y-3">
                                <input type="hidden" name="appointmentId" value={appointmentId} />
                                <input type="hidden" name="date" value={calendarDay} />
                                <label className="block">
                                  <span className="text-xs font-semibold text-slate-300">File</span>
                                  <input
                                    name="file"
                                    type="file"
                                    accept="image/*,application/pdf"
                                    required
                                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white file:mr-3 file:rounded-md file:border-0 file:bg-cyan-300 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-slate-950"
                                  />
                                  <span className="mt-1 block text-xs text-slate-500">Max 20MB.</span>
                                </label>
                                <label className="block">
                                  <span className="text-xs font-semibold text-slate-300">Label</span>
                                  <input
                                    name="filename"
                                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300"
                                    placeholder="Job photo, quote photo, dump receipt..."
                                  />
                                </label>
                                <button
                                  type="submit"
                                  className="w-full rounded-md border border-cyan-300 bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950"
                                >
                                  Save upload
                                </button>
                              </form>
                            </details>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                ) : (
                  <div className="rounded-lg border border-dashed border-white/15 bg-slate-900 p-4 text-sm leading-6 text-slate-300">
                    No appointments for this day.
                  </div>
                )}
              </div>
            </div>
          ) : activeScreen === "owner" && ownerSummary ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Owner Snapshot</p>
                <h2 className="mt-1 text-lg font-semibold">{formatDateLabel(ownerSummary.todayKey)}</h2>
                <p className="mt-1 text-sm text-slate-300">Collected cash, projected work, leads, follow-ups, and provider health.</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-200">Collected</p>
                  <p className="mt-2 text-2xl font-semibold">{formatUsdCents(ownerSummary.collectedTodayCents)}</p>
                  <p className="mt-1 text-xs text-emerald-100">{ownerSummary.collectedTodayCount} payments today</p>
                </div>
                <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-200">Projected</p>
                  <p className="mt-2 text-2xl font-semibold">{formatUsdCents(ownerSummary.projectedTodayCents)}</p>
                  <p className="mt-1 text-xs text-cyan-100">{ownerSummary.bookedJobsToday} booked jobs today</p>
                </div>
                <Link href="/mobile" className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">Open Leads</p>
                  <p className="mt-2 text-2xl font-semibold">{ownerSummary.openInboxLeads}</p>
                  <p className="mt-1 text-xs text-slate-400">Inbox threads</p>
                </Link>
                <Link href="/mobile?screen=myday" className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">Follow-ups</p>
                  <p className="mt-2 text-2xl font-semibold">{ownerSummary.openFollowUps}</p>
                  <p className="mt-1 text-xs text-slate-400">Due now</p>
                </Link>
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
                    ownerSummary.nextAppointments.map((appointment) => (
                      <div key={appointment.id} className="rounded-md border border-white/10 bg-slate-900 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">{appointment.contactName ?? appointment.title}</p>
                            <p className="mt-1 text-xs text-slate-400">
                              {appointment.time}
                              {appointment.address ? ` • ${appointment.address}` : ""}
                            </p>
                          </div>
                          <span className="shrink-0 text-sm font-semibold text-cyan-100">{formatUsdCents(appointment.projectedCents)}</span>
                        </div>
                      </div>
                    ))
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

              <div className="rounded-lg border border-white/10 bg-white/[0.08] p-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-semibold">Follow-ups</h2>
                  <Link href="/mobile?screen=myday" className="text-sm font-semibold text-cyan-200">
                    My Day
                  </Link>
                </div>
                <div className="mt-3 space-y-2">
                  {ownerSummary.followUps.length > 0 ? (
                    ownerSummary.followUps.map((task) => (
                      <div key={task.id} className="rounded-md border border-white/10 bg-slate-900 p-3">
                        <p className="text-sm font-semibold">{task.title}</p>
                        <p className="mt-1 text-xs text-slate-400">
                          {task.dueAt ? `Due ${formatDateLabel(formatDayKey(new Date(task.dueAt)))}` : "No due date"}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="rounded-md border border-dashed border-white/15 bg-slate-900 p-3 text-sm text-slate-300">
                      No due follow-ups.
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

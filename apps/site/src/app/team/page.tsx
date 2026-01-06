import React from "react";
import { cookies } from "next/headers";
import { AdminLoginForm } from "../admin/login/LoginForm";
import { CrewLoginForm } from "../crew/login/LoginForm";
import {
  logoutCrew,
  logoutOwner,
  dismissNewLeadAction,
  saveCallAgentPhoneAction,
  clearCallAgentPhoneAction,
  setCallAgentChoiceAction,
  updatePipelineStageAction
} from "./actions";
import { MyDaySection } from "./components/MyDaySection";
import { QuotesSection } from "./components/QuotesSection";
import { InstantQuotesSection } from "./components/InstantQuotesSection";
import { ContactsSection } from "./components/ContactsSection";
import { PipelineSection } from "./components/PipelineSection";
import { QuoteBuilderSection } from "./components/QuoteBuilderSection";
import { ChatSection } from "./components/ChatSection";
import { CalendarSection } from "./components/CalendarSection";
import { OwnerSection } from "./components/OwnerSection";
import { InboxSection } from "./components/InboxSection";
import { PolicyCenterSection } from "./components/PolicyCenterSection";
import { AutomationSection } from "./components/AutomationSection";
import { AccessSection } from "./components/AccessSection";
import { AuditLogSection } from "./components/AuditLogSection";
import { MergeQueueSection } from "./components/MergeQueueSection";
import { TabNav, type TabNavGroup, type TabNavItem } from "./components/TabNav";
import { callAdminApi } from "./lib/api";
import { FlashClearer } from "./components/FlashClearer";

const ADMIN_COOKIE = "myst-admin-session";
const CREW_COOKIE = "myst-crew-session";

export const metadata = { title: "Stonegate Team Console" };

type LeadContactSummary = {
  id: string;
  name: string;
  phone: string | null;
  phoneE164: string | null;
  pipeline?: { stage?: string | null };
};

export default async function TeamPage({
  searchParams
}: {
  searchParams: Promise<{ tab?: string; q?: string; offset?: string; contactId?: string; threadId?: string; status?: string }>;
}) {
  const params = await searchParams;
  const cookieStore = await cookies();
  const hasOwner = cookieStore.get(ADMIN_COOKIE)?.value ? true : false;
  const hasCrew = cookieStore.get(CREW_COOKIE)?.value ? true : false;
  const devonCallPhone = cookieStore.get("myst-call-agent-devon-phone")?.value ?? "";
  const austinCallPhone = cookieStore.get("myst-call-agent-owner-phone")?.value ?? "";
  const callAgentChoice = cookieStore.get("myst-call-agent-choice")?.value ?? "devon";

  const requestedTab = params?.tab;
  const tab =
    requestedTab === "estimates"
      ? hasOwner
        ? "inbox"
        : "myday"
      : requestedTab || (hasCrew && !hasOwner ? "myday" : "inbox");
  const contactsQuery = typeof params?.q === "string" ? params.q : undefined;
  let contactsOffset: number | undefined;
  if (typeof params?.offset === "string") {
    const parsed = Number(params.offset);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      contactsOffset = parsed;
    }
  }
  const contactIdParam = typeof params?.contactId === "string" ? params.contactId : undefined;
  const inboxThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
  const inboxStatus = typeof params?.status === "string" ? params.status : undefined;

  const flash = cookieStore.get("myst-flash")?.value ?? null;
  const flashError = cookieStore.get("myst-flash-error")?.value ?? null;
  const dismissedNewLeadId = cookieStore.get("myst-new-lead-dismissed")?.value ?? null;
  const tabs: TabNavItem[] = [
    { id: "myday", label: "My Day", href: "/team?tab=myday", requires: "crew" },
    { id: "quotes", label: "Quotes", href: "/team?tab=quotes", requires: "owner" },
    { id: "quote-builder", label: "Quote Builder", href: "/team?tab=quote-builder", requires: "crew" },
    { id: "inbox", label: "Inbox", href: "/team?tab=inbox", requires: "owner" },
    { id: "chat", label: "Chat", href: "/team?tab=chat", requires: "owner" },
    { id: "pipeline", label: "Pipeline", href: "/team?tab=pipeline", requires: "owner" },
    { id: "calendar", label: "Calendar", href: "/team?tab=calendar", requires: "owner" },
    { id: "contacts", label: "Contacts", href: "/team?tab=contacts", requires: "owner" },
    { id: "owner", label: "Owner HQ", href: "/team?tab=owner", requires: "owner" },
    { id: "policy", label: "Policy Center", href: "/team?tab=policy", requires: "owner" },
    { id: "automation", label: "Automation", href: "/team?tab=automation", requires: "owner" },
    { id: "access", label: "Access", href: "/team?tab=access", requires: "owner" },
    { id: "audit", label: "Audit Log", href: "/team?tab=audit", requires: "owner" },
    { id: "merge", label: "Merge Queue", href: "/team?tab=merge", requires: "owner" },
    { id: "settings", label: "Settings", href: "/team?tab=settings" }
  ];
  const tabGroups: TabNavGroup[] = [
    { id: "ops", label: "Ops", itemIds: ["myday", "calendar", "chat"] },
    { id: "sales", label: "Sales", itemIds: ["quotes", "quote-builder", "pipeline", "contacts", "inbox"] },
    { id: "owner", label: "Owner HQ", itemIds: ["owner"], variant: "single" },
    { id: "control", label: "Control", itemIds: ["policy", "automation", "access", "audit", "merge"] },
    { id: "account", label: "Account", itemIds: ["settings"], variant: "dropdown" }
  ];
  const activeTab = tabs.find((item) => item.id === tab) ?? tabs[0] ?? null;
  const activeRequirement = activeTab?.requires;
  const needsCrewLogin = activeRequirement === "crew" && !hasCrew && !hasOwner;
  const needsOwnerLogin = activeRequirement === "owner" && !hasOwner;

  let calendarBadge: CalendarSyncBadge | null = null;
  if (tab === "settings" && hasOwner) {
    try {
      const response = await callAdminApi("/api/calendar/status");
      if (response.ok) {
        const payload = (await response.json()) as CalendarStatusApiResponse;
        calendarBadge = evaluateCalendarBadge(payload);
      } else {
        calendarBadge = {
          tone: "alert",
          headline: "Status request failed",
          detail: `HTTP ${response.status}`
        };
      }
    } catch (error) {
      calendarBadge = {
        tone: "alert",
        headline: "Status request failed",
        detail: "API unreachable"
      };
    }
  }

  let newLead: LeadContactSummary | null = null;
  if (hasOwner || hasCrew) {
    try {
      const response = await callAdminApi("/api/admin/contacts?limit=12");
      if (response.ok) {
        const payload = (await response.json()) as { contacts?: LeadContactSummary[] };
        const contacts = payload.contacts ?? [];
        newLead =
          contacts.find(
            (contact) =>
              contact.pipeline?.stage === "new" &&
              (!dismissedNewLeadId || contact.id !== dismissedNewLeadId)
          ) ?? null;
      }
    } catch {
      newLead = null;
    }
  }

  return (
    <div className="relative min-h-screen overflow-visible bg-gradient-to-br from-slate-100 via-white to-slate-50">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.12),_transparent_50%)]" />
      <main className="relative mx-auto max-w-6xl space-y-6 px-4 py-8 sm:space-y-8 sm:px-6 sm:py-10 lg:px-8">
        <header className="relative z-50 overflow-visible rounded-3xl border border-white/70 bg-white/80 p-6 shadow-xl shadow-slate-200/60 backdrop-blur sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <span className="inline-flex items-center rounded-full bg-primary-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.25em] text-primary-700">
                Stonegate Team
              </span>
              <h1 className="mt-4 text-3xl font-semibold text-slate-900 sm:text-4xl">Team Console</h1>
              <p className="mt-2 max-w-3xl text-sm text-slate-600 sm:text-base">
                Monitor appointments, quotes, pipeline health, and contacts from a single polished workspace designed for your crew and office team.
              </p>
            </div>
            <div className="grid gap-2 text-sm text-slate-600 sm:justify-items-end sm:text-right">
              <span
                className={`inline-flex w-full items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium sm:w-auto ${
                  hasCrew ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
                }`}
              >
                Crew {hasCrew ? "signed in" : "login required"}
              </span>
              <span
                className={`inline-flex w-full items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium sm:w-auto ${
                  hasOwner ? "bg-primary-100 text-primary-700" : "bg-slate-100 text-slate-500"
                }`}
              >
                Owner {hasOwner ? "access granted" : "login required"}
              </span>
            </div>
          </div>
          <div className="mt-6">
            <TabNav items={tabs} groups={tabGroups} activeId={tab} hasOwner={hasOwner} hasCrew={hasCrew} />
          </div>
        </header>

        {flash ? (
          <div className="rounded-2xl border border-emerald-200/70 bg-emerald-50/80 p-4 text-sm text-emerald-700 shadow-sm shadow-emerald-100">
            {flash}
          </div>
        ) : null}
        {flashError ? (
          <div className="rounded-2xl border border-rose-200/70 bg-rose-50/80 p-4 text-sm text-rose-700 shadow-sm shadow-rose-100">
            {flashError}
          </div>
        ) : null}
        {flash || flashError ? <FlashClearer /> : null}
        {newLead ? (
          <section className="rounded-2xl border border-emerald-200/70 bg-emerald-50/80 p-4 shadow-sm shadow-emerald-100">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">New lead ready</p>
                <p className="mt-1 text-sm font-semibold text-emerald-900">{newLead.name || "New lead"}</p>
                <p className="mt-1 text-xs text-emerald-700">
                  {newLead.phoneE164 ?? newLead.phone ?? "Phone not on file yet"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <a
                  className="rounded-full border border-emerald-200 px-3 py-2 font-semibold text-emerald-800 hover:border-emerald-300 hover:text-emerald-900"
                  href={`/team?tab=contacts&contactId=${encodeURIComponent(newLead.id)}`}
                >
                  Open contact
                </a>
                <form action={updatePipelineStageAction}>
                  <input type="hidden" name="contactId" value={newLead.id} />
                  <input type="hidden" name="stage" value="contacted" />
                  <button
                    type="submit"
                    className="rounded-full border border-emerald-200 px-3 py-2 font-semibold text-emerald-800 hover:border-emerald-300 hover:text-emerald-900"
                  >
                    Mark contacted
                  </button>
                </form>
                <form action={dismissNewLeadAction}>
                  <input type="hidden" name="contactId" value={newLead.id} />
                  <button
                    type="submit"
                    className="rounded-full border border-emerald-200 px-3 py-2 font-semibold text-emerald-800 hover:border-emerald-300 hover:text-emerald-900"
                  >
                    Dismiss 24h
                  </button>
                </form>
              </div>
            </div>
          </section>
        ) : null}

        {needsCrewLogin ? (
          <section className="max-w-md rounded-2xl border border-slate-200 bg-white/80 p-6 shadow-lg shadow-slate-200/60">
            <CrewLoginForm redirectTo={`/team?tab=${encodeURIComponent(tab)}`} />
          </section>
        ) : needsOwnerLogin ? (
          <section className="max-w-md rounded-2xl border border-slate-200 bg-white/80 p-6 shadow-lg shadow-slate-200/60">
            <AdminLoginForm redirectTo={`/team?tab=${encodeURIComponent(tab)}`} />
          </section>
        ) : null}

        {tab === "myday" && (hasCrew || hasOwner) ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading My Day
              </div>
            }
          >
            <MyDaySection />
          </React.Suspense>
        ) : null}

        {tab === "quote-builder" && (hasCrew || hasOwner) ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading Quote Builder
              </div>
            }
          >
            <QuoteBuilderSection initialContactId={contactIdParam} />
          </React.Suspense>
        ) : null}

        {tab === "chat" && hasOwner ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading chat
              </div>
            }
          >
            <ChatSection />
          </React.Suspense>
        ) : null}

        {tab === "inbox" && hasOwner ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading inbox
              </div>
            }
          >
            <InboxSection threadId={inboxThreadId} status={inboxStatus} />
          </React.Suspense>
        ) : null}

        {tab === "calendar" && hasOwner ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading calendar
              </div>
            }
          >
            <CalendarSection searchParams={params as any} />
          </React.Suspense>
        ) : null}

        {tab === "quotes" && hasOwner ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading Quotes
              </div>
            }
          >
            <div className="space-y-4">
              <QuotesSection />
              <InstantQuotesSection />
            </div>
          </React.Suspense>
        ) : null}

        {tab === "pipeline" && hasOwner ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading pipeline
              </div>
            }
          >
            <PipelineSection />
          </React.Suspense>
        ) : null}

        {tab === "contacts" && hasOwner ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading contacts
              </div>
            }
          >
            <ContactsSection search={contactsQuery} offset={contactsOffset} contactId={contactIdParam} />
          </React.Suspense>
        ) : null}

        {tab === "owner" && hasOwner ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading owner tools
              </div>
            }
          >
            <OwnerSection />
          </React.Suspense>
        ) : null}

        {tab === "policy" && hasOwner ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading policy center
              </div>
            }
          >
            <PolicyCenterSection />
          </React.Suspense>
        ) : null}

        {tab === "automation" && hasOwner ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading automation
              </div>
            }
          >
            <AutomationSection />
          </React.Suspense>
        ) : null}

        {tab === "access" && hasOwner ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading access controls
              </div>
            }
          >
            <AccessSection />
          </React.Suspense>
        ) : null}

        {tab === "audit" && hasOwner ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading audit log
              </div>
            }
          >
            <AuditLogSection />
          </React.Suspense>
        ) : null}

        {tab === "merge" && hasOwner ? (
          <React.Suspense
            fallback={
              <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-sm text-slate-500 shadow-lg shadow-slate-200/50">
                Loading merge queue
              </div>
            }
          >
            <MergeQueueSection />
          </React.Suspense>
        ) : null}

        {tab === "settings" ? (
          <section className="space-y-4 rounded-2xl border border-slate-200 bg-white/80 p-6 text-sm text-slate-600 shadow-lg shadow-slate-200/60">
            <div className="space-y-4">
              <h2 className="text-base font-semibold text-slate-900">Calling</h2>
              <p className="text-xs text-slate-500">
                Choose who should be rung when you click <span className="font-semibold">Call (Stonegate #)</span> on a contact.
                When answered, the system connects to the customer and shows the Stonegate number as caller ID.
              </p>

              <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm font-semibold text-slate-800">
                  Default caller:{" "}
                  <span className="text-primary-700">{callAgentChoice === "owner" ? "Austin" : "Devon"}</span>
                </div>
                <form action={setCallAgentChoiceAction} className="flex items-center gap-2">
                  <input type="hidden" name="choice" value={callAgentChoice === "owner" ? "devon" : "owner"} />
                  <button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700">
                    Switch to {callAgentChoice === "owner" ? "Devon" : "Austin"}
                  </button>
                </form>
              </div>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
                  <h3 className="text-sm font-semibold text-slate-800">Devon phone</h3>
                  <p className="mt-1 text-xs text-slate-500">Rings Devon for outbound calls.</p>
                  <div className="mt-3 flex flex-col gap-2">
                    <form action={saveCallAgentPhoneAction} className="space-y-2">
                      <input type="hidden" name="who" value="devon" />
                      <input
                        name="agentPhone"
                        defaultValue={devonCallPhone}
                        placeholder="e.g. +16785258427"
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm shadow-slate-200/40 outline-none focus:border-primary-300 focus:ring-2 focus:ring-primary-200"
                      />
                      <button className="w-full rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-primary-700">
                        Save Devon phone
                      </button>
                    </form>
                    <form action={clearCallAgentPhoneAction}>
                      <input type="hidden" name="who" value="devon" />
                      <button className="w-full rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:border-slate-300 hover:text-slate-800">
                        Clear Devon phone
                      </button>
                    </form>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
                  <h3 className="text-sm font-semibold text-slate-800">Austin phone</h3>
                  <p className="mt-1 text-xs text-slate-500">Rings Austin when Devon is unavailable.</p>
                  <div className="mt-3 flex flex-col gap-2">
                    <form action={saveCallAgentPhoneAction} className="space-y-2">
                      <input type="hidden" name="who" value="owner" />
                      <input
                        name="agentPhone"
                        defaultValue={austinCallPhone}
                        placeholder="e.g. +15617015127"
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm shadow-slate-200/40 outline-none focus:border-primary-300 focus:ring-2 focus:ring-primary-200"
                      />
                      <button className="w-full rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-primary-700">
                        Save Austin phone
                      </button>
                    </form>
                    <form action={clearCallAgentPhoneAction}>
                      <input type="hidden" name="who" value="owner" />
                      <button className="w-full rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:border-slate-300 hover:text-slate-800">
                        Clear Austin phone
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <h2 className="text-base font-semibold text-slate-900">Sessions</h2>
              <div className="flex flex-wrap gap-3">
                <form action={logoutCrew}>
                  <button className="rounded-full border border-slate-200 px-4 py-2 text-xs font-medium text-slate-600 hover:border-slate-300 hover:text-slate-800">
                    Log out crew
                  </button>
                </form>
                <form action={logoutOwner}>
                  <button className="rounded-full border border-slate-200 px-4 py-2 text-xs font-medium text-slate-600 hover:border-slate-300 hover:text-slate-800">
                    Log out owner
                  </button>
                </form>
              </div>
            </div>

            {hasOwner && calendarBadge ? (
              <div
                className={`rounded-xl border px-4 py-3 text-xs ${calendarBadgeToneClasses[calendarBadge.tone]}`}
                title={calendarBadge.detail ?? undefined}
              >
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-current/70">Calendar Sync</span>
                <span className="mt-1 block text-sm font-medium text-current">{calendarBadge.headline}</span>
                {calendarBadge.detail ? (
                  <span className="block text-[11px] text-current/80">{calendarBadge.detail}</span>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}








interface CalendarStatusApiResponse {
  ok: boolean;
  config: {
    calendarId: string | null;
    webhookConfigured: boolean;
  };
  status: {
    calendarId: string;
    syncTokenPresent: boolean;
    channelId: string | null;
    resourceId: string | null;
    channelExpiresAt: string | null;
    lastSyncedAt: string | null;
    lastNotificationAt: string | null;
    updatedAt: string | null;
  } | null;
  error?: string;
}

type CalendarBadgeTone = "ok" | "warn" | "alert" | "idle";

interface CalendarSyncBadge {
  tone: CalendarBadgeTone;
  headline: string;
  detail?: string;
}

const defaultCalendarBadge: CalendarSyncBadge = {
  tone: "idle",
  headline: "Status unavailable"
};

const calendarBadgeToneClasses: Record<CalendarBadgeTone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warn: "border-amber-200 bg-amber-50 text-amber-700",
  alert: "border-rose-200 bg-rose-50 text-rose-700",
  idle: "border-slate-200 bg-white text-slate-500"
};

function evaluateCalendarBadge(payload: CalendarStatusApiResponse): CalendarSyncBadge {
  if (!payload.ok) {
    return {
      tone: "alert",
      headline: "Status unavailable",
      detail: payload.error
    };
  }

  if (!payload.config.calendarId) {
    return {
      tone: "idle",
      headline: "Calendar not configured",
      detail: "Set GOOGLE_CALENDAR_ID"
    };
  }

  if (!payload.config.webhookConfigured) {
    return {
      tone: "warn",
      headline: "Webhook missing",
      detail: "Set GOOGLE_CALENDAR_WEBHOOK_URL"
    };
  }

  const status = payload.status;
  if (!status) {
    return {
      tone: "warn",
      headline: "Awaiting first sync",
      detail: "No sync record yet"
    };
  }

  const lastSyncedAt = status.lastSyncedAt ? new Date(status.lastSyncedAt) : null;
  const lastNotificationAt = status.lastNotificationAt ? new Date(status.lastNotificationAt) : null;
  const channelExpiresAt = status.channelExpiresAt ? new Date(status.channelExpiresAt) : null;
  const now = Date.now();

  const missingChannel = !status.channelId;
  const missingToken = !status.syncTokenPresent;
  const staleSync = !lastSyncedAt || now - lastSyncedAt.getTime() > 3 * 60 * 60 * 1000;
  const staleNotification = !lastNotificationAt || now - lastNotificationAt.getTime() > 2 * 60 * 60 * 1000;
  const expiringSoon = !channelExpiresAt || channelExpiresAt.getTime() - now < 45 * 60 * 1000;

  const detailParts = [
    `Last sync ${formatAgo(lastSyncedAt)}`,
    `Watch renews ${formatFuture(channelExpiresAt)}`
  ];

  if (lastNotificationAt) {
    detailParts.push(`Last ping ${formatAgo(lastNotificationAt)}`);
  }

  if (missingChannel || missingToken) {
    return {
      tone: "alert",
      headline: missingChannel ? "Watch not registered" : "Sync token missing",
      detail: detailParts.join(" | ")
    };
  }

  if (staleSync) {
    return {
      tone: "warn",
      headline: "Sync lagging",
      detail: detailParts.join(" | ")
    };
  }

  if (staleNotification) {
    return {
      tone: "warn",
      headline: "No recent webhook",
      detail: detailParts.join(" | ")
    };
  }

  if (expiringSoon) {
    return {
      tone: "warn",
      headline: "Watch renews soon",
      detail: detailParts.join(" | ")
    };
  }

  return {
    tone: "ok",
    headline: "Healthy",
    detail: detailParts.join(" | ")
  };
}

function formatAgo(value: Date | null): string {
  if (!value) return "never";
  const diff = Date.now() - value.getTime();
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatFuture(value: Date | null): string {
  if (!value) return "not scheduled";
  const diff = value.getTime() - Date.now();
  if (diff <= 0) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

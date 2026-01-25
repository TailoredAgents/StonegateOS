import React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  logoutCrew,
  logoutOwner,
  dismissNewLeadAction,
  updatePipelineStageAction
} from "./actions";
import { teamLogoutAction, teamSetPasswordAction } from "./login/actions";
import { MyDaySection } from "./components/MyDaySection";
import { ContactsSection } from "./components/ContactsSection";
import { PipelineSection } from "./components/PipelineSection";
import { ChatSection } from "./components/ChatSection";
import { CalendarSection } from "./components/CalendarSection";
import { OwnerSection } from "./components/OwnerSection";
import { InboxSection } from "./components/InboxSection";
import { ExpensesSection } from "./components/ExpensesSection";
import { CommissionsSection } from "./components/CommissionsSection";
import { MarketingSection } from "./components/MarketingSection";
import { PolicyCenterSection } from "./components/PolicyCenterSection";
import { AutomationSection } from "./components/AutomationSection";
import { AccessSection } from "./components/AccessSection";
import { AuditLogSection } from "./components/AuditLogSection";
import { SalesActivityLogSection } from "./components/SalesActivityLogSection";
import { MergeQueueSection } from "./components/MergeQueueSection";
import { SalesScorecardSection } from "./components/SalesScorecardSection";
import { OutboundSection } from "./components/OutboundSection";
import { PartnersSection } from "./components/PartnersSection";
import { SeoAgentSection } from "./components/SeoAgentSection";
import { QuotesHubSection } from "./components/QuotesHubSection";
import { SystemHealthBanner } from "./components/SystemHealthBanner";
import { TabNav, type TabNavGroup, type TabNavItem } from "./components/TabNav";
import { TeamAppShell, type TeamNavGroup, type TeamNavItem as ShellNavItem } from "./components/TeamAppShell";
import { callAdminApi, resolveTeamMemberFromSessionCookie } from "./lib/api";
import { FlashClearer } from "./components/FlashClearer";
import { TeamSkeletonCard } from "./components/TeamSkeleton";
import { TEAM_CARD_PADDED, TEAM_SECTION_SUBTITLE, TEAM_SECTION_TITLE, teamButtonClass } from "./components/team-ui";

const ADMIN_COOKIE = "myst-admin-session";
const CREW_COOKIE = "myst-crew-session";

export const metadata = {
  title: "Stonegate Team Console",
  robots: { index: false, follow: false }
};

type LeadContactSummary = {
  id: string;
  name: string;
  phone: string | null;
  phoneE164: string | null;
  source?: string | null;
  pipeline?: { stage?: string | null };
};

type SystemHealthApiFinding = {
  id: string;
  severity: "blocker" | "warning";
  title: string;
  detail: string;
  fix: string[];
};

type SystemHealthApiResponse = {
  ok: true;
  generatedAt: string;
  blockers: SystemHealthApiFinding[];
  warnings: SystemHealthApiFinding[];
};

export default async function TeamPage({
  searchParams
}: {
  searchParams: Promise<{
    tab?: string;
    q?: string;
    offset?: string;
    includeOutbound?: string;
    contactId?: string;
    threadId?: string;
    status?: string;
    channel?: string;
    memberId?: string;
    out_q?: string;
    out_campaign?: string;
    out_attempt?: string;
    out_due?: string;
    out_has?: string;
    out_disposition?: string;
    out_taskId?: string;
    out_offset?: string;
    p_status?: string;
    p_owner?: string;
    p_type?: string;
    p_q?: string;
    p_offset?: string;
    p_selected?: string;
    quoteMode?: string;
    view?: string;
    onlyOutbound?: string;
    gaReportId?: string;
    gaCampaignId?: string;
    cal?: string;
    calView?: string;
    setup?: string;
    saved?: string;
    error?: string;
    layout?: string;
  }>;
}) {
  const params = await searchParams;
  const cookieStore = await cookies();
  const legacyOwnerSession = cookieStore.get(ADMIN_COOKIE)?.value ? true : false;
  const legacyCrewSession = cookieStore.get(CREW_COOKIE)?.value ? true : false;
  const teamMember = await resolveTeamMemberFromSessionCookie();
  const teamRole = teamMember?.roleSlug ?? null;
  const hasOwner = legacyOwnerSession || teamRole === "owner";
  const hasOffice = teamRole === "office";
  const hasCrew = legacyCrewSession || teamRole === "crew";
  const isAuthenticated = hasOwner || hasOffice || hasCrew;

  if (!isAuthenticated) {
    redirect("/team/login");
  }

  const FALLBACK_PERMISSIONS_BY_ROLE: Record<string, string[]> = {
    owner: ["*"],
    office: [
      "messages.send",
      "messages.read",
      "policy.read",
      "policy.write",
      "bookings.manage",
      "automation.read",
      "automation.write",
      "audit.read",
      "appointments.read",
      "appointments.update",
      "expenses.read",
      "expenses.write"
    ],
    crew: ["messages.read", "appointments.read", "appointments.update", "expenses.read", "expenses.write"],
    read_only: ["read"]
  };

  const effectivePermissions: string[] = hasOwner
    ? ["*"]
    : Array.isArray(teamMember?.permissions)
      ? teamMember?.permissions ?? []
      : teamRole && FALLBACK_PERMISSIONS_BY_ROLE[teamRole]
        ? FALLBACK_PERMISSIONS_BY_ROLE[teamRole] ?? []
        : [];

  const permissionMatches = (granted: string, required: string): boolean => {
    if (granted === "*") return true;
    if (required === "read") return granted === "read";
    if (granted === "read") return required === "read" || required.endsWith(".read");
    if (granted.endsWith(".*")) {
      const prefix = granted.slice(0, -2);
      return required.startsWith(prefix);
    }
    return granted === required;
  };

  const hasPermission = (required: string): boolean => {
    if (hasOwner) return true;
    return effectivePermissions.some((permission) => permissionMatches(permission, required));
  };

  const isAllowed = (requires?: TabNavItem["requires"]): boolean => {
    if (!requires) return true;
    const list = Array.isArray(requires) ? requires : [requires];
    return list.some((entry) => {
      if (entry === "owner") return hasOwner;
      if (entry === "office") return hasOffice || hasOwner;
      if (entry === "crew") return hasCrew || hasOwner;
      return hasPermission(entry);
    });
  };

  const requestedTab = params?.tab;
  const requestedQuoteMode = typeof params?.quoteMode === "string" ? params.quoteMode : undefined;
  let forcedQuoteMode: string | undefined;
  let normalizedRequestedTab = requestedTab;
  if (requestedTab === "quote-builder") {
    normalizedRequestedTab = "quotes";
    forcedQuoteMode = "builder";
  } else if (requestedTab === "canvass") {
    normalizedRequestedTab = "quotes";
    forcedQuoteMode = "canvass";
  }
  const tab =
    normalizedRequestedTab === "estimates"
      ? hasOwner
        ? "inbox"
        : "myday"
      : normalizedRequestedTab || (hasCrew && !hasOwner && !hasOffice ? "myday" : "inbox");
  const contactsQuery = typeof params?.q === "string" ? params.q : undefined;
  const contactsView = typeof params?.view === "string" ? params.view.trim().toLowerCase() : "";
  const contactsOnlyOutbound = contactsView === "outbound" || params?.onlyOutbound === "1";
  const contactsIncludeOutbound = contactsView === "all" || params?.includeOutbound === "1";
  let contactsOffset: number | undefined;
  if (typeof params?.offset === "string") {
    const parsed = Number(params.offset);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      contactsOffset = parsed;
    }
  }
  const contactIdParam = typeof params?.contactId === "string" ? params.contactId : undefined;
  const gaReportIdParam = typeof params?.gaReportId === "string" ? params.gaReportId : undefined;
  const gaCampaignIdParam = typeof params?.gaCampaignId === "string" ? params.gaCampaignId : undefined;
  const inboxThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
  const inboxStatus = typeof params?.status === "string" ? params.status : undefined;
  const inboxChannel = typeof params?.channel === "string" ? params.channel : undefined;
  const memberIdParam = typeof params?.memberId === "string" ? params.memberId : undefined;
  const quoteModeParam = forcedQuoteMode ?? requestedQuoteMode;
  const settingsSetup = params?.setup === "1";
  const settingsSaved = params?.saved === "1";
  const settingsError = typeof params?.error === "string" && params.error.trim().length ? params.error.trim() : null;
  const layoutMode = typeof params?.layout === "string" ? params.layout.trim().toLowerCase() : "";
  const useClassicLayout = layoutMode === "classic";
  const outboundFilters = {
    q: typeof params?.out_q === "string" ? params.out_q : undefined,
    campaign: typeof params?.out_campaign === "string" ? params.out_campaign : undefined,
    attempt: typeof params?.out_attempt === "string" ? params.out_attempt : undefined,
    due: typeof params?.out_due === "string" ? params.out_due : undefined,
    has: typeof params?.out_has === "string" ? params.out_has : undefined,
    disposition: typeof params?.out_disposition === "string" ? params.out_disposition : undefined,
    taskId: typeof params?.out_taskId === "string" ? params.out_taskId : undefined,
    offset: typeof params?.out_offset === "string" ? params.out_offset : undefined
  };

  const partnerFilters = {
    status: typeof params?.p_status === "string" ? params.p_status : undefined,
    ownerId: typeof params?.p_owner === "string" ? params.p_owner : undefined,
    type: typeof params?.p_type === "string" ? params.p_type : undefined,
    q: typeof params?.p_q === "string" ? params.p_q : undefined,
    offset: typeof params?.p_offset === "string" ? params.p_offset : undefined,
    selectedId: typeof params?.p_selected === "string" ? params.p_selected : undefined
  };

  const flash = cookieStore.get("myst-flash")?.value ?? null;
  const flashError = cookieStore.get("myst-flash-error")?.value ?? null;
  const dismissedNewLeadId = cookieStore.get("myst-new-lead-dismissed")?.value ?? null;

  let systemHealth: SystemHealthApiResponse | null = null;
  if (hasOwner || hasOffice || hasCrew) {
    try {
      const response = await callAdminApi("/api/admin/system/health", { timeoutMs: 8_000 });
      if (response.ok) {
        const payload = (await response.json().catch(() => null)) as SystemHealthApiResponse | null;
        if (payload && payload.ok) systemHealth = payload;
      }
    } catch {
      systemHealth = null;
    }
  }

  const tabs: TabNavItem[] = [
    { id: "myday", label: "My Day", href: "/team?tab=myday", requires: "appointments.read" },
    { id: "expenses", label: "Expenses", href: "/team?tab=expenses", requires: "expenses.read" },
    { id: "quotes", label: "Quotes", href: "/team?tab=quotes", requires: "appointments.read" },
    { id: "inbox", label: "Inbox", href: "/team?tab=inbox", requires: "messages.send" },
    { id: "chat", label: "Chat", href: "/team?tab=chat", requires: "messages.send" },
    { id: "pipeline", label: "Pipeline", href: "/team?tab=pipeline", requires: "bookings.manage" },
    { id: "sales-hq", label: "Sales HQ", href: "/team?tab=sales-hq", requires: "messages.send" },
    { id: "outbound", label: "Outbound", href: "/team?tab=outbound", requires: "messages.send" },
    { id: "partners", label: "Partners", href: "/team?tab=partners", requires: "owner" },
    { id: "calendar", label: "Calendar", href: "/team?tab=calendar", requires: "bookings.manage" },
    { id: "contacts", label: "Contacts", href: "/team?tab=contacts", requires: "bookings.manage" },
    { id: "owner", label: "Owner HQ", href: "/team?tab=owner", requires: "owner" },
    { id: "policy", label: "Policy Center", href: "/team?tab=policy", requires: "policy.read" },
    { id: "commissions", label: "Commissions", href: "/team?tab=commissions", requires: "access.manage" },
    { id: "marketing", label: "Marketing", href: "/team?tab=marketing", requires: "policy.read" },
    { id: "seo", label: "SEO Agent", href: "/team?tab=seo", requires: "policy.read" },
    { id: "automation", label: "Messaging Automation", href: "/team?tab=automation", requires: "automation.read" },
    { id: "access", label: "Access", href: "/team?tab=access", requires: "access.manage" },
    { id: "sales-log", label: "Sales Log", href: "/team?tab=sales-log", requires: "audit.read" },
    { id: "audit", label: "Audit Log", href: "/team?tab=audit", requires: "audit.read" },
    { id: "merge", label: "Merge Queue", href: "/team?tab=merge", requires: "contacts.merge" },
    { id: "settings", label: "Settings", href: "/team?tab=settings" }
  ];
  const withLayout = (href: string): string => {
    if (!useClassicLayout) return href;
    return href.includes("?") ? `${href}&layout=classic` : `${href}?layout=classic`;
  };
  const resolvedTabs: TabNavItem[] = useClassicLayout ? tabs.map((item) => ({ ...item, href: withLayout(item.href) })) : tabs;
  const tabGroups: TabNavGroup[] = [
    { id: "ops", label: "Ops", itemIds: ["myday", "expenses", "calendar", "chat"] },
    { id: "sales", label: "Sales", itemIds: ["quotes", "pipeline", "sales-hq", "outbound", "partners", "contacts", "inbox", "calendar"] },
    { id: "owner", label: "Owner HQ", itemIds: ["owner"], variant: "single" },
    { id: "marketing", label: "Marketing", itemIds: ["marketing", "seo"] },
    { id: "control", label: "Control", itemIds: ["commissions", "policy", "automation", "access", "sales-log", "audit", "merge"] },
    { id: "account", label: "Account", itemIds: ["settings"], variant: "dropdown" }
  ];
  const activeTab = resolvedTabs.find((item) => item.id === tab) ?? resolvedTabs[0] ?? null;
  if (activeTab && !isAllowed(activeTab.requires)) {
    const fallback = hasCrew && !hasOffice && !hasOwner ? "myday" : "inbox";
    const fallbackTab =
      resolvedTabs.find((candidate) => candidate.id === fallback && isAllowed(candidate.requires)) ??
      resolvedTabs.find((candidate) => isAllowed(candidate.requires));
    redirect((fallbackTab ? fallbackTab.href : "/team/login") as any);
  }

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
  if (hasOwner || hasOffice || hasCrew) {
    try {
      const response = await callAdminApi("/api/admin/contacts?limit=12");
      if (response.ok) {
        const payload = (await response.json()) as { contacts?: LeadContactSummary[] };
        const contacts = payload.contacts ?? [];
        newLead =
          contacts.find(
            (contact) =>
              contact.pipeline?.stage === "new" &&
              !(contact.source && contact.source.startsWith("outbound:")) &&
              (!dismissedNewLeadId || contact.id !== dismissedNewLeadId)
          ) ?? null;
      }
    } catch {
      newLead = null;
    }
  }

  const content = (
    <>
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
      {systemHealth ? <SystemHealthBanner health={systemHealth} /> : null}
      {newLead ? (
        <section className="rounded-2xl border border-emerald-200/70 bg-emerald-50/80 p-4 shadow-sm shadow-emerald-100">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">New lead ready</p>
              <p className="mt-1 text-sm font-semibold text-emerald-900">{newLead.name || "New lead"}</p>
              <p className="mt-1 text-xs text-emerald-700">{newLead.phoneE164 ?? newLead.phone ?? "Phone not on file yet"}</p>
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

      {tab === "expenses" && (hasCrew || hasOffice || hasOwner) ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading expenses" />}>
          <ExpensesSection />
        </React.Suspense>
      ) : null}

      {tab === "chat" && (hasOffice || hasOwner) ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading chat" />}>
          <ChatSection />
        </React.Suspense>
      ) : null}

      {tab === "inbox" && (hasOffice || hasOwner) ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading inbox" />}>
          <InboxSection threadId={inboxThreadId} status={inboxStatus} contactId={contactIdParam} channel={inboxChannel} />
        </React.Suspense>
      ) : null}

      {tab === "calendar" && (hasOffice || hasOwner) ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading calendar" />}>
          <CalendarSection searchParams={params as any} />
        </React.Suspense>
      ) : null}

      {tab === "quotes" && (hasCrew || hasOffice || hasOwner) ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading Quotes" />}>
          <QuotesHubSection quoteMode={quoteModeParam} contactId={contactIdParam} memberId={memberIdParam} />
        </React.Suspense>
      ) : null}

      {tab === "pipeline" && (hasOffice || hasOwner) ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading pipeline" />}>
          <PipelineSection />
        </React.Suspense>
      ) : null}

      {tab === "sales-hq" && (hasOffice || hasOwner) ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading Sales HQ" />}>
          <SalesScorecardSection />
        </React.Suspense>
      ) : null}

      {tab === "outbound" && (hasOffice || hasOwner) ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading outbound prospects" />}>
          <OutboundSection memberId={memberIdParam} filters={outboundFilters} />
        </React.Suspense>
      ) : null}

      {tab === "partners" && hasOwner ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading partners" />}>
          <PartnersSection filters={partnerFilters} />
        </React.Suspense>
      ) : null}

      {tab === "contacts" && (hasOffice || hasOwner) ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading contacts" />}>
          <ContactsSection
            search={contactsQuery}
            offset={contactsOffset}
            contactId={contactIdParam}
            excludeOutbound={contactsOnlyOutbound ? false : !contactsIncludeOutbound}
            onlyOutbound={contactsOnlyOutbound}
          />
        </React.Suspense>
      ) : null}

      {tab === "owner" && hasOwner ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading owner tools" />}>
          <OwnerSection />
        </React.Suspense>
      ) : null}

      {tab === "policy" && hasOwner ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading policy center" />}>
          <PolicyCenterSection />
        </React.Suspense>
      ) : null}

      {tab === "commissions" && hasOwner ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading commissions" />}>
          <CommissionsSection />
        </React.Suspense>
      ) : null}

      {tab === "marketing" && hasOwner ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading marketing" />}>
          <MarketingSection reportId={gaReportIdParam} campaignId={gaCampaignIdParam} />
        </React.Suspense>
      ) : null}

      {tab === "seo" && hasOwner ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading SEO agent" />}>
          <SeoAgentSection />
        </React.Suspense>
      ) : null}

      {tab === "automation" && hasOwner ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading automation" />}>
          <AutomationSection />
        </React.Suspense>
      ) : null}

      {tab === "access" && hasOwner ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading access controls" />}>
          <AccessSection />
        </React.Suspense>
      ) : null}

      {tab === "sales-log" && hasOwner ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading sales activity" />}>
          <SalesActivityLogSection memberId={memberIdParam} />
        </React.Suspense>
      ) : null}

      {tab === "audit" && hasOwner ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading audit log" />}>
          <AuditLogSection />
        </React.Suspense>
      ) : null}

      {tab === "merge" && hasOwner ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading merge queue" />}>
          <MergeQueueSection />
        </React.Suspense>
      ) : null}

      {tab === "settings" ? (
        <section className={`space-y-4 ${TEAM_CARD_PADDED}`}>
          <div className="space-y-4">
            <h2 className={TEAM_SECTION_TITLE}>Account</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Signed-in team members control attribution for calls, messages, and audit logs. Owner sessions still have full access.
            </p>
            {settingsSetup ? (
              <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800 shadow-sm shadow-sky-100">
                Set a password to enable password sign-in. Magic links will still work.
              </div>
            ) : null}
            {settingsSaved ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 shadow-sm shadow-emerald-100">
                Saved.
              </div>
            ) : null}
            {settingsError ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 shadow-sm shadow-rose-100">
                {settingsError}
              </div>
            ) : null}

            {teamMember ? (
              <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 text-sm text-slate-700 shadow-sm shadow-slate-200/40">
                <div className="font-semibold text-slate-900">{teamMember.name}</div>
                <div className="mt-1 text-xs text-slate-500">
                  Role: <span className="font-medium text-slate-700">{teamMember.roleSlug ?? "office"}</span>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-3">
              <form action={teamLogoutAction}>
                <button className="rounded-full border border-slate-200 px-4 py-2 text-xs font-medium text-slate-600 hover:border-slate-300 hover:text-slate-800">
                  Log out
                </button>
              </form>
            </div>

            {teamMember && !teamMember.passwordSet ? (
              <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
                <h3 className="text-sm font-semibold text-slate-900">Set password</h3>
                <p className="mt-1 text-xs text-slate-500">Optional. Minimum 10 characters.</p>
                <form action={teamSetPasswordAction} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    name="password"
                    type="password"
                    minLength={10}
                    required
                    className="w-full flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    placeholder="New password"
                  />
                  <button type="submit" className="rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-primary-700">
                    Save
                  </button>
                </form>
              </div>
            ) : null}

            <h2 className={TEAM_SECTION_TITLE}>Calling</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Outbound calls always ring the <span className="font-semibold">Assigned to</span> salesperson on the contact (lead routing). Set each salesperson&apos;s phone in{" "}
              <span className="font-semibold">Access</span> so the system knows who to ring.
            </p>
          </div>

          <div className="space-y-4">
            <details className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
              <summary className="cursor-pointer text-sm font-semibold text-slate-900">Emergency sessions</summary>
              <p className="mt-2 text-xs text-slate-500">
                These controls clear the legacy crew/owner cookies used before per-user login. Most teams won&apos;t need this.
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
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
            </details>
          </div>

          {hasOwner ? (
            <div className="space-y-4">
              <h2 className="text-base font-semibold text-slate-900">Exports</h2>
              <p className="text-xs text-slate-500">
                Download all inbound/outbound client messages as a JSONL file for analysis or fine tuning (drafts + media omitted).
              </p>
              <div>
                <a
                  className="inline-flex items-center justify-center rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-primary-700"
                  href="/api/team/inbox/export"
                >
                  Download conversations (JSONL)
                </a>
              </div>
            </div>
          ) : null}

          {hasOwner && calendarBadge ? (
            <div className={`rounded-xl border px-4 py-3 text-xs ${calendarBadgeToneClasses[calendarBadge.tone]}`} title={calendarBadge.detail ?? undefined}>
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-current/70">Calendar Sync</span>
              <span className="mt-1 block text-sm font-medium text-current">{calendarBadge.headline}</span>
              {calendarBadge.detail ? <span className="block text-[11px] text-current/80">{calendarBadge.detail}</span> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === "myday" && (hasCrew || hasOffice || hasOwner) ? (
        <React.Suspense fallback={<TeamSkeletonCard title="Loading My Day" />}>
          <MyDaySection />
        </React.Suspense>
      ) : null}
    </>
  );

  if (useClassicLayout) {
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
                {teamMember ? (
                  <p className="mt-3 text-sm text-slate-700">
                    Signed in as <span className="font-semibold text-slate-900">{teamMember.name}</span>
                    {teamMember.email ? <span className="text-slate-500"> ({teamMember.email})</span> : null}
                  </p>
                ) : null}
              </div>
              <div className="grid gap-2 text-sm text-slate-600 sm:justify-items-end sm:text-right">
                <span
                  className={`inline-flex w-full items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium sm:w-auto ${
                    hasCrew || hasOwner ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  Crew {hasCrew || hasOwner ? "access" : "restricted"}
                </span>
                <span
                  className={`inline-flex w-full items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium sm:w-auto ${
                    hasOffice || hasOwner ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  Office {hasOffice || hasOwner ? "access" : "restricted"}
                </span>
                <span
                  className={`inline-flex w-full items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium sm:w-auto ${
                    hasOwner ? "bg-primary-100 text-primary-700" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  Owner {hasOwner ? "access" : "restricted"}
                </span>
              </div>
            </div>
            <div className="mt-6">
              <TabNav
                items={resolvedTabs}
                groups={tabGroups}
                activeId={tab}
                hasOwner={hasOwner}
                hasCrew={hasCrew}
                hasOffice={hasOffice}
                permissions={effectivePermissions}
              />
            </div>
          </header>
          {content}
        </main>
      </div>
    );
  }

  const allowedTabs = resolvedTabs.filter((item) => isAllowed(item.requires));
  const tabMap = new Map(allowedTabs.map((item) => [item.id, item]));
  const quickIds = ["inbox", "contacts", "calendar", "sales-hq"];
  const quickIdSet = new Set(quickIds);
  const groups: TeamNavGroup[] = tabGroups
    .filter((group) => group.id !== "account")
    .map((group) => ({
      id: group.id,
      label: group.label,
      items: group.itemIds
        .filter((id) => !quickIdSet.has(id))
        .map((id) => tabMap.get(id))
        .filter((item): item is TabNavItem => Boolean(item))
        .map((item) => ({
          id: item.id,
          label: item.label,
          href: item.href
        }))
    }))
    .filter((group) => group.items.length > 0);

  const quickItems: ShellNavItem[] = quickIds
    .map((id) => tabMap.get(id))
    .filter((item): item is TabNavItem => Boolean(item))
    .map((item) => ({ id: item.id, label: item.label, href: item.href }));

  const classicHref = withLayout(`/team?tab=${encodeURIComponent(tab)}`);

  return (
    <TeamAppShell
      activeId={tab}
      title={activeTab?.label ?? "Team Console"}
      quickItems={quickItems}
      groups={groups}
      access={{ hasCrew, hasOffice, hasOwner }}
      user={teamMember ? { name: teamMember.name, email: teamMember.email } : null}
      classicHref={classicHref}
    >
      {content}
    </TeamAppShell>
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

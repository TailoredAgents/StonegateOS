import { randomUUID } from "node:crypto";
import React from "react";
import type { Route } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TabNav, type TabNavGroup, type TabNavItem } from "./components/TabNav";
import {
  TeamAppShell,
  type TeamNavGroup,
  type TeamNavItem as ShellNavItem,
} from "./components/TeamAppShell";
import {
  getCompanyShortName,
  getPublicCompanyProfile,
} from "../../lib/company";
import { callAdminApiAs } from "./lib/api";
import { FlashClearer } from "./components/FlashClearer";
import { TeamSkeletonCard } from "./components/TeamSkeleton";
import {
  resolveTeamPrincipalFromCookies,
  teamPermissionMatches,
  toTeamMemberIdentity,
} from "@/lib/team-principal";
import {
  isTeamSurfaceId,
  resolveDefaultTeamSurfaceId,
  teamSurfaceHref,
  TEAM_SURFACE_GROUP_LABELS,
  TEAM_SURFACE_GROUP_ORDER,
  TEAM_SURFACE_BY_ID,
  TEAM_SURFACES,
} from "./surface-registry";
import {
  TeamSurfaceWorkspace,
  TEAM_SURFACE_LOADING_TITLES,
  type TeamSurfaceLoaderContext,
} from "./surface-loaders";
import {
  parsePersonalSessionInventory,
  type PersonalSessionInventory,
} from "./settings-sessions";
import {
  parseInboxNewLeadFeed,
  type InboxNewLeadFeed,
} from "./inbox-new-leads";
import { InboxNewLeadNotice } from "./components/InboxNewLeadNotice";

export const metadata = {
  title: "Stonegate Team Console",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    q?: string;
    inbox_q?: string;
    inbox_queue?: string;
    inbox_status?: string;
    inbox_view?: string;
    inbox_first_from?: string;
    inbox_first_to?: string;
    inbox_last_from?: string;
    inbox_last_to?: string;
    inbox_offset?: string;
    inbox_message_cursor?: string | string[];
    inbox_message_limit?: string | string[];
    offset?: string;
    includeOutbound?: string;
    contactId?: string;
    created?: string;
    threadId?: string;
    status?: string;
    stage?: string;
    channel?: string;
    memberId?: string;
    salesCursor?: string | string[];
    salesLimit?: string | string[];
    salesRangeDays?: string | string[];
    salesActions?: string | string[];
    out_q?: string;
    out_campaign?: string;
    out_attempt?: string;
    out_due?: string;
    out_has?: string;
    out_disposition?: string;
    out_taskId?: string;
    out_account?: string;
    out_cursor?: string;
    out_direction?: string;
    out_return?: string;
    p_status?: string;
    p_owner?: string;
    p_type?: string;
    p_q?: string;
    p_cursor?: string;
    p_selected?: string;
    p_preview?: string;
    p_preview_job?: string;
    quoteMode?: string;
    view?: string;
    subview?: string;
    onlyOutbound?: string;
    outbound?: string;
    gaReportId?: string;
    gaCampaignId?: string;
    waRangeDays?: string;
    cal?: string;
    calView?: string;
    calStatus?: string;
    calCrew?: string;
    calSource?: string;
    calConflict?: string;
    addr?: string;
    city?: string;
    state?: string;
    zip?: string;
    propertyId?: string;
    instantQuoteId?: string;
    action?: string;
    setup?: string;
    saved?: string;
    error?: string;
    layout?: string;
    ownerView?: string;
    mergeSuggestionId?: string;
    mergeRecoveryId?: string;
    mergeSourceId?: string;
    mergeTargetId?: string;
    mergeQ?: string;
    mergeStatus?: string;
    mergeOffset?: string;
    mergeContactQ?: string;
    auditAction?: string;
    auditActorId?: string;
    auditActorType?: string;
    auditEntityType?: string;
    auditEntityId?: string;
    auditOutcome?: string;
    auditCorrelationId?: string;
    auditFrom?: string;
    auditTo?: string;
    auditCursor?: string;
    expenseView?: string;
    expenseFrom?: string;
    expenseTo?: string;
    expenseStatus?: string;
    expenseCategory?: string;
    expenseSource?: string;
    expenseReview?: string;
    expenseQ?: string;
    expenseCursor?: string;
    expenseDirection?: string;
    expensePage?: string;
    _canonical?: string;
  }>;
}) {
  const params = await searchParams;
  const cookieStore = await cookies();
  const principal = await resolveTeamPrincipalFromCookies();
  if (!principal) {
    redirect("/team/login");
  }
  const teamMember = toTeamMemberIdentity(principal);

  const effectivePermissions = teamMember.permissions;

  const hasPermission = (required: string): boolean => {
    return effectivePermissions.some((permission) =>
      teamPermissionMatches(permission, required),
    );
  };
  const hasOwner = hasPermission("*");
  const hasOffice =
    hasPermission("messages.read") || hasPermission("bookings.manage");
  const hasCrew = hasPermission("appointments.read");

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
  if (
    params?.setup === "1" &&
    !requestedTab &&
    params?._canonical !== "1" &&
    params?.layout !== "classic"
  ) {
    const canonicalSearch = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (key === "tab" || key === "_canonical") continue;
      if (typeof value === "string" && value.length > 0) {
        canonicalSearch.set(key, value);
      }
    }
    redirect(teamSurfaceHref("settings", { query: canonicalSearch }));
  }
  const requestedQuoteMode =
    typeof params?.quoteMode === "string" ? params.quoteMode : undefined;
  let forcedQuoteMode: string | undefined;
  let normalizedRequestedTab = requestedTab;
  if (requestedTab === "quote-builder") {
    normalizedRequestedTab = "quotes";
    forcedQuoteMode = "builder";
  } else if (requestedTab === "canvass") {
    normalizedRequestedTab = "quotes";
    forcedQuoteMode = "canvass";
  } else if (requestedTab === "marketing") {
    normalizedRequestedTab = "google-ads";
  } else if (requestedTab === "myday" || requestedTab === "estimates") {
    normalizedRequestedTab = "calendar";
  }
  const defaultTab =
    resolveDefaultTeamSurfaceId(effectivePermissions) ?? "settings";
  const resolvedRequestedTab = normalizedRequestedTab;
  const tab =
    resolvedRequestedTab && isTeamSurfaceId(resolvedRequestedTab)
      ? resolvedRequestedTab
      : defaultTab;
  if (
    requestedTab &&
    params?._canonical !== "1" &&
    params?.layout !== "classic"
  ) {
    const surface = TEAM_SURFACE_BY_ID.get(tab);
    if (surface) {
      const canonicalSearch = new URLSearchParams();
      for (const [key, value] of Object.entries(params ?? {})) {
        if (key === "tab" || key === "_canonical") continue;
        if (typeof value === "string" && value.length > 0) {
          canonicalSearch.set(key, value);
        }
      }
      if (forcedQuoteMode) canonicalSearch.set("quoteMode", forcedQuoteMode);
      const query = canonicalSearch.toString();
      redirect(`${surface.canonicalPath}${query ? `?${query}` : ""}` as Route);
    }
  }
  if (
    tab === "expenses" &&
    params?._canonical === "1" &&
    params?.layout !== "classic" &&
    !params?.expenseView?.trim()
  ) {
    const canonicalSearch = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (key === "tab" || key === "_canonical" || key === "expenseView") {
        continue;
      }
      if (typeof value === "string" && value.length > 0) {
        canonicalSearch.set(key, value);
      }
    }
    canonicalSearch.set("expenseView", "ledger");
    redirect(`/team/expenses?${canonicalSearch.toString()}` as Route);
  }
  const contactsQuery = typeof params?.q === "string" ? params.q : undefined;
  const contactsView =
    typeof params?.view === "string" ? params.view.trim().toLowerCase() : "";
  const contactsRecovery = contactsView === "recovery";
  const contactsOnlyOutbound =
    !contactsRecovery &&
    (contactsView === "outbound" || params?.onlyOutbound === "1");
  const contactsIncludeOutbound =
    !contactsRecovery &&
    (contactsView === "all" || params?.includeOutbound === "1");
  let contactsOffset: number | undefined;
  if (typeof params?.offset === "string") {
    const parsed = Number(params.offset);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      contactsOffset = parsed;
    }
  }
  const contactIdRaw =
    typeof params?.contactId === "string" ? params.contactId : undefined;
  const createdContactRaw =
    typeof params?.created === "string" ? params.created : undefined;
  const contactIdParam = contactIdRaw ?? createdContactRaw;
  const propertyIdParam =
    typeof params?.propertyId === "string" ? params.propertyId : undefined;
  const instantQuoteIdParam =
    typeof params?.instantQuoteId === "string"
      ? params.instantQuoteId
      : undefined;
  const bookingRequested = params?.action === "book";
  const gaReportIdParam =
    typeof params?.gaReportId === "string" ? params.gaReportId : undefined;
  const gaCampaignIdParam =
    typeof params?.gaCampaignId === "string" ? params.gaCampaignId : undefined;
  const waRangeDaysParam =
    typeof params?.waRangeDays === "string" ? params.waRangeDays : undefined;
  const inboxThreadId =
    typeof params?.threadId === "string" ? params.threadId : undefined;
  const inboxQueue =
    typeof params?.inbox_queue === "string" ? params.inbox_queue : undefined;
  const inboxStatus =
    typeof params?.inbox_status === "string"
      ? params.inbox_status
      : normalizedRequestedTab === "inbox" && typeof params?.status === "string"
        ? params.status
        : undefined;
  const inboxChannel =
    typeof params?.channel === "string" ? params.channel : undefined;
  const inboxQuery =
    typeof params?.inbox_q === "string" ? params.inbox_q : undefined;
  const inboxView =
    typeof params?.inbox_view === "string" ? params.inbox_view : undefined;
  const inboxFirstFrom =
    typeof params?.inbox_first_from === "string"
      ? params.inbox_first_from
      : undefined;
  const inboxFirstTo =
    typeof params?.inbox_first_to === "string"
      ? params.inbox_first_to
      : undefined;
  const inboxLastFrom =
    typeof params?.inbox_last_from === "string"
      ? params.inbox_last_from
      : undefined;
  const inboxLastTo =
    typeof params?.inbox_last_to === "string"
      ? params.inbox_last_to
      : undefined;
  let inboxOffset: string | undefined;
  if (typeof params?.inbox_offset === "string") {
    const parsed = Number(params.inbox_offset);
    if (Number.isInteger(parsed) && parsed >= 0) {
      inboxOffset = String(parsed);
    }
  }
  const inboxMessageCursor =
    typeof params?.inbox_message_cursor === "string" ||
    Array.isArray(params?.inbox_message_cursor)
      ? params.inbox_message_cursor
      : undefined;
  const inboxMessageLimit =
    typeof params?.inbox_message_limit === "string" ||
    Array.isArray(params?.inbox_message_limit)
      ? params.inbox_message_limit
      : undefined;
  const memberIdParam =
    typeof params?.memberId === "string" ? params.memberId : undefined;
  const salesCursorParam =
    typeof params?.salesCursor === "string" ||
    Array.isArray(params?.salesCursor)
      ? params.salesCursor
      : undefined;
  const salesLimitParam =
    typeof params?.salesLimit === "string" || Array.isArray(params?.salesLimit)
      ? params.salesLimit
      : undefined;
  const salesRangeDaysParam =
    typeof params?.salesRangeDays === "string" ||
    Array.isArray(params?.salesRangeDays)
      ? params.salesRangeDays
      : undefined;
  const salesActionsParam =
    typeof params?.salesActions === "string" ||
    Array.isArray(params?.salesActions)
      ? params.salesActions
      : undefined;
  const quoteModeParam = forcedQuoteMode ?? requestedQuoteMode;
  const settingsSetup = params?.setup === "1";
  const settingsSaved = params?.saved === "1";
  const settingsError =
    typeof params?.error === "string" && params.error.trim().length
      ? params.error.trim()
      : null;
  const layoutMode =
    typeof params?.layout === "string"
      ? params.layout.trim().toLowerCase()
      : "";
  const useClassicLayout = layoutMode === "classic";
  const outboundFilters = {
    q: typeof params?.out_q === "string" ? params.out_q : undefined,
    campaign:
      typeof params?.out_campaign === "string"
        ? params.out_campaign
        : undefined,
    attempt:
      typeof params?.out_attempt === "string" ? params.out_attempt : undefined,
    due: typeof params?.out_due === "string" ? params.out_due : undefined,
    has: typeof params?.out_has === "string" ? params.out_has : undefined,
    disposition:
      typeof params?.out_disposition === "string"
        ? params.out_disposition
        : undefined,
    taskId:
      typeof params?.out_taskId === "string" ? params.out_taskId : undefined,
    accountId:
      typeof params?.out_account === "string" ? params.out_account : undefined,
    cursor:
      typeof params?.out_cursor === "string" ? params.out_cursor : undefined,
    direction:
      typeof params?.out_direction === "string"
        ? params.out_direction
        : undefined,
  };

  const partnerFilters = {
    status: typeof params?.p_status === "string" ? params.p_status : undefined,
    ownerId: typeof params?.p_owner === "string" ? params.p_owner : undefined,
    type: typeof params?.p_type === "string" ? params.p_type : undefined,
    q: typeof params?.p_q === "string" ? params.p_q : undefined,
    cursor: typeof params?.p_cursor === "string" ? params.p_cursor : undefined,
    selectedId:
      typeof params?.p_selected === "string" ? params.p_selected : undefined,
    preview:
      typeof params?.p_preview === "string" ? params.p_preview : undefined,
    previewJobId:
      typeof params?.p_preview_job === "string"
        ? params.p_preview_job
        : undefined,
    outboundReturn:
      typeof params?.out_return === "string" ? params.out_return : undefined,
  };

  const flash = cookieStore.get("myst-flash")?.value ?? null;
  const flashError = cookieStore.get("myst-flash-error")?.value ?? null;

  let systemHealth: SystemHealthApiResponse | null = null;
  if (tab === "policy" && hasPermission("policy.read")) {
    try {
      const response = await callAdminApiAs(
        principal,
        "/api/admin/system/health",
        {
          timeoutMs: 8_000,
        },
      );
      if (response.ok) {
        const payload = (await response
          .json()
          .catch(() => null)) as SystemHealthApiResponse | null;
        if (payload && payload.ok) systemHealth = payload;
      }
    } catch {
      systemHealth = null;
    }
  }

  const withLayout = (href: string): string => {
    if (!useClassicLayout) return href;
    return href.includes("?")
      ? `${href}&layout=classic`
      : `${href}?layout=classic`;
  };
  const tabs: TabNavItem[] = TEAM_SURFACES.map((surface) => ({
    id: surface.id,
    label: surface.label,
    href: surface.canonicalPath,
    ...(surface.requiredPermissions.length > 0
      ? { requires: [...surface.requiredPermissions] }
      : {}),
  }));
  const resolvedTabs: TabNavItem[] = useClassicLayout
    ? tabs.map((item) => ({ ...item, href: withLayout(item.href) }))
    : tabs;
  const dailyGroups: TabNavGroup[] = TEAM_SURFACES.filter(
    (surface) => surface.group === "daily",
  ).map((surface) => ({
    id: surface.id,
    label: surface.label,
    itemIds: [surface.id],
    variant: "single",
  }));
  const groupedWorkspaces: TabNavGroup[] = TEAM_SURFACE_GROUP_ORDER.filter(
    (group) => group !== "daily",
  )
    .map((group) => {
      const itemIds = TEAM_SURFACES.filter(
        (surface) => surface.group === group,
      ).map((surface) => surface.id);
      return {
        id: group,
        label: TEAM_SURFACE_GROUP_LABELS[group],
        itemIds,
        variant: itemIds.length === 1 ? "single" : "dropdown",
      } satisfies TabNavGroup;
    })
    .filter((group) => group.itemIds.length > 0);
  const tabGroups: TabNavGroup[] = [...dailyGroups, ...groupedWorkspaces];

  const activeTab =
    resolvedTabs.find((item) => item.id === tab) ?? resolvedTabs[0] ?? null;
  if (activeTab && !isAllowed(activeTab.requires)) {
    const fallback = hasCrew && !hasOffice && !hasOwner ? "calendar" : "inbox";
    const fallbackTab =
      resolvedTabs.find(
        (candidate) =>
          candidate.id === fallback && isAllowed(candidate.requires),
      ) ?? resolvedTabs.find((candidate) => isAllowed(candidate.requires));
    redirect((fallbackTab ? fallbackTab.href : "/team/login") as Route);
  }

  let calendarBadge: CalendarSyncBadge | null = null;
  if (tab === "settings" && hasOwner) {
    try {
      const response = await callAdminApiAs(principal, "/api/calendar/status");
      if (response.ok) {
        const payload = (await response.json()) as CalendarStatusApiResponse;
        calendarBadge = evaluateCalendarBadge(payload);
      } else {
        calendarBadge = {
          tone: "alert",
          headline: "Status request failed",
          detail: `HTTP ${response.status}`,
        };
      }
    } catch {
      calendarBadge = {
        tone: "alert",
        headline: "Status request failed",
        detail: "API unreachable",
      };
    }
  }

  let personalSessions: PersonalSessionInventory | null = null;
  let personalSessionsError: string | null = null;
  if (tab === "settings") {
    if (!hasPermission("sessions.manage_self")) {
      personalSessionsError =
        "Session management is not available under your current access policy.";
    } else {
      try {
        const response = await callAdminApiAs(
          principal,
          "/api/admin/team/sessions/self",
          { timeoutMs: 8_000 },
        );
        if (!response.ok) {
          personalSessionsError = `Session inventory is unavailable (HTTP ${response.status}).`;
        } else {
          personalSessions = parsePersonalSessionInventory(
            await response.json().catch(() => null),
          );
          if (!personalSessions) {
            personalSessionsError =
              "Session inventory returned an invalid response. No sessions were changed.";
          }
        }
      } catch {
        personalSessionsError =
          "Session inventory is temporarily unavailable. No sessions were changed.";
      }
    }
  }

  let newLeadFeed: InboxNewLeadFeed | null = null;
  let newLeadFeedError: string | null = null;
  if (tab === "inbox" && hasPermission("messages.read")) {
    try {
      const response = await callAdminApiAs(
        principal,
        "/api/admin/inbox/new-leads/next",
        { timeoutMs: 8_000 },
      );
      if (!response.ok) {
        newLeadFeedError =
          response.status === 403
            ? "Your current access does not allow this new-lead queue. No empty queue is being assumed."
            : `The new-lead queue could not be verified (HTTP ${response.status}). No empty queue is being assumed.`;
      } else {
        newLeadFeed = parseInboxNewLeadFeed(
          await response.json().catch(() => null),
        );
        if (!newLeadFeed) {
          newLeadFeedError =
            "The new-lead service returned an incomplete response. No empty queue is being assumed.";
        }
      }
    } catch {
      newLeadFeedError =
        "The new-lead service is temporarily unreachable. Refresh before relying on this queue.";
    }
  }
  const newLeadAcknowledgementKey = newLeadFeed?.next ? randomUUID() : null;

  const surfaceContext: TeamSurfaceLoaderContext = {
    calendarSearchParams: params,
    inbox: {
      queue: inboxQueue,
      threadId: inboxThreadId,
      status: inboxStatus,
      contactId: contactIdParam,
      channel: inboxChannel,
      q: inboxQuery,
      view: inboxView,
      firstMessageFrom: inboxFirstFrom,
      firstMessageTo: inboxFirstTo,
      lastMessageFrom: inboxLastFrom,
      lastMessageTo: inboxLastTo,
      offset: inboxOffset,
      messageCursor: inboxMessageCursor,
      messageLimit: inboxMessageLimit,
    },
    quotes: {
      quoteMode: quoteModeParam,
      contactId: contactIdParam,
      propertyId: propertyIdParam,
      instantQuoteId: instantQuoteIdParam,
      memberId: memberIdParam,
    },
    expenses: {
      view: params.expenseView,
      filters: {
        from: params.expenseFrom,
        to: params.expenseTo,
        status: params.expenseStatus,
        category: params.expenseCategory,
        source: params.expenseSource,
        financeReview: params.expenseReview,
        q: params.expenseQ,
        cursor: params.expenseCursor,
        direction: params.expenseDirection,
        page: params.expensePage,
      },
    },
    pipeline: {
      contactId: contactIdParam,
      q: params.q,
      stage: params.stage,
      offset: params.offset,
      view: params.view,
      outbound: params.outbound,
    },
    outbound: {
      memberId: memberIdParam,
      view: params.view,
      filters: outboundFilters,
    },
    partners: { filters: partnerFilters },
    contacts: {
      search: contactsQuery,
      offset: contactsOffset,
      contactId: contactIdParam,
      subview: params.subview,
      propertyId: propertyIdParam,
      instantQuoteId: instantQuoteIdParam,
      bookingRequested,
      excludeOutbound: contactsOnlyOutbound ? false : !contactsIncludeOutbound,
      onlyOutbound: contactsOnlyOutbound,
      deletedOnly: contactsRecovery,
    },
    owner: { ownerView: params.ownerView },
    policy: { systemHealth },
    marketing: {
      reportId: gaReportIdParam,
      campaignId: gaCampaignIdParam,
    },
    websiteAnalytics: {
      rangeDays: waRangeDaysParam,
      gaReportId: gaReportIdParam,
      gaCampaignId: gaCampaignIdParam,
    },
    salesActivity: {
      memberId: memberIdParam,
      cursor: salesCursorParam,
      limit: salesLimitParam,
      rangeDays: salesRangeDaysParam,
      actions: salesActionsParam,
    },
    merge: {
      selectedSuggestionId: params.mergeSuggestionId,
      selectedRecoveryId: params.mergeRecoveryId,
      manualSourceId: params.mergeSourceId,
      manualTargetId: params.mergeTargetId,
      q: params.mergeQ,
      status: params.mergeStatus,
      offset: params.mergeOffset,
      contactQ: params.mergeContactQ,
    },
    audit: {
      filters: {
        action: params.auditAction,
        actorId: params.auditActorId,
        actorType: params.auditActorType,
        entityType: params.auditEntityType,
        entityId: params.auditEntityId,
        outcome: params.auditOutcome,
        correlationId: params.auditCorrelationId,
        from: params.auditFrom,
        to: params.auditTo,
        cursor: params.auditCursor,
      },
    },
    settings: {
      teamMember,
      hasOwner,
      canExportMessages: hasPermission("messages.export"),
      authMethod: principal.authMethod,
      setup: settingsSetup,
      saved: settingsSaved,
      error: settingsError,
      calendarBadge,
      personalSessions,
      personalSessionsError,
    },
  };

  const content = (
    <>
      {flash ? (
        <div
          role="status"
          aria-live="polite"
          data-team-flash="success"
          className="rounded-2xl border border-emerald-200/70 bg-emerald-50/80 p-4 text-sm text-emerald-700 shadow-sm shadow-emerald-100"
        >
          {flash}
        </div>
      ) : null}
      {flashError ? (
        <div
          role="alert"
          data-team-flash="error"
          className="rounded-2xl border border-rose-200/70 bg-rose-50/80 p-4 text-sm text-rose-700 shadow-sm shadow-rose-100"
        >
          {flashError}
        </div>
      ) : null}
      {flash || flashError ? <FlashClearer /> : null}
      {tab === "inbox" ? (
        <InboxNewLeadNotice
          feed={newLeadFeed}
          error={newLeadFeedError}
          acknowledgementKey={newLeadAcknowledgementKey}
        />
      ) : null}

      <React.Suspense
        fallback={<TeamSkeletonCard title={TEAM_SURFACE_LOADING_TITLES[tab]} />}
      >
        <TeamSurfaceWorkspace surfaceId={tab} context={surfaceContext} />
      </React.Suspense>
    </>
  );

  if (useClassicLayout) {
    return (
      <div className="relative min-h-screen overflow-visible bg-gradient-to-br from-slate-100 via-white to-slate-50">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.12),_transparent_50%)]" />
        <main className="relative mx-auto max-w-6xl space-y-6 px-4 py-8 sm:space-y-8 sm:px-6 sm:py-10 lg:px-8">
          <section
            className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-sm"
            aria-labelledby="classic-layout-migration-title"
          >
            <h2 id="classic-layout-migration-title" className="font-semibold">
              Classic layout is in compatibility mode
            </h2>
            <p className="mt-1 leading-6">
              Security fixes remain supported here, but new workflow and design
              improvements are delivered in the modern Team CRM.
            </p>
            <a
              href={teamSurfaceHref(tab)}
              className="mt-2 inline-flex min-h-[44px] items-center font-semibold underline underline-offset-4"
            >
              Switch to the modern layout
            </a>
          </section>
          <header className="relative z-50 overflow-visible rounded-3xl border border-white/70 bg-white/80 p-6 shadow-xl shadow-slate-200/60 backdrop-blur sm:p-8">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <span className="inline-flex items-center rounded-full bg-primary-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.25em] text-primary-700">
                  Stonegate Team
                </span>
                <h1 className="mt-4 text-3xl font-semibold text-slate-900 sm:text-4xl">
                  Team Console
                </h1>
                <p className="mt-2 max-w-3xl text-sm text-slate-600 sm:text-base">
                  Monitor appointments, quotes, pipeline health, and contacts
                  from a single polished workspace designed for your crew and
                  office team.
                </p>
                {teamMember ? (
                  <p className="mt-3 text-sm text-slate-700">
                    Signed in as{" "}
                    <span className="font-semibold text-slate-900">
                      {teamMember.name}
                    </span>
                    {teamMember.email ? (
                      <span className="text-slate-500">
                        {" "}
                        ({teamMember.email})
                      </span>
                    ) : null}
                  </p>
                ) : null}
              </div>
              <div className="grid gap-2 text-sm text-slate-600 sm:justify-items-end sm:text-right">
                <span
                  className={`inline-flex w-full items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium sm:w-auto ${
                    hasCrew || hasOwner
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-slate-100 text-slate-500"
                  }`}
                >
                  Crew {hasCrew || hasOwner ? "access" : "restricted"}
                </span>
                <span
                  className={`inline-flex w-full items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium sm:w-auto ${
                    hasOffice || hasOwner
                      ? "bg-sky-100 text-sky-700"
                      : "bg-slate-100 text-slate-500"
                  }`}
                >
                  Office {hasOffice || hasOwner ? "access" : "restricted"}
                </span>
                <span
                  className={`inline-flex w-full items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium sm:w-auto ${
                    hasOwner
                      ? "bg-primary-100 text-primary-700"
                      : "bg-slate-100 text-slate-500"
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
  const quickIds = ["calendar", "inbox", "contacts", "quotes", "expenses"];
  const utilityIds = ["settings"];
  const nestedSurfaceIds = new Set(["partners", "sales-log"]);
  const quickIdSet = new Set(quickIds);
  const utilityIdSet = new Set(utilityIds);
  const groups: TeamNavGroup[] = tabGroups
    .map((group) => ({
      id: group.id,
      label: group.label,
      items: group.itemIds
        .filter(
          (id) =>
            !quickIdSet.has(id) &&
            !utilityIdSet.has(id) &&
            !nestedSurfaceIds.has(id),
        )
        .map((id) => tabMap.get(id))
        .filter((item): item is TabNavItem => Boolean(item))
        .map((item) => ({
          id: item.id,
          label: item.label,
          href: item.href,
        })),
    }))
    .filter((group) => group.items.length > 0);

  const quickItems: ShellNavItem[] = quickIds
    .map((id) => tabMap.get(id))
    .filter((item): item is TabNavItem => Boolean(item))
    .map((item) => ({ id: item.id, label: item.label, href: item.href }));
  const utilityItems: ShellNavItem[] = utilityIds
    .map((id) => tabMap.get(id))
    .filter((item): item is TabNavItem => Boolean(item))
    .map((item) => ({ id: item.id, label: item.label, href: item.href }));

  const classicSearch = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(params ?? {})) {
    if (key === "tab" || key === "_canonical" || key === "layout") continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (typeof value === "string" && value.length > 0) {
        classicSearch.append(key, value);
      }
    }
  }
  classicSearch.set("layout", "classic");
  const classicHref = teamSurfaceHref(tab, { query: classicSearch });
  const companyProfile = getPublicCompanyProfile();
  const brand = {
    shortName: getCompanyShortName(companyProfile),
    logoPath: companyProfile.logoPath,
  };

  return (
    <TeamAppShell
      activeId={
        tab === "partners" ? "outbound" : tab === "sales-log" ? "sales-hq" : tab
      }
      title={activeTab?.label ?? "Team Console"}
      quickItems={quickItems}
      utilityItems={utilityItems}
      groups={groups}
      access={{ hasCrew, hasOffice, hasOwner }}
      user={
        teamMember ? { name: teamMember.name, email: teamMember.email } : null
      }
      brand={brand}
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

function evaluateCalendarBadge(
  payload: CalendarStatusApiResponse,
): CalendarSyncBadge {
  if (!payload.ok) {
    return {
      tone: "alert",
      headline: "Status unavailable",
      detail: payload.error,
    };
  }

  if (!payload.config.calendarId) {
    return {
      tone: "idle",
      headline: "Calendar not configured",
      detail: "Set GOOGLE_CALENDAR_ID",
    };
  }

  if (!payload.config.webhookConfigured) {
    return {
      tone: "warn",
      headline: "Webhook missing",
      detail: "Set GOOGLE_CALENDAR_WEBHOOK_URL",
    };
  }

  const status = payload.status;
  if (!status) {
    return {
      tone: "warn",
      headline: "Awaiting first sync",
      detail: "No sync record yet",
    };
  }

  const lastSyncedAt = status.lastSyncedAt
    ? new Date(status.lastSyncedAt)
    : null;
  const lastNotificationAt = status.lastNotificationAt
    ? new Date(status.lastNotificationAt)
    : null;
  const channelExpiresAt = status.channelExpiresAt
    ? new Date(status.channelExpiresAt)
    : null;
  const now = Date.now();

  const missingChannel = !status.channelId;
  const missingToken = !status.syncTokenPresent;
  const staleSync =
    !lastSyncedAt || now - lastSyncedAt.getTime() > 3 * 60 * 60 * 1000;
  const staleNotification =
    !lastNotificationAt ||
    now - lastNotificationAt.getTime() > 2 * 60 * 60 * 1000;
  const expiringSoon =
    !channelExpiresAt || channelExpiresAt.getTime() - now < 45 * 60 * 1000;

  const detailParts = [
    `Last sync ${formatAgo(lastSyncedAt)}`,
    `Watch renews ${formatFuture(channelExpiresAt)}`,
  ];

  if (lastNotificationAt) {
    detailParts.push(`Last ping ${formatAgo(lastNotificationAt)}`);
  }

  if (missingChannel || missingToken) {
    return {
      tone: "alert",
      headline: missingChannel ? "Watch not registered" : "Sync token missing",
      detail: detailParts.join(" | "),
    };
  }

  if (staleSync) {
    return {
      tone: "warn",
      headline: "Sync lagging",
      detail: detailParts.join(" | "),
    };
  }

  if (staleNotification) {
    return {
      tone: "warn",
      headline: "No recent webhook",
      detail: detailParts.join(" | "),
    };
  }

  if (expiringSoon) {
    return {
      tone: "warn",
      headline: "Watch renews soon",
      detail: detailParts.join(" | "),
    };
  }

  return {
    tone: "ok",
    headline: "Healthy",
    detail: detailParts.join(" | "),
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

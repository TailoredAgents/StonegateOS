import type { ReactElement } from "react";
import type { PersonalSessionInventory } from "./settings-sessions";
import type { TeamMfaSecurityStatus } from "./team-mfa-security";
import type { TeamSurfaceId } from "./surface-registry";

export type TeamSurfaceLoaderContext = {
  calendarSearchParams: {
    addr?: string;
    city?: string;
    state?: string;
    zip?: string;
    calView?: string;
    cal?: string;
    contactId?: string;
    propertyId?: string;
  };
  inbox: {
    queue?: string;
    threadId?: string;
    status?: string;
    contactId?: string;
    channel?: string;
    q?: string;
    view?: string;
    firstMessageFrom?: string;
    firstMessageTo?: string;
    lastMessageFrom?: string;
    lastMessageTo?: string;
    offset?: string;
    messageCursor?: string | readonly string[];
    messageLimit?: string | readonly string[];
  };
  quotes: {
    quoteMode?: string | null;
    contactId?: string;
    propertyId?: string;
    instantQuoteId?: string;
    partnerAccountId?: string;
    partnerTargetType?: string;
    partnerTargetId?: string;
    memberId?: string;
  };
  expenses: {
    view?: string;
    filters: {
      from?: string;
      to?: string;
      status?: string;
      category?: string;
      source?: string;
      financeReview?: string;
      q?: string;
      cursor?: string;
      direction?: string;
      page?: string;
    };
  };
  pipeline: {
    contactId?: string;
    q?: string;
    stage?: string;
    offset?: string;
    view?: string;
    outbound?: string;
  };
  outbound: {
    memberId?: string;
    view?: string;
    filters: {
      q?: string;
      campaign?: string;
      attempt?: string;
      due?: string;
      has?: string;
      disposition?: string;
      taskId?: string;
      accountId?: string;
      offset?: string;
    };
  };
  partners: {
    filters: {
      adminView?: string;
      adminCursor?: string;
      adminQuery?: string;
      adminStatus?: string;
      status?: string;
      ownerId?: string;
      type?: string;
      q?: string;
      cursor?: string;
      selectedId?: string;
      preview?: string;
      previewJobId?: string;
      outboundReturn?: string;
    };
  };
  contacts: {
    search?: string;
    offset?: number;
    contactId?: string;
    subview?: string;
    propertyId?: string;
    instantQuoteId?: string;
    bookingRequested: boolean;
    excludeOutbound: boolean;
    onlyOutbound: boolean;
    deletedOnly: boolean;
  };
  owner: { ownerView?: string };
  policy: {
    systemHealth: {
      ok?: boolean;
      generatedAt?: string;
      blockers: Array<{
        id: string;
        severity: "blocker" | "warning";
        title: string;
        detail: string;
        fix: string[];
      }>;
      warnings: Array<{
        id: string;
        severity: "blocker" | "warning";
        title: string;
        detail: string;
        fix: string[];
      }>;
    } | null;
  };
  marketing: { reportId?: string; campaignId?: string };
  websiteAnalytics: {
    rangeDays?: string;
    gaReportId?: string;
    gaCampaignId?: string;
  };
  salesActivity: {
    memberId?: string;
    cursor?: string | string[];
    limit?: string | string[];
    rangeDays?: string | string[];
    actions?: string | string[];
  };
  merge: {
    selectedSuggestionId?: string;
    selectedRecoveryId?: string;
    manualSourceId?: string;
    manualTargetId?: string;
    q?: string;
    status?: string;
    offset?: string;
    contactQ?: string;
  };
  audit: {
    filters: {
      action?: string;
      actorId?: string;
      actorType?: string;
      entityType?: string;
      entityId?: string;
      outcome?: string;
      correlationId?: string;
      from?: string;
      to?: string;
      cursor?: string;
    };
  };
  settings: {
    teamMember: {
      name: string;
      email: string | null;
      roleSlug: string | null;
      passwordSet: boolean;
    } | null;
    hasOwner: boolean;
    canExportMessages: boolean;
    authMethod: "team_session" | "break_glass";
    setup: boolean;
    saved: boolean;
    error: string | null;
    calendarBadge: {
      tone: "ok" | "warn" | "alert" | "idle";
      headline: string;
      detail?: string;
    } | null;
    personalSessions: PersonalSessionInventory | null;
    personalSessionsError: string | null;
    mfaSecurity: TeamMfaSecurityStatus | null;
    mfaSecurityError: string | null;
  };
};

type TeamSurfaceLoader = (
  context: TeamSurfaceLoaderContext,
) => Promise<ReactElement>;

export const TEAM_SURFACE_LOADERS = {
  calendar: async (context) => {
    const { CalendarSection } = await import("./components/CalendarSection");
    return <CalendarSection searchParams={context.calendarSearchParams} />;
  },
  inbox: async (context) => {
    const { InboxSection } = await import("./components/InboxSection");
    return <InboxSection {...context.inbox} />;
  },
  contacts: async (context) => {
    const { ContactsSection } = await import("./components/ContactsSection");
    return <ContactsSection {...context.contacts} />;
  },
  quotes: async (context) => {
    const { QuotesHubSection } = await import("./components/QuotesHubSection");
    return <QuotesHubSection {...context.quotes} />;
  },
  expenses: async (context) => {
    const { ExpensesSection } = await import("./components/ExpensesSection");
    return <ExpensesSection {...context.expenses} />;
  },
  pipeline: async (context) => {
    const { PipelineSection } = await import("./components/PipelineSection");
    return <PipelineSection {...context.pipeline} />;
  },
  "sales-hq": async () => {
    const { SalesScorecardSection } = await import(
      "./components/SalesScorecardSection"
    );
    return <SalesScorecardSection />;
  },
  outbound: async (context) => {
    const { OutboundSection } = await import("./components/OutboundSection");
    return <OutboundSection {...context.outbound} />;
  },
  partners: async (context) => {
    const { PartnerAdministrationSection } = await import(
      "./components/PartnerAdministrationSection"
    );
    return <PartnerAdministrationSection {...context.partners} />;
  },
  "sales-log": async (context) => {
    const { SalesActivityLogSection } = await import(
      "./components/SalesActivityLogSection"
    );
    return <SalesActivityLogSection {...context.salesActivity} />;
  },
  "google-ads": async (context) => {
    const { MarketingSection } = await import("./components/MarketingSection");
    return <MarketingSection {...context.marketing} />;
  },
  "web-analytics": async (context) => {
    const { WebAnalyticsSection } = await import(
      "./components/WebAnalyticsSection"
    );
    return <WebAnalyticsSection {...context.websiteAnalytics} />;
  },
  seo: async () => {
    const { SeoAgentSection } = await import("./components/SeoAgentSection");
    return <SeoAgentSection />;
  },
  owner: async (context) => {
    const { OwnerSection } = await import("./components/OwnerSection");
    return <OwnerSection {...context.owner} />;
  },
  policy: async (context) => {
    const { PolicyCenterSection } = await import(
      "./components/PolicyCenterSection"
    );
    return <PolicyCenterSection {...context.policy} />;
  },
  automation: async () => {
    const { AutomationSection } = await import(
      "./components/AutomationSection"
    );
    return <AutomationSection />;
  },
  commissions: async () => {
    const { CommissionsSection } = await import(
      "./components/CommissionsSection"
    );
    return <CommissionsSection />;
  },
  access: async () => {
    const { AccessSection } = await import("./components/AccessSection");
    return <AccessSection />;
  },
  audit: async (context) => {
    const { AuditLogSection } = await import("./components/AuditLogSection");
    return <AuditLogSection {...context.audit} />;
  },
  merge: async (context) => {
    const { MergeQueueSection } = await import(
      "./components/MergeQueueSection"
    );
    return <MergeQueueSection {...context.merge} />;
  },
  chat: async () => {
    const { ChatSection } = await import("./components/ChatSection");
    return <ChatSection />;
  },
  "simulated-chat": async () => {
    const { SimulatedChatSection } = await import(
      "./components/SimulatedChatSection"
    );
    return <SimulatedChatSection />;
  },
  settings: async (context) => {
    const { SettingsSurface } = await import("./settings-surface");
    return <SettingsSurface {...context.settings} />;
  },
} satisfies Record<TeamSurfaceId, TeamSurfaceLoader>;

export const TEAM_SURFACE_LOADING_TITLES = {
  calendar: "Loading calendar",
  inbox: "Loading inbox",
  contacts: "Loading contacts",
  quotes: "Loading Quotes",
  expenses: "Loading expenses",
  pipeline: "Loading pipeline",
  "sales-hq": "Loading Sales HQ",
  outbound: "Loading outbound prospects",
  partners: "Loading partners",
  "sales-log": "Loading sales activity",
  "google-ads": "Loading Google Ads",
  "web-analytics": "Loading website analytics",
  seo: "Loading SEO agent",
  owner: "Loading owner tools",
  policy: "Loading policy center",
  automation: "Loading automation",
  commissions: "Loading commissions",
  access: "Loading access controls",
  audit: "Loading audit log",
  merge: "Loading merge queue",
  chat: "Loading chat",
  "simulated-chat": "Loading simulated chat",
  settings: "Loading settings",
} satisfies Record<TeamSurfaceId, string>;

export async function TeamSurfaceWorkspace({
  surfaceId,
  context,
}: {
  surfaceId: TeamSurfaceId;
  context: TeamSurfaceLoaderContext;
}): Promise<ReactElement> {
  return TEAM_SURFACE_LOADERS[surfaceId](context);
}

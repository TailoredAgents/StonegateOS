import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  legacyTeamSurfaceHref,
  resolveDefaultTeamSurfaceId,
  teamSurfaceHref,
  TEAM_SURFACE_BY_ID,
  TEAM_SURFACE_GROUP_LABELS,
  TEAM_SURFACES,
} from "../../../site/src/app/team/surface-registry";

const TEAM_APP = join(process.cwd(), "../site/src/app/team");

const EXPECTED_SURFACE_MODULES: Readonly<Record<string, string>> = {
  calendar: "./components/CalendarSection",
  inbox: "./components/InboxSection",
  contacts: "./components/ContactsSection",
  quotes: "./components/QuotesHubSection",
  expenses: "./components/ExpensesSection",
  pipeline: "./components/PipelineSection",
  "sales-hq": "./components/SalesScorecardSection",
  outbound: "./components/OutboundSection",
  partners: "./components/PartnersSection",
  "sales-log": "./components/SalesActivityLogSection",
  "google-ads": "./components/MarketingSection",
  "web-analytics": "./components/WebAnalyticsSection",
  seo: "./components/SeoAgentSection",
  owner: "./components/OwnerSection",
  policy: "./components/PolicyCenterSection",
  automation: "./components/AutomationSection",
  commissions: "./components/CommissionsSection",
  access: "./components/AccessSection",
  audit: "./components/AuditLogSection",
  merge: "./components/MergeQueueSection",
  chat: "./components/ChatSection",
  "simulated-chat": "./components/SimulatedChatSection",
  settings: "./settings-surface",
};

function read(relativePath: string): string {
  return readFileSync(join(TEAM_APP, relativePath), "utf8");
}

function findTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findTsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("Site Team surface registry", () => {
  it("defines every current surface exactly once with a canonical /team path", () => {
    expect(TEAM_SURFACES).toHaveLength(23);
    expect(new Set(TEAM_SURFACES.map((surface) => surface.id)).size).toBe(23);
    expect(
      new Set(TEAM_SURFACES.map((surface) => surface.canonicalPath)).size,
    ).toBe(23);

    for (const surface of TEAM_SURFACES) {
      expect(surface.canonicalPath).toMatch(/^\/team\/(?!login(?:\/|$))/u);
      expect(surface.label.trim()).not.toBe("");
      expect(surface.legacyTabs.length).toBeGreaterThan(0);
      expect(surface.subviews.length).toBeGreaterThan(0);
    }
  });

  it("resolves canonical paths through the authenticated Team page", () => {
    const canonicalRoute = read("[...workspace]/page.tsx");
    const teamPage = read("page.tsx");

    expect(canonicalRoute).toContain(
      "candidate.canonicalPath === canonicalPath",
    );
    expect(canonicalRoute).toContain("if (!surface) notFound()");
    expect(canonicalRoute).toContain("tab: surface.id");
    expect(canonicalRoute).toContain('_canonical: "1"');
    expect(teamPage).toContain("href: surface.canonicalPath");
    expect(teamPage).toContain('key === "tab" || key === "_canonical"');
    expect(teamPage).toContain("surface.canonicalPath");
    expect(teamPage).toContain("resolveDefaultTeamSurfaceId");
    expect(canonicalRoute).toContain("surface.label");
  });

  it("lands office and sales in Inbox, field crew in Calendar, and read-only safely", () => {
    expect(resolveDefaultTeamSurfaceId(["messages.read"])).toBe("inbox");
    expect(
      resolveDefaultTeamSurfaceId([
        "appointments.read",
        "appointments.update",
        "messages.read",
      ]),
    ).toBe("calendar");
    expect(resolveDefaultTeamSurfaceId(["appointments.read"])).toBe("calendar");
  });

  it("loads exactly one registered workspace without eager section imports", () => {
    const teamPage = read("page.tsx");
    const loaders = read("surface-loaders.tsx");
    const surfaceIds = TEAM_SURFACES.map((surface) => surface.id);
    const loaderMapSource = loaders.slice(
      loaders.indexOf("export const TEAM_SURFACE_LOADERS"),
      loaders.indexOf("export const TEAM_SURFACE_LOADING_TITLES"),
    );
    const loadingTitleSource = loaders.slice(
      loaders.indexOf("export const TEAM_SURFACE_LOADING_TITLES"),
      loaders.indexOf("export async function TeamSurfaceWorkspace"),
    );
    const loaderIds = Array.from(
      loaderMapSource.matchAll(
        /^[ ]{2}(?:"([^"]+)"|([A-Za-z][A-Za-z0-9_-]*)): async/gmu,
      ),
      (match) => match[1] ?? match[2],
    );
    const loadingTitleIds = Array.from(
      loadingTitleSource.matchAll(
        /^[ ]{2}(?:"([^"]+)"|([A-Za-z][A-Za-z0-9_-]*)):/gmu,
      ),
      (match) => match[1] ?? match[2],
    );

    expect(loaderIds).toEqual(surfaceIds);
    expect(loadingTitleIds).toEqual(surfaceIds);
    expect(loaders.match(/await import\(/gu)).toHaveLength(surfaceIds.length);
    expect(loaders).toContain(
      "satisfies Record<TeamSurfaceId, TeamSurfaceLoader>",
    );
    expect(loaders).toContain("TEAM_SURFACE_LOADERS[surfaceId](context)");
    expect(teamPage).toContain(
      "<TeamSurfaceWorkspace surfaceId={tab} context={surfaceContext} />",
    );

    for (const surface of TEAM_SURFACES) {
      const modulePath = EXPECTED_SURFACE_MODULES[surface.id];
      expect(modulePath).toBeDefined();
      expect(loaders).toContain(modulePath);
      expect(teamPage).not.toContain(`from "${modulePath}"`);
    }

    expect(teamPage).toContain("if (useClassicLayout)");
    expect(teamPage).toContain("Classic layout is in compatibility mode");
    expect(teamPage).toContain("Switch to the modern layout");
    expect(teamPage).toContain("href={teamSurfaceHref(tab)}");
    expect(teamPage).toContain("<TeamAppShell");
    expect(teamPage.match(/\{content\}/gu)).toHaveLength(2);
  });

  it("builds encoded canonical links while preserving query and hash context", () => {
    expect(
      teamSurfaceHref("quotes", {
        query: {
          quoteMode: "builder",
          contactId: "contact /?&=é",
          ownerView: null,
          offset: 0,
          preview: false,
          filter: ["open", "needs review"],
        },
        hash: "#quote management",
      }),
    ).toBe(
      "/team/quotes/manage?quoteMode=builder&contactId=contact+%2F%3F%26%3D%C3%A9&offset=0&preview=false&filter=open&filter=needs+review#quote%20management",
    );

    const calendarState = new URLSearchParams();
    calendarState.set("calView", "day");
    calendarState.set("cal", "2026-11-01");
    calendarState.append("crew", "member one");
    calendarState.append("crew", "member/two");
    expect(teamSurfaceHref("calendar", { query: calendarState })).toBe(
      "/team/calendar?calView=day&cal=2026-11-01&crew=member+one&crew=member%2Ftwo",
    );
  });

  it("rejects legacy, internal, and malformed query keys", () => {
    expect(() =>
      teamSurfaceHref("inbox", { query: { tab: "contacts" } }),
    ).toThrow("Unsafe Team query parameter: tab");
    expect(() =>
      teamSurfaceHref("inbox", { query: { _canonical: "1" } }),
    ).toThrow("Unsafe Team query parameter: _canonical");
    expect(() =>
      teamSurfaceHref("inbox", { query: { "contactId&tab": "unsafe" } }),
    ).toThrow("Unsafe Team query parameter: contactId&tab");
  });

  it("keeps inbound aliases while Team TSX links use canonical routes", () => {
    const teamPage = read("page.tsx");
    expect(legacyTeamSurfaceHref("inbox")).toBe("/team?tab=inbox");
    expect(teamPage).toContain('requestedTab === "quote-builder"');
    expect(teamPage).toContain('requestedTab === "canvass"');
    expect(teamPage).toContain('requestedTab === "marketing"');
    expect(teamPage).toContain(
      'requestedTab === "myday" || requestedTab === "estimates"',
    );
    expect(teamPage).toContain('params?._canonical !== "1"');
    expect(teamPage).toContain("redirect(");

    const productionTeamLinkFiles = [
      ...findTsxFiles(TEAM_APP),
      join(TEAM_APP, "actions.ts"),
    ];
    for (const file of productionTeamLinkFiles) {
      expect(readFileSync(file, "utf8")).not.toContain("/team?tab=");
    }
  });

  it("sends optional password setup to the canonical Settings route", () => {
    const authCallback = read("auth/route.ts");
    const loginActions = read("login/actions.ts");

    expect(authCallback).toContain('"/team/settings?setup=1"');
    expect(authCallback).not.toContain('searchParams.set("tab", "settings")');
    expect(loginActions).toContain("/team/settings?saved=1");
    expect(read("page.tsx")).toContain(
      'redirect(teamSurfaceHref("settings", { query: canonicalSearch }))',
    );
  });

  it("nests Sales Activity under Sales HQ and Partners under Outbound", () => {
    const teamPage = read("page.tsx");
    const salesHq = read("components/SalesScorecardSection.tsx");
    const salesActivity = read("components/SalesActivityLogSection.tsx");
    const outbound = read("components/OutboundSection.tsx");
    const partners = read("components/PartnersSection.tsx");

    expect(teamPage).toContain(
      'const nestedSurfaceIds = new Set(["partners", "sales-log"])',
    );
    expect(teamPage).toContain('tab === "partners"');
    expect(teamPage).toContain('? "outbound"');
    expect(teamPage).toContain('tab === "sales-log"');
    expect(teamPage).toContain('? "sales-hq"');

    for (const source of [salesHq, salesActivity]) {
      expect(source).toContain('aria-label="Sales HQ views"');
      expect(source).toContain('teamSurfaceHref("sales-hq")');
      expect(source).toContain('teamSurfaceHref("sales-log")');
    }
    for (const source of [outbound, partners]) {
      expect(source).toContain('aria-label="Outbound views"');
    }
    expect(outbound).toContain("buildOutboundHref");
    expect(outbound).toContain("buildOutboundPartnersHref");
    expect(partners).toContain("outboundSubviewHrefFromReturn");
    expect(partners).toContain('teamSurfaceHref("partners",');
  });

  it("keeps Agent and Simulator discoverable together under Advanced tools", () => {
    const teamPage = read("page.tsx");
    expect(teamPage).toContain('const utilityIds = ["settings"]');
    expect(teamPage).toContain("!utilityIdSet.has(id)");
    expect(teamPage).not.toContain('group.id !== "tools"');
    expect(TEAM_SURFACE_BY_ID.get("chat")?.group).toBe("tools");
    expect(TEAM_SURFACE_BY_ID.get("simulated-chat")?.group).toBe("tools");
    expect(TEAM_SURFACE_GROUP_LABELS.tools).toBe("Advanced tools");
  });
});

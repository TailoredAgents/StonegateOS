import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTACT_SUBVIEWS,
  contactWorkspaceHref,
  normalizeContactSubview,
} from "../../../site/src/app/team/contacts-workspace";
import {
  classifyContactResourceResponse,
  contactResourceFailureMessage,
} from "../../../site/src/app/team/contact-resource-state";

const ROOT = join(process.cwd(), "../..");

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("Contacts selected-contact subviews", () => {
  it("normalizes every canonical subview and fails malformed values to Overview", () => {
    expect(CONTACT_SUBVIEWS).toEqual([
      "overview",
      "properties",
      "activity",
      "jobs-quotes",
      "communications",
      "intelligence",
    ]);
    for (const subview of CONTACT_SUBVIEWS) {
      expect(normalizeContactSubview(` ${subview.toUpperCase()} `)).toBe(
        subview,
      );
    }
    expect(normalizeContactSubview("not-a-view")).toBe("overview");
    expect(
      normalizeContactSubview("intelligence", { bookingRequested: true }),
    ).toBe("jobs-quotes");
  });

  it("builds a canonical, copyable detail URL without losing list context", () => {
    const href = contactWorkspaceHref({
      contactId: "contact/one",
      subview: "intelligence",
      search: " Ada + Co ",
      offset: 50,
      view: "all",
      propertyId: "property one",
      instantQuoteId: "quote&one",
      action: "book",
    });
    const url = new URL(String(href), "https://crm.example.test");

    expect(url.pathname).toBe("/team/contacts");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      contactId: "contact/one",
      subview: "intelligence",
      q: "Ada + Co",
      offset: "50",
      view: "all",
      propertyId: "property one",
      instantQuoteId: "quote&one",
      action: "book",
    });
    expect(url.searchParams.has("tab")).toBe(false);
  });

  it.each([
    [403, true, true, "forbidden"],
    [404, true, true, "not-found"],
    [503, true, true, "server-error"],
    [200, false, undefined, "malformed"],
    [200, true, false, "malformed"],
    [429, true, false, "unavailable"],
    [200, true, true, null],
  ] as const)(
    "classifies HTTP %s without converting it to empty data",
    (status, parsed, okFlag, expected) => {
      expect(classifyContactResourceResponse({ status, parsed, okFlag })).toBe(
        expected,
      );
    },
  );

  it("uses distinct, actionable copy for every non-empty failure", () => {
    expect(contactResourceFailureMessage("agent memory", "forbidden")).toMatch(
      /permission/u,
    );
    expect(contactResourceFailureMessage("agent memory", "not-found")).toMatch(
      /not available/u,
    );
    expect(contactResourceFailureMessage("agent memory", "malformed")).toMatch(
      /nothing.*empty/iu,
    );
    expect(
      contactResourceFailureMessage("agent memory", "server-error"),
    ).toMatch(/server/u);
    expect(
      contactResourceFailureMessage("agent memory", "unavailable"),
    ).toMatch(/connection/u);
  });
});

describe("Contacts subview source contract", () => {
  const page = source("apps/site/src/app/team/page.tsx");
  const loaders = source("apps/site/src/app/team/surface-loaders.tsx");
  const section = source(
    "apps/site/src/app/team/components/ContactsSection.tsx",
  );
  const detail = source(
    "apps/site/src/app/team/components/ContactsDetailsPaneClient.tsx",
  );
  const notes = source(
    "apps/site/src/app/team/components/InboxContactNotesClient.tsx",
  );
  const reminders = source(
    "apps/site/src/app/team/components/InboxContactRemindersClient.tsx",
  );
  const memoryRoute = source(
    "apps/site/src/app/api/team/contacts/sales-agent-memory/route.ts",
  );
  const analysisRoute = source(
    "apps/site/src/app/api/team/contacts/media-analysis/route.ts",
  );
  const quotePhotosRoute = source(
    "apps/site/src/app/api/team/contacts/quote-photos/route.ts",
  );
  const apiMemoryRoutes = [
    source(
      "apps/api/app/api/admin/contacts/[contactId]/sales-agent-memory/route.ts",
    ),
    source(
      "apps/api/app/api/admin/contacts/[contactId]/sales-agent-memory/rebuild/route.ts",
    ),
  ];
  const apiAnalysisRoutes = [
    source(
      "apps/api/app/api/admin/contacts/[contactId]/media-analysis/route.ts",
    ),
    source(
      "apps/api/app/api/admin/contacts/[contactId]/media-analysis/rebuild/route.ts",
    ),
  ];
  const apiQuotePhotosRoute = source(
    "apps/api/app/api/admin/contacts/[contactId]/instant-quote-photos/route.ts",
  );

  it("threads subview through the canonical server loader and detail links", () => {
    expect(page).toContain("subview?: string");
    expect(page).toContain("subview: params.subview");
    expect(loaders).toContain("subview?: string");
    expect(section).toContain("normalizeContactSubview(subview");
    expect(section).toContain("subview: selectedSubview");
    expect(detail).toContain('aria-label="Contact details"');
    expect(detail).toContain("contactWorkspaceHref({");
    expect(section).not.toContain('name="tab" value="contacts"');
  });

  it("mounts intelligence modules and requests only in the active subview", () => {
    expect(detail).toContain('import("./ContactMediaAnalysisClient")');
    expect(detail).toContain('import("./ContactSalesAgentMemoryClient")');
    expect(detail).not.toContain(
      'import { ContactMediaAnalysisClient } from "./ContactMediaAnalysisClient"',
    );
    expect(detail).toContain("contactWorkspace &&");
    expect(detail).toContain(
      '(subview !== "intelligence" || !capabilities.canReadQuotes)',
    );
    expect(detail).toContain(
      'activeSubviewAllowed && subview === "intelligence"',
    );
    for (const route of [memoryRoute, analysisRoute]) {
      expect(route).toContain('["contacts.read", "quotes.read"]');
      expect(route).toContain('["contacts.write", "quotes.read"]');
      expect(route).toContain('permissionMode: "all"');
    }
    expect(quotePhotosRoute).toContain(
      'permissions: ["contacts.read", "quotes.read"]',
    );
    for (const route of [...apiMemoryRoutes, ...apiAnalysisRoutes]) {
      expect(route).toContain('get("includeQuotePrice") === "1"');
      expect(route).toContain('"quotes.read"');
    }
    expect(apiQuotePhotosRoute).toContain(
      'requirePermission(request, "quotes.read")',
    );
  });

  it("keeps quick actions and edit controls tied to effective capabilities", () => {
    for (const capability of [
      "canWriteContact",
      "canDeleteContact",
      "canReadProperties",
      "canWriteProperties",
      "canDeleteProperties",
      "canUpdatePipeline",
      "canCall",
      "canMessage",
      "canBook",
      "canReadCalendar",
      "canReadQuotes",
      "canWriteQuotes",
      "canReadPartners",
      "canInvitePartners",
    ]) {
      expect(section + detail).toContain(capability);
    }
    expect(notes).toContain("readOnly = false");
    expect(reminders).toContain("readOnly = false");
    expect(detail).toContain("readOnly={!capabilities.canWriteContact}");
  });

  it("retains mobile list recovery and 44px interactive targets", () => {
    expect(section).toContain('className="lg:hidden"');
    expect(section).toContain("Back to contacts");
    expect(section).toContain("min-h-11");
    expect(detail).toContain("min-h-11");
    expect(detail).toContain('aria-label="Contact quick actions"');
    expect(detail).toContain("grid grid-cols-2 gap-2 sm:flex sm:flex-wrap");
    expect(detail).not.toContain("overflow-x-auto pb-1");
  });

  it("names forbidden, missing, malformed, server, and unavailable states", () => {
    for (const copy of [
      "Contacts access denied",
      "Contacts service was not found",
      "Contacts service failed",
      "Contacts response was incomplete",
      "Contacts are temporarily unavailable",
      "Contact access denied",
      "Contact not found",
      "Contact service failed",
      "Contact response was incomplete",
      "Contact could not be reached",
    ]) {
      expect(section).toContain(copy);
    }
    expect(section).toContain(
      "This is a load failure, not an empty contact list",
    );
  });
});

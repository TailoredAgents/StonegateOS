import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeQuoteWorkspaceMode,
  quoteWorkspaceHref,
  resolveQuoteWorkspaceRoute,
} from "../../../site/src/app/team/quotes-workspace";

const REPO_ROOT = join(process.cwd(), "../..");

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("canonical Team quote workspaces", () => {
  it("normalizes legacy builder links without accepting unknown modes", () => {
    expect(normalizeQuoteWorkspaceMode("builder")).toBe("create");
    expect(normalizeQuoteWorkspaceMode("canvass")).toBe("create");
    expect(normalizeQuoteWorkspaceMode("instant")).toBe("instant");
    expect(normalizeQuoteWorkspaceMode("anything-else")).toBe("manage");
  });

  it("resolves the transitional root and all three canonical routes", () => {
    expect(resolveQuoteWorkspaceRoute(["quotes"])).toEqual({
      mode: "manage",
      canonical: false,
    });
    for (const mode of ["create", "manage", "instant"] as const) {
      expect(resolveQuoteWorkspaceRoute(["quotes", mode])).toEqual({
        mode,
        canonical: true,
      });
    }
    expect(resolveQuoteWorkspaceRoute(["quotes", "unknown"])).toBeNull();
  });

  it("builds encoded canonical subview URLs", () => {
    expect(
      quoteWorkspaceHref("create", {
        query: { contactId: "contact /?&=é", propertyId: "property one" },
      }),
    ).toBe(
      "/team/quotes/create?contactId=contact+%2F%3F%26%3D%C3%A9&propertyId=property+one",
    );
    expect(quoteWorkspaceHref("manage")).toBe("/team/quotes/manage");
    expect(quoteWorkspaceHref("instant")).toBe("/team/quotes/instant");
  });

  it("loads only the active quote workspace and canonicalizes legacy input", () => {
    const hub = read("apps/site/src/app/team/components/QuotesHubSection.tsx");
    const route = read("apps/site/src/app/team/[...workspace]/page.tsx");
    const legacyDetailRoute = read(
      "apps/site/src/app/team/instant-quotes/[id]/page.tsx",
    );
    const registry = read("apps/site/src/app/team/surface-registry.ts");

    expect(registry).toContain('canonicalPath: "/team/quotes/manage"');
    expect(hub).toContain('await import("./QuoteBuilderSection")');
    expect(hub).toContain('await import("./QuotesSection")');
    expect(hub).toContain('await import("./InstantQuotesSection")');
    expect(hub).not.toContain('from "./QuoteBuilderSection"');
    expect(hub).not.toContain('from "./QuotesSection"');
    expect(route).toContain("redirect(quoteWorkspaceHref(mode");
    expect(route).toContain("quoteMode: mode");
    expect(legacyDetailRoute).toContain('quoteWorkspaceHref("instant"');
    expect(legacyDetailRoute).toContain("instantQuoteId: id");
    expect(hub).toContain("<InstantQuoteDetail quoteId={instantQuoteId} />");
  });

  it("fails truthfully and keeps quote mutations permission-correct", () => {
    const manage = read("apps/site/src/app/team/components/QuotesSection.tsx");
    const create = read(
      "apps/site/src/app/team/components/QuoteBuilderSection.tsx",
    );
    const list = read("apps/site/src/app/team/QuotesList.tsx");
    const instant = read(
      "apps/site/src/app/team/components/InstantQuotesSection.tsx",
    );
    const detail = read(
      "apps/site/src/app/team/components/InstantQuoteDetail.tsx",
    );

    expect(manage).toContain("Quote management is unavailable");
    expect(manage).toContain("This is not an empty quote list");
    expect(manage).toContain('"quotes.send"');
    expect(manage).toContain('"quotes.update"');
    expect(manage).toContain('"quotes.delete"');
    expect(create).toContain('"quotes.write"');
    expect(create).toContain('"quotes.send"');
    expect(create).toContain(
      'canSend={hasTeamPermissionValue(principal.permissions, "quotes.send")}',
    );
    expect(create).toContain("Quote creation is read-only");
    expect(create).toContain("This is not an empty customer list");
    expect(list).toContain("canSend && sendable");
    expect(list).toContain("canUpdate && decisionable");
    expect(list).toContain("{canDelete && deletable ? (");
    expect(instant).toContain("Instant quotes are unavailable");
    expect(instant).toContain("This is not an empty quote list");
    expect(instant).toContain('"quotes.delete"');
    expect(detail).toContain('"quotes.delete"');
  });
});

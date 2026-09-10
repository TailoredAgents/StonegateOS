import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  partnerAccessCapabilities,
  partnerCompanyAccessHref,
  partnerRelationshipsHref,
} from "../src/app/team/partner-entry-navigation";
import { PartnerAccessEntry } from "../src/app/team/components/PartnerAccessEntry";

const parse = (href: string) => new URL(href, "https://stonegate.example");

void test("relationship selection, filters, paging, and preview never fall back to company accounts", () => {
  const filters = {
    status: "partner",
    ownerId: "owner-1",
    type: "property_manager",
    q: "North & South",
    cursor: "page-2",
    selectedId: "contact-1",
    preview: "1",
    previewJobId: "job-1",
  };
  for (const patch of [
    undefined,
    { cursor: "page-3" },
    { q: "East", cursor: "" },
    { selectedId: "contact-2", preview: "", previewJobId: "" },
    { selectedId: "", preview: "", previewJobId: "" },
  ]) {
    const url = parse(partnerRelationshipsHref({ filters, patch }));
    assert.equal(url.pathname, "/team/partners");
    assert.equal(url.searchParams.get("p_admin"), "relationships");
    assert.equal(url.searchParams.get("p_owner"), "owner-1");
    assert.equal(url.searchParams.get("p_status"), "partner");
    assert.equal(url.searchParams.get("p_q"), patch?.q ?? filters.q);
    assert.equal(
      url.searchParams.get("p_selected"),
      (patch?.selectedId ?? filters.selectedId) || null,
    );
    assert.equal(
      url.searchParams.get("p_cursor"),
      (patch?.cursor ?? filters.cursor) || null,
    );
  }
});

void test("legacy relationship return state is validated rather than promoted to normal navigation", () => {
  const unsafe = parse(
    partnerRelationshipsHref({
      filters: {
        outboundReturn: "https://untrusted.example/team/sales/outbound",
      },
    }),
  );
  assert.equal(unsafe.searchParams.has("out_return"), false);
  const legacy = parse(
    partnerRelationshipsHref({
      filters: { outboundReturn: "/team/sales/outbound?view=queue" },
    }),
  );
  assert.equal(legacy.searchParams.get("p_admin"), "relationships");
  assert.equal(
    parse(legacy.searchParams.get("out_return")!).pathname,
    "/team/sales/outbound",
  );
});

void test("partner access handoff requires deliberate company selection without contact binding", () => {
  const url = parse(partnerCompanyAccessHref());
  assert.equal(url.pathname, "/team/partners");
  assert.deepEqual(
    [...url.searchParams],
    [
      ["p_admin", "accounts"],
      ["p_setup", "existing"],
    ],
  );
  assert.equal(url.hash, "#partner-relationship-setup-heading");
  assert.equal(url.searchParams.has("p_selected"), false);
  assert.equal(url.searchParams.has("orgContactId"), false);
});

void test("partner entry uses canonical company and invitation permissions only", () => {
  for (const permissions of [
    [],
    ["partners.read", "partners.invite"],
    ["partners.invitations.send"],
  ]) {
    assert.deepEqual(partnerAccessCapabilities(permissions), {
      canReadPartners: false,
      canInvitePartners: false,
    });
  }
  assert.deepEqual(partnerAccessCapabilities(["partners.accounts.read"]), {
    canReadPartners: true,
    canInvitePartners: false,
  });
  for (const permissions of [
    ["*"],
    ["partners.*"],
    ["partners.accounts.read", "partners.invitations.send"],
  ]) {
    assert.deepEqual(partnerAccessCapabilities(permissions), {
      canReadPartners: true,
      canInvitePartners: true,
    });
  }
});

void test("rendered partner entry fails closed and never exposes a legacy invitation form", () => {
  for (const canInvite of [false, true]) {
    assert.equal(
      renderToStaticMarkup(
        React.createElement(PartnerAccessEntry, {
          canReadAccounts: false,
          canInvite,
        }),
      ),
      "",
    );
    const html = renderToStaticMarkup(
      React.createElement(PartnerAccessEntry, {
        canReadAccounts: true,
        canInvite,
      }),
    );
    assert.match(
      html,
      canInvite ? /Set up partner access/ : /Open partner companies/,
    );
    assert.match(html, /p_admin=accounts&amp;p_setup=existing/);
    assert.doesNotMatch(
      html,
      /<form|<input|magic link|orgContactId|\/team\/sales\//,
    );
  }
});

void test("normal contact and quote surfaces no longer expose legacy invitation sends or Sales HQ navigation", () => {
  const details = readFileSync(
    new URL(
      "../src/app/team/components/ContactsDetailsPaneClient.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const relationships = readFileSync(
    new URL("../src/app/team/components/PartnersSection.tsx", import.meta.url),
    "utf8",
  );
  const instantQuotes = readFileSync(
    new URL(
      "../src/app/team/components/InstantQuotesSection.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    details + relationships,
    /partnerPortalInviteUserAction|Send fresh login link|Open access applications/,
  );
  assert.match(details, /canReadPartners: false/);
  assert.match(details, /canInvitePartners: false/);
  assert.match(relationships, /action="\/team\/partners"/);
  assert.match(relationships, /name="p_admin" value="relationships"/);
  assert.doesNotMatch(
    relationships,
    /aria-label="Outbound views"|href=\{outbound(?:Queue|Import)Href\}/,
  );
  assert.doesNotMatch(instantQuotes, /href="\/team\/sales\/hq/);
});

void test("legacy partner route and preview bookmarks retain relationship context", () => {
  const route = readFileSync(
    new URL("../src/app/team/[...workspace]/page.tsx", import.meta.url),
    "utf8",
  );
  const preview = readFileSync(
    new URL(
      "../src/app/team/components/PartnerPortalReadOnlyPreview.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    route,
    /if \(!query.has\("p_admin"\)\) query.set\("p_admin", "relationships"\)/,
  );
  assert.equal(
    (preview.match(/return partnerRelationshipsHref\(/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(preview, /teamSurfaceHref\("partners"/);
});

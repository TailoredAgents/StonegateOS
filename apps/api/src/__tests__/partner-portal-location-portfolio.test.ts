import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parsePartnerLocationCsv,
  isLocationImportRowEvidenceConsistent,
  partnerLocationCsvCell,
  serializePartnerLocationCorrectionCsv,
  validatePartnerLocationImportAgainstPortfolio,
} from "@/lib/partner-location-portfolio";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const HEADER =
  "site_name,external_property_id,address_line_1,address_line_2,city,state,postal_code,timezone,parent_external_property_id,make_default";

describe("Partner location portfolio controls", () => {
  it("parses a bounded hierarchy and rejects file-local duplicates and cycles", () => {
    const valid = parsePartnerLocationCsv(
      [
        HEADER,
        "Portfolio,PORT-1,10 Main St,,Atlanta,GA,30303,America/New_York,,true",
        "Site A,SITE-1,12 Main St,,Atlanta,GA,30303,America/New_York,PORT-1,false",
      ].join("\n"),
    );
    expect(valid).toMatchObject({
      rowCount: 2,
      validRowCount: 2,
      invalidRowCount: 0,
    });
    expect(valid.normalizedRows[1]?.parentExternalPropertyId).toBe("PORT-1");

    const unsafe = parsePartnerLocationCsv(
      [
        HEADER,
        "A,DUP,10 Main St,,Atlanta,GA,30303,America/New_York,B,false",
        "B,B,10 Main St,,Atlanta,GA,30303,America/New_York,DUP,false",
      ].join("\n"),
    );
    expect(unsafe.invalidRowCount).toBe(2);
    expect(
      unsafe.rowResults.flatMap((row) => row.errors.map((error) => error.code)),
    ).toEqual(expect.arrayContaining(["duplicate_in_file", "hierarchy_cycle"]));
  });

  it("never silently merges an existing address or external property ID", () => {
    const parsed = parsePartnerLocationCsv(
      [
        HEADER,
        "Existing,PROP-9,99 Oak Rd,,Atlanta,GA,30303,America/New_York,,false",
      ].join("\n"),
    );
    const validated = validatePartnerLocationImportAgainstPortfolio(parsed, [
      {
        id: "11111111-1111-4111-8111-111111111111",
        externalPropertyId: "prop-9",
        addressKey: parsed.normalizedRows[0]!.addressKey,
        active: true,
      },
    ]);
    expect(validated.validRowCount).toBe(0);
    expect(validated.rowResults[0]?.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["duplicate_existing"]),
    );
  });

  it("rejects overlong fields and never truncates a state into a valid code", () => {
    const parsed = parsePartnerLocationCsv(
      [
        HEADER,
        [
          "S".repeat(121),
          "E".repeat(101),
          "A".repeat(201),
          "B".repeat(101),
          "C".repeat(101),
          "New York",
          "1".repeat(17),
          "America/New_York",
          "P".repeat(101),
          "false",
        ].join(","),
      ].join("\n"),
    );
    expect(parsed.normalizedRows).toHaveLength(0);
    expect(parsed.invalidRowCount).toBe(1);
    expect(parsed.rowResults[0]?.values["state"]).toBe("New York");
    expect(
      parsed.rowResults[0]?.errors.map((error) => [error.code, error.field]),
    ).toEqual(
      expect.arrayContaining([
        ["too_long", "site_name"],
        ["too_long", "external_property_id"],
        ["too_long", "address_line_1"],
        ["too_long", "address_line_2"],
        ["too_long", "city"],
        ["too_long", "state"],
        ["invalid", "state"],
        ["too_long", "postal_code"],
        ["too_long", "parent_external_property_id"],
      ]),
    );
    expect(JSON.stringify(parsed)).not.toContain('"state":"NE"');
  });

  it("preserves exact normalized boundary input and rejects stale truncated evidence at commit", () => {
    const siteName = `  ${"S".repeat(60)}   ${"T".repeat(59)}  `;
    const parsed = parsePartnerLocationCsv(
      [
        HEADER,
        `${siteName},EXT-1,10 Main St,,Atlanta,ga,30303,America/New_York,,false`,
      ].join("\n"),
    );
    expect(parsed.validRowCount).toBe(1);
    expect(parsed.normalizedRows[0]?.siteName).toBe(
      `${"S".repeat(60)} ${"T".repeat(59)}`,
    );
    expect(parsed.normalizedRows[0]?.state).toBe("GA");

    const normalized = parsed.normalizedRows[0]!;
    expect(
      isLocationImportRowEvidenceConsistent(normalized, {
        ...parsed.rowResults[0]!,
        values: {
          ...parsed.rowResults[0]!.values,
          site_name: `${normalized.siteName}${"X"}`,
        },
      }),
    ).toBe(false);
  });

  it("rejects secret-bearing columns and escapes spreadsheet formulas", () => {
    expect(() =>
      parsePartnerLocationCsv(
        `${HEADER},gate_code\nSite,S-1,1 Main St,,Atlanta,GA,30303,America/New_York,,false,1234`,
      ),
    ).toThrow("location_csv_headers_invalid");
    expect(partnerLocationCsvCell('=HYPERLINK("bad")')).toBe(
      '"\'=HYPERLINK(""bad"")"',
    );
    const correction = serializePartnerLocationCorrectionCsv([
      {
        rowNumber: 2,
        status: "invalid",
        values: { site_name: "Safe site" },
        errors: [{ code: "required", field: "city", message: "Enter a city." }],
      },
    ]);
    expect(correction).not.toMatch(/gate[_ ]?code|access[_ ]?secret/iu);
  });

  it("freezes tenant/default/hierarchy/import invariants in migration 0154", () => {
    const migration = source(
      "src/db/migrations/0154_partner_location_portfolio_controls.sql",
    );
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain(
      "partner_account_active_location_requires_default",
    );
    expect(migration).toContain("partner_location_hierarchy_cycle");
    expect(migration).toContain(
      "partner_location_favorites_membership_account_fk",
    );
    expect(migration).toContain(
      "partner_location_imports_no_secret_keys_check",
    );
    expect(migration).toContain("prune_partner_location_imports");
    expect(migration).toContain("prune_limit integer DEFAULT 500");
    expect(journal.entries).toContainEqual(
      expect.objectContaining({
        idx: 151,
        tag: "0154_partner_location_portfolio_controls",
      }),
    );
  });

  it("routes every unsafe mutation through origin, bounded JSON, CAS, idempotency and audit", () => {
    const collection = source("app/api/portal/v2/locations/route.ts");
    const item = source("app/api/portal/v2/locations/[locationId]/route.ts");
    const favorite = source(
      "app/api/portal/v2/locations/[locationId]/favorite/route.ts",
    );
    const dryRun = source(
      "app/api/portal/v2/locations/imports/dry-run/route.ts",
    );
    const commit = source(
      "app/api/portal/v2/locations/imports/[importId]/commit/route.ts",
    );
    for (const route of [collection, item, favorite, dryRun, commit]) {
      expect(route).toContain("isAllowedPartnerPortalMutationOrigin");
      expect(route).toContain("rejectDuplicateObjectKeys: true");
      expect(route).toContain("readPortalV2IdempotencyKey");
    }
    for (const route of [item, favorite, commit]) {
      expect(route).toContain("evaluatePortalV2RevisionPrecondition");
    }
    for (const route of [collection, item, dryRun, commit]) {
      expect(route).toContain("lockPartnerLocationDirectory");
    }
    expect(item).toContain("getPartnerLocationArchiveImpact");
    expect(item).toContain("impact.issuedActionableQuoteV2Count > 0");
    expect(item).toContain("incrementPartnerLocationDirectory");
    expect(commit).toContain("validatePartnerLocationImportAgainstPortfolio");
    expect(commit).toContain("isLocationImportRowEvidenceConsistent");
    expect(commit).toContain("db.transaction");
    expect(dryRun).toContain("auditPartnerLocationPortfolio");
    expect(commit).not.toMatch(/accessSecret|gateCode|gate_code/u);
  });

  it("keeps archived-location quote evidence visible while blocking new commercial actions", () => {
    const quotePortal = source("src/lib/partner-portal-v2-quotes.ts");
    const quoteSafety = source("src/lib/partner-quote-location-safety.ts");
    const quoteIssue = source("src/lib/quote-v2-issue-persistence.ts");
    expect(quotePortal).not.toContain("quote_draft_location.active is true");
    expect(quotePortal).not.toContain("quote_location.active is true");
    expect(quotePortal).toContain(
      "lockPartnerQuoteLocationForCommercialAction",
    );
    expect(quotePortal).toContain('failure(409, "quote_location_archived"');
    expect(quotePortal).toContain("remains available as financial evidence");
    expect(
      quotePortal.slice(
        quotePortal.indexOf(
          "export async function loadCanonicalPartnerQuoteDocument",
        ),
      ),
    ).toContain("loadPartnerQuoteRow");
    expect(quoteSafety).toContain('.for("share")');
    expect(quoteSafety).toContain("partnerQuoteBoundToLocationExpression");
    expect(quoteIssue).toContain("lockPartnerQuoteLocationForCommercialAction");
  });
});

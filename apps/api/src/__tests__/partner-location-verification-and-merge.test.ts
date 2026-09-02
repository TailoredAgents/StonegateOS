import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseMapboxAddressVerification } from "@/lib/geocode";
import { partnerLocationDuplicateConfidence } from "@/lib/partner-location-portfolio";
import {
  PartnerLocationMergeSchema,
  PartnerLocationUnmergeSchema,
} from "@/lib/partner-portal-v2-locations";

const ENTERED_ADDRESS = Object.freeze({
  addressLine1: "10 North Main Street",
  addressLine2: "Suite 200",
  city: "Atlanta",
  state: "GA",
  postalCode: "30303",
});

function mapboxAddressFeature(
  input?: Readonly<{
    addressLine1?: string;
    city?: string;
    regionCode?: string;
    postalCode?: string;
    countryCode?: string;
    confidence?: string;
    coordinates?: readonly [number, number];
  }>,
): unknown {
  const coordinates = input?.coordinates ?? [-84.388, 33.749];
  return {
    type: "FeatureCollection",
    features: [
      {
        id: "address.mapbox-feature-fallback",
        geometry: { type: "Point", coordinates },
        properties: {
          mapbox_id: "address.mapbox-feature-1",
          feature_type: "address",
          name: input?.addressLine1 ?? "10 N Main St",
          match_code: { confidence: input?.confidence ?? "high" },
          context: {
            address: { name: input?.addressLine1 ?? "10 N Main St" },
            place: { name: input?.city ?? "Atlanta" },
            region: { region_code: input?.regionCode ?? "US-GA" },
            postcode: { name: input?.postalCode ?? "30303-1234" },
            country: { country_code: input?.countryCode ?? "US" },
          },
        },
      },
    ],
  };
}

describe("Partner location verification and merge contracts", () => {
  it("parses an allow-listed exact Mapbox address without treating formatting aliases as corrections", () => {
    expect(
      parseMapboxAddressVerification(ENTERED_ADDRESS, mapboxAddressFeature()),
    ).toEqual({
      status: "verified",
      provider: "mapbox",
      reasonCode: "verified",
      confidence: 90,
      featureId: "address.mapbox-feature-1",
      coordinates: { lat: 33.749, lng: -84.388 },
      suggestedAddress: {
        addressLine1: "10 N Main St",
        addressLine2: "Suite 200",
        city: "Atlanta",
        state: "GA",
        postalCode: "30303-1234",
      },
      changedFields: [],
    });
  });

  it("routes corrections, invalid geometry, foreign results, and unavailable providers conservatively", () => {
    const correction = parseMapboxAddressVerification(
      ENTERED_ADDRESS,
      mapboxAddressFeature({
        addressLine1: "12 N Main St",
        confidence: "medium",
      }),
    );
    expect(correction).toMatchObject({
      status: "suggested_correction",
      provider: "mapbox",
      reasonCode: "suggested_correction",
      confidence: 70,
      changedFields: ["addressLine1"],
    });

    expect(
      parseMapboxAddressVerification(
        ENTERED_ADDRESS,
        mapboxAddressFeature({ coordinates: [500, 500] }),
      ),
    ).toMatchObject({
      status: "review_required",
      provider: "mapbox",
      reasonCode: "low_confidence",
      coordinates: null,
    });
    expect(
      parseMapboxAddressVerification(
        ENTERED_ADDRESS,
        mapboxAddressFeature({ countryCode: "CA" }),
      ),
    ).toMatchObject({
      status: "review_required",
      provider: "mapbox",
      reasonCode: "low_confidence",
    });
    expect(parseMapboxAddressVerification(ENTERED_ADDRESS, null)).toEqual({
      status: "review_required",
      provider: "none",
      reasonCode: "provider_unavailable",
      confidence: null,
      featureId: null,
      coordinates: null,
      suggestedAddress: null,
      changedFields: [],
    });
  });

  it("normalizes street suffixes and directions while preserving unit mismatch confidence", () => {
    const alias = partnerLocationDuplicateConfidence(ENTERED_ADDRESS, {
      ...ENTERED_ADDRESS,
      addressLine1: "10 N Main St",
    });
    expect(alias).toEqual({
      confidence: 94,
      signals: [
        "postal_code",
        "state",
        "city",
        "street_number",
        "street_name",
        "unit",
      ],
    });

    const differentUnit = partnerLocationDuplicateConfidence(ENTERED_ADDRESS, {
      ...ENTERED_ADDRESS,
      addressLine1: "10 N Main St",
      addressLine2: "Suite 201",
    });
    expect(differentUnit).toEqual({
      confidence: 75,
      signals: [
        "postal_code",
        "state",
        "city",
        "street_number",
        "street_name",
        "different_unit",
      ],
    });
    expect(differentUnit.confidence).toBeLessThan(alias.confidence);
  });

  it("requires exact, bounded merge and restore confirmations", () => {
    const targetLocationId = randomUUID();
    expect(
      PartnerLocationMergeSchema.parse({
        targetLocationId: targetLocationId.toUpperCase(),
        reason: "  Duplicate created during portfolio import.  ",
        confirmation: "MERGE DUPLICATE LOCATION",
      }),
    ).toEqual({
      targetLocationId,
      reason: "Duplicate created during portfolio import.",
      confirmation: "MERGE DUPLICATE LOCATION",
    });
    expect(
      PartnerLocationMergeSchema.safeParse({
        targetLocationId,
        reason: "Duplicate site",
        confirmation: "MERGE LOCATION",
      }).success,
    ).toBe(false);
    expect(
      PartnerLocationUnmergeSchema.safeParse({
        reason: "Restore duplicate source for review.",
        confirmation: "RESTORE MERGED LOCATION",
      }).success,
    ).toBe(true);
    expect(
      PartnerLocationUnmergeSchema.safeParse({
        reason: "Restore duplicate source for review.",
        confirmation: "RESTORE LOCATION",
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("keeps account merge preparation and completion behind distinct destructive confirmations", () => {
    const prepareRoute = readFileSync(
      resolve(
        process.cwd(),
        "app/api/admin/partner-management/v1/accounts/[accountId]/merge/route.ts",
      ),
      "utf8",
    );
    const completeRoute = readFileSync(
      resolve(
        process.cwd(),
        "app/api/admin/partner-management/v1/account-merges/[caseId]/complete/route.ts",
      ),
      "utf8",
    );
    expect(prepareRoute).toContain(
      'confirmation: z.literal("PREPARE PARTNER ACCOUNT MERGE")',
    );
    expect(completeRoute).toContain(
      'confirmation: z.literal("COMPLETE PARTNER ACCOUNT MERGE")',
    );
    for (const route of [prepareRoute, completeRoute]) {
      expect(route).toContain(
        'requiredPermissions: ["partners.accounts.merge"]',
      );
      expect(route).toContain('risk: "destructive"');
      expect(route).toContain("requiresIdempotency: true");
      expect(route).toContain("maxAuthenticationAgeSeconds: 15 * 60");
    }
  });
});

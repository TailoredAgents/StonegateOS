import fs from "node:fs";
import path from "node:path";
import { contactProperties, properties } from "@/db";
import {
  normalizePropertyAddress,
  resolveOrCreateContactProperty,
  type PropertyWriteExecutor,
} from "@/lib/property-write";
import {
  PublicContactPersistenceError,
  upsertContact,
} from "../../app/api/web/persistence";

const API_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(API_ROOT, "../..");

function apiSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

function repoSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(REPO_ROOT, relativePath), "utf8");
}

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const PROPERTY_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-08T12:00:00.000Z");

const EXISTING_PROPERTY = {
  id: PROPERTY_ID,
  contactId: "33333333-3333-4333-8333-333333333333",
  addressKey: "10 shared street||atlanta|ga|30301",
  addressLine1: "10 Shared Street",
  addressLine2: null,
  city: "Atlanta",
  state: "GA",
  postalCode: "30301",
  lat: null,
  lng: null,
  gated: false,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("canonical property writers and instant-quote relationships", () => {
  it("keeps placeholder addresses distinct while normalizing stable identity", () => {
    const first = normalizePropertyAddress({
      addressLine1: "[Missed Call abc123] Address pending",
      city: "Unknown",
      state: "NA",
      postalCode: "00000",
    });
    const same = normalizePropertyAddress({
      addressLine1: "  [missed   call ABC123] address PENDING ",
      city: " unknown ",
      state: "na",
      postalCode: "00000",
    });
    const anotherThread = normalizePropertyAddress({
      addressLine1: "[Missed Call def456] Address pending",
      city: "Unknown",
      state: "NA",
      postalCode: "00000",
    });

    expect(first.addressKey).toBe(same.addressKey);
    expect(first.addressKey).not.toBe(anotherThread.addressKey);
  });

  it("links a shared canonical property without changing its compatibility owner", async () => {
    let associationValues: Record<string, unknown> | null = null;
    const select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn().mockResolvedValue([EXISTING_PROPERTY]),
        })),
      })),
    }));
    const insert = jest.fn((table: unknown) => {
      expect(table).toBe(contactProperties);
      return {
        values: jest.fn((values: Record<string, unknown>) => {
          associationValues = values;
          return {
            onConflictDoNothing: jest.fn(() => ({
              returning: jest.fn().mockResolvedValue([{ id: "association" }]),
            })),
          };
        }),
      };
    });

    const result = await resolveOrCreateContactProperty(
      { select, insert } as unknown as PropertyWriteExecutor,
      {
        contactId: CONTACT_ID,
        addressLine1: "10 shared street",
        city: "Atlanta",
        state: "GA",
        postalCode: "30301",
        now: NOW,
      },
    );

    expect(result).toEqual({
      property: EXISTING_PROPERTY,
      propertyCreated: false,
      associationCreated: true,
    });
    expect(associationValues).toEqual(
      expect.objectContaining({
        contactId: CONTACT_ID,
        propertyId: PROPERTY_ID,
        relationship: "customer",
      }),
    );
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("creates a canonical row and association together for a new address", async () => {
    const captured: Array<{ table: unknown; values: Record<string, unknown> }> =
      [];
    const select = jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn().mockResolvedValue([]),
        })),
      })),
    }));
    const insertedProperty = {
      ...EXISTING_PROPERTY,
      contactId: CONTACT_ID,
      addressKey: "20 new street|unit 4|atlanta|ga|30302",
      addressLine1: "20 New Street",
      addressLine2: "Unit 4",
      postalCode: "30302",
    };
    const insert = jest.fn((table: unknown) => ({
      values: jest.fn((values: Record<string, unknown>) => {
        captured.push({ table, values });
        return {
          onConflictDoNothing: jest.fn(() => ({
            returning: jest
              .fn()
              .mockResolvedValue(
                table === properties
                  ? [insertedProperty]
                  : [{ id: "association" }],
              ),
          })),
        };
      }),
    }));

    const result = await resolveOrCreateContactProperty(
      { select, insert } as unknown as PropertyWriteExecutor,
      {
        contactId: CONTACT_ID,
        addressLine1: " 20 New Street ",
        addressLine2: " Unit 4 ",
        city: "Atlanta",
        state: "ga",
        postalCode: "30302",
        now: NOW,
      },
    );

    expect(result.propertyCreated).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[0]?.table).toBe(properties);
    expect(captured[0]?.values["contactId"]).toBe(CONTACT_ID);
    expect(captured[0]?.values["addressKey"]).toBe(
      "20 new street|unit 4|atlanta|ga|30302",
    );
    expect(captured[0]?.values["addressLine1"]).toBe("20 New Street");
    expect(captured[0]?.values["addressLine2"]).toBe("Unit 4");
    expect(captured[1]?.table).toBe(contactProperties);
    expect(captured[1]?.values["contactId"]).toBe(CONTACT_ID);
    expect(captured[1]?.values["propertyId"]).toBe(PROPERTY_ID);
  });

  it("fails explicitly before writing when an identity is soft-deleted", async () => {
    const insert = jest.fn();
    const database = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn().mockResolvedValue([{ id: CONTACT_ID }]),
          })),
        })),
      })),
      insert,
    } as unknown as Parameters<typeof upsertContact>[0];

    const promise = upsertContact(database, {
      firstName: "Recoverable",
      lastName: "Customer",
      phoneRaw: "404-555-0100",
      phoneE164: "+14045550100",
      email: "recoverable@example.test",
    });

    await expect(promise).rejects.toBeInstanceOf(PublicContactPersistenceError);
    await expect(promise).rejects.toMatchObject({
      name: "PublicContactPersistenceError",
      code: "contact_deleted",
      status: 409,
      publicCode: "contact_unavailable",
      publicMessage:
        "We could not safely save this request online. Please contact the office for help.",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("registers additive migration 0070 at journal index 67", () => {
    const journal = JSON.parse(
      apiSource("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];
    const prior = entries.findIndex(
      (entry) => entry.tag === "0069_payout_run_integrity",
    );

    expect(entries.slice(prior, prior + 2)).toEqual([
      expect.objectContaining({ idx: 66, tag: "0069_payout_run_integrity" }),
      expect.objectContaining({
        idx: 67,
        tag: "0070_instant_quote_relationships",
      }),
    ]);
  });

  it("backfills only unanimous lead relationships and reports every ambiguity", () => {
    const migration = apiSource(
      "src/db/migrations/0070_instant_quote_relationships.sql",
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "contact_id" uuid');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "property_id" uuid');
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "instant_quote_relationship_backfill_ambiguities"',
    );
    expect(migration).toContain('HAVING count(DISTINCT lead."contact_id") = 1');
    expect(migration).toContain('AND count(DISTINCT lead."property_id") = 1');
    expect(migration).toContain(
      'ON CONFLICT ("contact_id", "property_id") DO NOTHING',
    );
    expect(migration).toContain(
      'CONSTRAINT "instant_quotes_contact_property_association_fk"',
    );
    expect(migration.match(/NOT VALID/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(
      migration.match(/VALIDATE CONSTRAINT/gu)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(migration).not.toMatch(/contact_phone|phone_e164|contact_name/iu);
  });

  it.each([
    "app/api/web/persistence.ts",
    "app/api/portal/properties/route.ts",
    "app/api/webhooks/twilio/voice/route.ts",
    "app/api/webhooks/twilio/call-status/route.ts",
    "app/api/admin/tools/contact/route.ts",
    "app/api/admin/booking/book/route.ts",
    "app/api/junk-quote/book/route.ts",
  ])("routes %s through the canonical association writer", (relativePath) => {
    expect(apiSource(relativePath)).toContain("resolveOrCreateContactProperty");
  });

  it("keeps the deterministic E2E fixture on the same canonical writer", () => {
    expect(repoSource("scripts/seed-e2e.ts")).toContain(
      "resolveOrCreateContactProperty",
    );
  });

  it.each([
    "app/api/brush-quote/route.ts",
    "app/api/demo-quote/route.ts",
    "app/api/junk-quote/route.ts",
  ])(
    "sets both explicit relationships inside the %s CRM transaction",
    (relativePath) => {
      const route = apiSource(relativePath);
      const transactionStart = route.indexOf("db.transaction(async (tx)");
      const quoteInsert = route.indexOf(
        ".insert(instantQuotes)",
        transactionStart,
      );
      const relationshipUpdate = route.indexOf(
        ".update(instantQuotes)",
        transactionStart,
      );
      const leadInsert = route.indexOf(".insert(leads)", relationshipUpdate);

      expect(transactionStart).toBeGreaterThan(-1);
      expect(quoteInsert).toBeGreaterThan(transactionStart);
      expect(relationshipUpdate).toBeGreaterThan(quoteInsert);
      expect(leadInsert).toBeGreaterThan(relationshipUpdate);
      expect(route.slice(relationshipUpdate, leadInsert)).toContain(
        "contactId: contact.id",
      );
      expect(route.slice(relationshipUpdate, leadInsert)).toContain(
        "propertyId: property.id",
      );
      expect(route).toContain('throw new Error("lead_insert_failed")');
      expect(route).not.toContain(".delete(instantQuotes)");
      expect(route).not.toContain("lead_create_failed");
      expect(route.indexOf("ok: true", leadInsert)).toBeGreaterThan(leadInsert);
    },
  );

  it.each([
    "app/api/brush-quote/route.ts",
    "app/api/demo-quote/route.ts",
    "app/api/junk-quote/route.ts",
    "app/api/junk-quote/book/route.ts",
    "app/api/web/lead-intake/route.ts",
  ])(
    "returns an explicit recoverable identity conflict from %s",
    (relativePath) => {
      const route = apiSource(relativePath);
      const publicErrorStart = route.indexOf(
        "if (error instanceof PublicContactPersistenceError)",
      );
      const nextErrorBranch = route.indexOf(
        "if (error instanceof",
        publicErrorStart + 1,
      );
      const publicErrorBlock = route.slice(
        publicErrorStart,
        nextErrorBranch > publicErrorStart
          ? nextErrorBranch
          : publicErrorStart + 600,
      );

      expect(publicErrorStart).toBeGreaterThan(-1);
      expect(publicErrorBlock).toContain("error: error.publicCode");
      expect(publicErrorBlock).toContain("message: error.publicMessage");
      expect(publicErrorBlock).toContain("status: error.status");
      expect(publicErrorBlock).not.toContain("error: error.code");
      expect(publicErrorBlock).not.toMatch(/recovery window|restore it/iu);
    },
  );

  it("lets a partner book a shared property through its association", () => {
    const route = apiSource("app/api/portal/bookings/route.ts");

    expect(route).toContain("contactProperties");
    expect(route).toContain(
      "eq(contactProperties.contactId, auth.partnerUser.orgContactId)",
    );
  });

  it("exposes linked IDs and ambiguity status in authenticated list/detail reads", () => {
    const route = apiSource("app/api/admin/instant-quotes/route.ts");

    expect(route).toContain('requirePermission(request, "quotes.read")');
    expect(route.match(/contactId: instantQuotes\.contactId/gu)).toHaveLength(
      2,
    );
    expect(route.match(/propertyId: instantQuotes\.propertyId/gu)).toHaveLength(
      2,
    );
    expect(route).toContain("relationshipBackfillAmbiguous");
    expect(route).toContain(
      "from instant_quote_relationship_backfill_ambiguities ambiguity",
    );
    expect(route).toContain(
      `const outerInstantQuoteId = sql.raw('"instant_quotes"."id"')`,
    );
    expect(route).not.toContain(
      "where lead.instant_quote_id = ${instantQuotes.id}",
    );
    expect(route).not.toContain(
      "where ambiguity.instant_quote_id = ${instantQuotes.id}",
    );
  });
});

import fs from "node:fs";
import path from "node:path";
import { normalizePropertyAddress } from "@/lib/property-write";

const API_ROOT = path.resolve(process.cwd());

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

describe("expand-first contact/property associations", () => {
  it("normalizes case and whitespace while keeping physical units distinct", () => {
    const first = normalizePropertyAddress({
      addressLine1: " 20   NEW Street ",
      addressLine2: " Suite 5 ",
      city: " ANNAPOLIS ",
      state: " md ",
      postalCode: " 21401 ",
    });
    const same = normalizePropertyAddress({
      addressLine1: "20 new street",
      addressLine2: "suite 5",
      city: "Annapolis",
      state: "MD",
      postalCode: "21401",
    });
    const otherUnit = normalizePropertyAddress({
      addressLine1: "20 New Street",
      addressLine2: "Suite 6",
      city: "Annapolis",
      state: "MD",
      postalCode: "21401",
    });

    expect(first.addressKey).toBe(same.addressKey);
    expect(first.addressKey).not.toBe(otherUnit.addressKey);
    expect(first).toEqual(
      expect.objectContaining({
        addressLine1: "20 NEW Street",
        addressLine2: "Suite 5",
        city: "ANNAPOLIS",
        state: "MD",
        postalCode: "21401",
      }),
    );
  });

  it("registers migration 0067 directly after durable idempotency", () => {
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];
    const idempotencyIndex = entries.findIndex(
      (entry) => entry.tag === "0066_team_mutation_idempotency",
    );

    expect(entries.slice(idempotencyIndex, idempotencyIndex + 2)).toEqual([
      expect.objectContaining({
        idx: 63,
        tag: "0066_team_mutation_idempotency",
      }),
      expect.objectContaining({
        idx: 64,
        tag: "0067_contact_property_associations",
      }),
    ]);
  });

  it("backfills every legacy owner link without rewriting linked records", () => {
    const migration = source(
      "src/db/migrations/0067_contact_property_associations.sql",
    );

    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "contact_properties"',
    );
    expect(migration).toContain('INSERT INTO "contact_properties" (');
    expect(migration).toContain('FROM "properties"');
    expect(migration).toContain('WHERE "contact_id" IS NOT NULL');
    expect(migration).toContain(
      'ON CONFLICT ("contact_id", "property_id") DO NOTHING',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "contact_properties_contact_property_key"',
    );
    expect(migration).not.toMatch(
      /UPDATE\s+"?(leads|quotes|appointments)"?\s+SET\s+"?property_id/iu,
    );
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"properties"/iu);
  });

  it("replaces destructive ownership and the flawed address index safely", () => {
    const migration = source(
      "src/db/migrations/0067_contact_property_associations.sql",
    );

    expect(migration).toContain('ALTER COLUMN "contact_id" DROP NOT NULL');
    expect(migration).toContain("ON DELETE SET NULL ON UPDATE NO ACTION");
    expect(migration).toContain(
      'DROP INDEX IF EXISTS "properties_address_key"',
    );
    expect(migration).toContain("row_number() OVER (");
    expect(migration).toContain('normalized."identity_rank" = 1');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "properties_physical_address_key"',
    );
    expect(migration).toContain('WHERE "address_key" IS NOT NULL');
  });

  it("links and unlinks contacts without deleting the physical property", () => {
    const createRoute = source(
      "app/api/admin/contacts/[contactId]/properties/route.ts",
    );
    const detailRoute = source(
      "app/api/admin/contacts/[contactId]/properties/[propertyId]/route.ts",
    );
    const quoteRoute = source("app/api/admin/tools/quote/route.ts");
    const propertyReader = source("src/lib/property-write.ts");

    expect(createRoute).toContain("properties.addressKey");
    expect(createRoute).toContain(".insert(contactProperties)");
    expect(createRoute).toContain(".onConflictDoNothing()");
    expect(detailRoute).toContain('action: "property.unlinked"');
    expect(detailRoute).toContain("physicalPropertyRetained: true");
    expect(detailRoute).not.toContain(".delete(properties)");
    expect(quoteRoute).toContain("loadContactPropertyById");
    expect(propertyReader).toContain("contactProperties.contactId");
    expect(propertyReader).toContain("isNull(contactProperties.id)");
  });
});

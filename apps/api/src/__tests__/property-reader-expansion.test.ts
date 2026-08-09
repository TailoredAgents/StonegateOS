import fs from "node:fs";
import path from "node:path";
import {
  loadContactPropertiesForContacts,
  loadContactPropertyById,
  mergeAssociationFirstContactPropertyRows,
  type ContactPropertyLink,
  type PropertyRecord,
  type PropertyWriteExecutor,
} from "@/lib/property-write";

const API_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const CONTACT_A = "11111111-1111-4111-8111-111111111111";
const CONTACT_B = "22222222-2222-4222-8222-222222222222";

function apiSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

function repoSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(REPO_ROOT, relativePath), "utf8");
}

function property(
  id: string,
  contactId: string | null,
  createdAt: string,
): PropertyRecord {
  return {
    id,
    contactId,
    addressKey: `${id}|address`,
    addressLine1: `${id} Main Street`,
    addressLine2: null,
    city: "Atlanta",
    state: "GA",
    postalCode: "30301",
    lat: null,
    lng: null,
    gated: false,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function accessExecutor(
  rowsBySelect: Array<Array<{ property: PropertyRecord }>>,
): PropertyWriteExecutor {
  let call = 0;
  return {
    select: jest.fn(() => {
      const rows = rowsBySelect[call] ?? [];
      call += 1;
      const joined = {
        where: jest.fn(() => ({
          limit: jest.fn().mockResolvedValue(rows),
        })),
      };
      return {
        from: jest.fn(() => ({
          innerJoin: jest.fn(() => joined),
          leftJoin: jest.fn(() => joined),
        })),
      };
    }),
  } as unknown as PropertyWriteExecutor;
}

function bulkExecutor(
  associated: ContactPropertyLink[],
  compatibility: ContactPropertyLink[],
): PropertyWriteExecutor {
  let call = 0;
  return {
    select: jest.fn(() => {
      const links = call === 0 ? associated : compatibility;
      call += 1;
      const rows = links.map((link) => ({
        contactId: link.contactId,
        property: link.property,
      }));
      const joined = {
        where: jest.fn(() => ({
          orderBy: jest.fn(() => ({
            limit: jest.fn().mockResolvedValue(rows),
          })),
        })),
      };
      return {
        from: jest.fn(() => ({
          innerJoin: jest.fn(() => joined),
          leftJoin: jest.fn(() => joined),
        })),
      };
    }),
  } as unknown as PropertyWriteExecutor;
}

describe("association-first property readers", () => {
  const shared = property(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    CONTACT_A,
    "2026-08-08T12:00:00.000Z",
  );
  const legacyOnly = property(
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    CONTACT_A,
    "2026-08-07T12:00:00.000Z",
  );

  it("never lets a stale compatibility owner override a shared property's explicit association", () => {
    const rows = mergeAssociationFirstContactPropertyRows(
      [
        {
          contactId: CONTACT_B,
          property: shared,
          source: "association",
        },
      ],
      [
        {
          contactId: CONTACT_A,
          property: shared,
          source: "compatibility",
        },
        {
          contactId: CONTACT_A,
          property: legacyOnly,
          source: "compatibility",
        },
      ],
      [CONTACT_A, CONTACT_B],
    );

    expect(
      rows.map((row) => `${row.contactId}:${row.property.id}:${row.source}`),
    ).toEqual([
      `${CONTACT_B}:${shared.id}:association`,
      `${CONTACT_A}:${legacyOnly.id}:compatibility`,
    ]);
  });

  it("returns a shared property to its associated contact without consulting fallback", async () => {
    const executor = accessExecutor([[{ property: shared }]]);

    const result = await loadContactPropertyById(executor, {
      contactId: CONTACT_B,
      propertyId: shared.id,
    });

    expect(result?.id).toBe(shared.id);
  });

  it("does not expose a shared property to its stale compatibility owner", async () => {
    const executor = accessExecutor([[], []]);

    const result = await loadContactPropertyById(executor, {
      contactId: CONTACT_A,
      propertyId: shared.id,
    });

    expect(result).toBeNull();
  });

  it("retains an unassociated legacy row as an explicit rollback fallback", async () => {
    const executor = accessExecutor([[], [{ property: legacyOnly }]]);

    const result = await loadContactPropertyById(executor, {
      contactId: CONTACT_A,
      propertyId: legacyOnly.id,
    });

    expect(result?.id).toBe(legacyOnly.id);
  });

  it("deduplicates bulk results and filters contacts outside the requested set", async () => {
    const executor = bulkExecutor(
      [
        {
          contactId: CONTACT_B,
          property: shared,
          source: "association",
        },
      ],
      [
        {
          contactId: CONTACT_B,
          property: shared,
          source: "compatibility",
        },
        {
          contactId: CONTACT_A,
          property: legacyOnly,
          source: "compatibility",
        },
      ],
    );

    const rows = await loadContactPropertiesForContacts(
      executor,
      [CONTACT_B],
      { limit: 100 },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      contactId: CONTACT_B,
      source: "association",
    });
    expect(rows[0]?.property.id).toBe(shared.id);
  });

  it("routes named production readers through the shared access helpers", () => {
    const salesQueue = apiSource("app/api/admin/sales/queue/route.ts");
    const standardQuote = apiSource("app/api/quotes/route.ts");
    const toolQuote = apiSource("app/api/admin/tools/quote/route.ts");

    expect(salesQueue).toContain("loadContactPropertiesForContacts");
    expect(salesQueue).not.toContain("properties.contactId");
    expect(standardQuote).toContain("loadContactPropertyById");
    expect(standardQuote).not.toContain("property.contactId !== contact.id");
    expect(toolQuote).toContain("loadContactPropertyById");
    expect(toolQuote).not.toContain("properties.contactId");
  });

  it("keeps merge fallback unassociated and deduplicates before reassignment", () => {
    const merge = apiSource("src/lib/merge-queue.ts");

    expect(merge).toContain("sourcePropertyAssociations");
    expect(merge).toContain("sourceCompatibilityProperties");
    expect(merge).toContain("isNull(contactProperties.id)");
    expect(merge).toContain("const sourcePropertyLinks = Array.from(");
    expect(merge).toContain("inArray(properties.id, sourcePropertyIds)");
  });

  it("uses the shared reader in property-dependent maintenance/demo scripts", () => {
    expect(repoSource("scripts/quote-demo.ts")).toContain(
      "loadContactPropertiesForContacts",
    );
    expect(repoSource("scripts/submit-lead.ts")).toContain(
      "loadContactPropertiesForContacts",
    );
    expect(repoSource("scripts/quote-demo.ts")).not.toContain(
      "properties.contactId",
    );
    expect(repoSource("scripts/submit-lead.ts")).not.toContain(
      "properties.contactId",
    );
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  correctionCsv,
  parseCsv,
  parseRecurrenceInput,
  recurrenceDates,
  sanitizeReusableScope,
} from "@/lib/partner-repeat-work";

const REPO_ROOT = resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);

function source(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

describe("partner repeat-work safety", () => {
  it("keeps reusable scope while recursively dropping secrets and stale commercial state", () => {
    expect(
      sanitizeReusableScope({
        itemCount: 12,
        rooms: ["office", "storage"],
        nested: {
          material: "cardboard",
          notes: "Use rear entrance\nGate code: 1234",
          gateCode: "1234",
          paymentToken: "provider-secret",
          approvalStatus: "accepted",
          quotedPrice: 99,
        },
        accessInstructions: "key under mat",
        holdId: "old-hold",
      }),
    ).toEqual({
      itemCount: 12,
      rooms: ["office", "storage"],
      nested: { material: "cardboard", notes: "Use rear entrance" },
    });
  });

  it("creates bounded weekly, biweekly, and month-based local dates", () => {
    expect(
      recurrenceDates(
        {
          templateId: "11111111-1111-4111-8111-111111111111",
          name: "Weekly service",
          frequency: "weekly",
          startsOn: "2026-09-01",
          occurrenceCount: 3,
          preferredWindowStart: "08:00",
        },
        "America/New_York",
      ),
    ).toEqual(["2026-09-01", "2026-09-08", "2026-09-15"]);
    expect(
      recurrenceDates(
        {
          templateId: "11111111-1111-4111-8111-111111111111",
          name: "Monthly service",
          frequency: "monthly",
          startsOn: "2026-01-15",
          occurrenceCount: 3,
          preferredWindowStart: null,
        },
        "America/New_York",
      ),
    ).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
  });

  it("rejects unsupported cadence fields and non-grid preferred times", () => {
    expect(() =>
      parseRecurrenceInput({
        templateId: "11111111-1111-4111-8111-111111111111",
        name: "Weekly service",
        frequency: "daily",
        startsOn: "2026-09-01",
        occurrenceCount: 100,
        preferredWindowStart: "08:15",
        reserveWithoutCapacityCheck: true,
      }),
    ).toThrow("Review the recurring schedule");
  });

  it("parses quoted CSV fields and emits downloadable row corrections", () => {
    expect(
      parseCsv('location_id,description\r\nabc,"Remove desks, chairs"\r\n'),
    ).toEqual([
      ["location_id", "description"],
      ["abc", "Remove desks, chairs"],
    ]);
    expect(
      correctionCsv([
        {
          rowNumber: 2,
          raw: {
            location_id: "abc",
            service_key: "junk_removal",
            description: "Remove items",
          },
          normalized: null,
          errors: [{ field: "contact_name", message: "Add a contact." }],
        },
      ]),
    ).toContain("contact_name: Add a contact.");
  });

  it("binds repeat-work persistence and routes to accounts and normal scheduling", () => {
    const migration = source(
      "apps/api/src/db/migrations/0120_partner_repeat_work.sql",
    );
    const service = source("apps/api/src/lib/partner-repeat-work.ts");
    const duplicateRoute = source(
      "apps/api/app/api/portal/v2/jobs/[jobId]/duplicate/route.ts",
    );
    const bulkRoute = source(
      "apps/api/app/api/portal/v2/bulk-imports/route.ts",
    );

    expect(migration).toContain(
      'FOREIGN KEY ("partner_account_id", "recurring_series_id")',
    );
    expect(migration).toContain('ON DELETE SET NULL ("booking_draft_id")');
    expect(migration).toContain(
      'FOREIGN KEY ("partner_account_id", "partner_bulk_import_id")',
    );
    expect(service).toContain("createOrReplacePartnerHold");
    expect(service).toContain("submitPartnerBookingDraft");
    expect(service).toContain("reservationCreated: false");
    expect(service).not.toContain("access_secret_ciphertext");
    expect(duplicateRoute).toContain('"bookings.create"');
    expect(duplicateRoute).toContain("Idempotency");
    expect(bulkRoute).toContain("maximumBytes: 600 * 1024");
    const recurringList = service.slice(
      service.indexOf("export async function listPartnerRecurringSeries"),
      service.indexOf("export function parseCsv"),
    );
    expect(recurringList).toContain('input.actor.accessLevel === "account"');
    expect(recurringList).toContain("partnerServiceTemplates.locationId");
    expect(recurringList).toContain("partnerAccountLocations.propertyId");
    expect(recurringList).toContain("or(...grants) ?? sql`false`");
    const templateList = service.slice(
      service.indexOf("export async function listPartnerServiceTemplates"),
      service.indexOf("export async function createPartnerServiceTemplate"),
    );
    expect(templateList).toContain('input.actor.accessLevel === "account"');
    expect(templateList).toContain("partnerAccountLocations.id");
    expect(templateList).toContain("partnerAccountLocations.propertyId");
    expect(templateList).toContain("or(...grants) ?? sql`false`");
  });

  it("exposes accessible repeat-work controls without claiming a reservation", () => {
    const ui = source(
      "apps/site/src/app/partners/components/PartnerRepeatWorkManager.tsx",
    );
    const jobActions = source(
      "apps/site/src/app/partners/components/PartnerJobActions.tsx",
    );
    expect(ui).toContain("File check complete");
    expect(ui).toContain("Review every row before saving requests");
    expect(ui).toContain("0</strong> capacity reservations");
    expect(ui).toContain('aria-live="polite"');
    expect(jobActions).toContain("Book again");
    expect(jobActions).toContain(
      "One-time access, pricing, approvals, photos, schedule holds, and payment details were not copied",
    );
  });
});

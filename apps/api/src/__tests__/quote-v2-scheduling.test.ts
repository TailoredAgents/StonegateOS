import fs from "node:fs";
import path from "node:path";
import {
  quoteV2CalendarCoverageIsCurrent,
  quoteV2CompletedDepositMatches,
  quoteV2PeakOccupiedCapacity,
  quoteV2SelfServiceContactPolicy,
} from "@/lib/quote-v2-scheduling-service";
import { parseQuoteV2OutboxEvent } from "@/lib/quote-v2-outbox-contract";

function source(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");
}

describe("Quote V2 scheduling invariants", () => {
  it("uses peak concurrent capacity instead of over-counting sequential blocks", () => {
    const startAt = new Date("2026-09-01T13:00:00.000Z");
    const endAt = new Date("2026-09-01T16:00:00.000Z");
    const sequential = quoteV2PeakOccupiedCapacity({
      startAt,
      endAt,
      blocks: [
        {
          id: "first",
          startAt,
          endAt: new Date("2026-09-01T14:00:00.000Z"),
          capacityUnits: 1,
        },
        {
          id: "second",
          startAt: new Date("2026-09-01T14:00:00.000Z"),
          endAt: new Date("2026-09-01T15:00:00.000Z"),
          capacityUnits: 1,
        },
      ],
    });
    const overlapping = quoteV2PeakOccupiedCapacity({
      startAt,
      endAt,
      blocks: [
        {
          id: "crew-a",
          startAt,
          endAt: new Date("2026-09-01T15:00:00.000Z"),
          capacityUnits: 1,
        },
        {
          id: "crew-b",
          startAt: new Date("2026-09-01T14:00:00.000Z"),
          endAt: new Date("2026-09-01T16:00:00.000Z"),
          capacityUnits: 2,
        },
      ],
    });

    expect(sequential).toBe(1);
    expect(overlapping).toBe(3);
  });

  it("requires an exact, unreimbursed, non-late Square deposit", () => {
    const exact = {
      expectedCents: 25_000,
      provider: "square",
      currency: "USD",
      canonicalStatus: "completed",
      amountCents: 25_000,
      jobAmountCents: 25_000,
      totalAmountCents: 25_000,
      tipCents: 0,
      refundedAmountCents: 0,
      attemptStatus: "completed",
      lateCapture: false,
    };
    expect(quoteV2CompletedDepositMatches(exact)).toBe(true);
    expect(
      quoteV2CompletedDepositMatches({ ...exact, amountCents: 24_999 }),
    ).toBe(false);
    expect(
      quoteV2CompletedDepositMatches({ ...exact, refundedAmountCents: 1 }),
    ).toBe(false);
    expect(
      quoteV2CompletedDepositMatches({ ...exact, lateCapture: true }),
    ).toBe(false);
    expect(quoteV2CompletedDepositMatches({ ...exact, tipCents: 100 })).toBe(
      false,
    );
  });

  it("distinguishes current external-busy coverage from provider unavailability", () => {
    const now = new Date("2026-09-01T13:00:00.000Z");
    const current = {
      now,
      staleMinutes: 15,
      lastSyncedAt: new Date("2026-09-01T12:55:00.000Z"),
      externalBusyCoverageSyncedAt: new Date("2026-09-01T12:55:00.000Z"),
      lastNotificationAt: new Date("2026-09-01T12:54:00.000Z"),
    };
    expect(quoteV2CalendarCoverageIsCurrent(current)).toBe(true);
    expect(
      quoteV2CalendarCoverageIsCurrent({
        ...current,
        externalBusyCoverageSyncedAt: new Date("2026-09-01T12:44:59.000Z"),
      }),
    ).toBe(false);
    expect(
      quoteV2CalendarCoverageIsCurrent({
        ...current,
        lastNotificationAt: new Date("2026-09-01T12:56:00.000Z"),
      }),
    ).toBe(false);
  });

  it("revokes deleted-contact scheduling without conflating DNC with self-service", () => {
    expect(
      quoteV2SelfServiceContactPolicy({
        deletedAt: new Date("2026-09-01T12:00:00.000Z"),
        doNotContact: false,
      }),
    ).toEqual({
      allowCustomerScheduling: false,
      allowOutboundConfirmation: false,
      revokeCapabilities: true,
    });
    expect(
      quoteV2SelfServiceContactPolicy({
        deletedAt: null,
        doNotContact: true,
      }),
    ).toEqual({
      allowCustomerScheduling: true,
      allowOutboundConfirmation: false,
      revokeCapabilities: false,
    });
  });

  it("accepts the ID-only combined booking event and rejects customer data", () => {
    const payload = {
      schemaVersion: 2 as const,
      eventId: "11111111-1111-4111-8111-111111111111",
      quoteId: "22222222-2222-4222-8222-222222222222",
      versionId: "33333333-3333-4333-8333-333333333333",
      responseId: "44444444-4444-4444-8444-444444444444",
      appointmentId: "55555555-5555-4555-8555-555555555555",
      holdId: "66666666-6666-4666-8666-666666666666",
      paymentAttemptId: null,
      paymentId: null,
      correlationId: "correlation-1234",
      occurredAt: "2026-09-01T13:00:00.000Z",
    };
    expect(
      parseQuoteV2OutboxEvent({
        type: "quote.accepted_and_booked.v2",
        payload,
      }),
    ).toMatchObject({ payload });
    expect(() =>
      parseQuoteV2OutboxEvent({
        type: "quote.accepted_and_booked.v2",
        payload: { ...payload, customerEmail: "client@example.test" },
      }),
    ).toThrow("prohibited field");
  });

  it("branches into V2 before every legacy bearer-token scheduling lookup", () => {
    const availability = source(
      "app/api/public/quotes/[token]/availability/route.ts",
    );
    const hold = source("app/api/public/quotes/[token]/hold/route.ts");
    const book = source("app/api/public/quotes/[token]/book/route.ts");

    expect(
      availability.indexOf("maybeHandleQuoteV2Availability(request, token)"),
    ).toBeLessThan(availability.indexOf("loadPublicQuoteForScheduling(token)"));
    expect(hold.indexOf("maybeHandleQuoteV2Hold(request, token)")).toBeLessThan(
      hold.indexOf("loadPublicQuoteForScheduling(token)"),
    );
    expect(book.indexOf("maybeHandleQuoteV2Book(request, token)")).toBeLessThan(
      book.indexOf("loadPublicQuoteForScheduling(token)"),
    );

    const service = source("src/lib/quote-v2-scheduling-service.ts");
    expect(service).toContain("loadQuoteV2CapabilityByHash");
    expect(
      service.match(/enforceQuoteV2SchedulingContactPolicy\(/gu),
    ).toHaveLength(4);
    expect(service).not.toContain(".update(quoteCapabilities)");
    const contactDeletion = source(
      "app/api/admin/contacts/[contactId]/route.ts",
    );
    expect(contactDeletion).toContain(".update(quoteCapabilities)");
    expect(contactDeletion).toContain('revocationReason: "contact_inactive"');
    expect(contactDeletion).toContain(
      "quoteCapabilitiesRevokedCount: revokedQuoteCapabilities.length",
    );
    expect(service).not.toMatch(/shareToken|share_token/u);
    expect(service).toContain(".update(quoteResponses)");
    expect(service).toContain("isNull(quoteResponses.appointmentId)");
    expect(service).toContain("appointmentId: appointment.id");
    expect(service).toContain("schedulingTimezone: context.timezone");
    expect(service).toContain("acquireScheduleConflictLock");
    expect(service).toContain("scheduleBlocks");
    expect(service).toContain('type: "quote.accepted_and_booked.v2"');
    expect(service).toContain("transaction?: TeamMutationTransaction");
    const publicService = source("src/lib/quote-v2-public-service.ts");
    const terminalResponseLookup = publicService.slice(
      publicService.indexOf("responseRows,"),
      publicService.indexOf("const opportunity = opportunityRows[0]"),
    );
    expect(terminalResponseLookup).toContain(
      "eq(quoteResponses.quoteId, row.quoteId)",
    );
    expect(terminalResponseLookup).toContain(
      "eq(quoteResponses.quoteVersionId, row.versionId)",
    );
    const holdService = service.slice(
      service.indexOf("export async function createQuoteV2AppointmentHold"),
      service.indexOf("export async function bookQuoteV2AcceptedResponse"),
    );
    const bookService = service.slice(
      service.indexOf("export async function bookQuoteV2AcceptedResponse"),
    );
    expect(holdService.indexOf("readReceipt(tx")).toBeLessThan(
      holdService.indexOf('assertSchedulingAction(row, "hold"'),
    );
    expect(bookService.indexOf("readReceipt(tx")).toBeLessThan(
      bookService.indexOf('assertSchedulingAction(row, "book"'),
    );
    const publicRoute = source("src/lib/quote-v2-public-route.ts");
    expect(publicRoute).toContain("afterAcceptance: async (tx, accepted)");
    expect(publicRoute).toContain("transaction: tx");
  });

  it("migrates exact appointment evidence and enforces one response booking", () => {
    const migration = source(
      "src/db/migrations/0118_quote_v2_appointment_evidence.sql",
    );
    expect(migration).toContain('ADD COLUMN "quote_response_id" uuid');
    expect(migration).toContain('ADD COLUMN "quoted_total_max_cents" integer');
    expect(migration).toContain('"quote_configuration_hash" ~');
    expect(migration).toContain('"quote_content_hash" ~');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "appointments_quote_response_key"',
    );

    const timezoneMigration = source(
      "src/db/migrations/0129_quote_v2_appointment_timezone.sql",
    );
    expect(timezoneMigration).toContain(
      'ADD COLUMN "scheduling_timezone" varchar(64)',
    );
    expect(timezoneMigration).toContain(
      'CONSTRAINT "appointments_quote_scheduling_timezone_check"',
    );
    expect(timezoneMigration).toContain(
      'CREATE UNIQUE INDEX "quote_responses_appointment_key"',
    );
    expect(timezoneMigration).toContain(
      'ON "quote_responses" ("appointment_id")',
    );

    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const timezoneEntry = journal.entries.find(
      (entry) => entry.tag === "0129_quote_v2_appointment_timezone",
    );
    expect(timezoneEntry).toEqual({
      idx: 126,
      when: 1_792_022_400_000,
      tag: "0129_quote_v2_appointment_timezone",
      breakpoints: true,
      version: "7",
    });
    const priorEntry = journal.entries.find((entry) => entry.idx === 125);
    expect(priorEntry?.tag).toBe("0128_quote_v2_expired_refresh_request");
    expect(timezoneEntry?.when).toBeGreaterThan(priorEntry?.when ?? 0);

    const responseLinkMigration = source(
      "src/db/migrations/0130_quote_v2_response_appointment_binding.sql",
    );
    expect(responseLinkMigration).toContain('OLD."appointment_id" IS NULL');
    expect(responseLinkMigration).toContain(
      "OLD.\"response_type\" = 'accepted'",
    );
    expect(responseLinkMigration).toContain('NEW."appointment_id" IS NOT NULL');
    expect(responseLinkMigration).toContain("to_jsonb(NEW) - 'appointment_id'");
    expect(responseLinkMigration).toContain(
      'appointment."quote_response_id" = OLD."id"',
    );
    expect(responseLinkMigration).toContain(
      'appointment."quote_version_id" = OLD."quote_version_id"',
    );
    expect(responseLinkMigration).toContain(
      'appointment."contact_id" = quote."contact_id"',
    );
    expect(responseLinkMigration).toContain(
      'appointment."property_id" IS NOT DISTINCT FROM quote."property_id"',
    );
    expect(responseLinkMigration).toContain(
      'BEFORE UPDATE OR DELETE ON "quote_responses"',
    );
    const responseLinkEntry = journal.entries.find(
      (entry) => entry.tag === "0130_quote_v2_response_appointment_binding",
    );
    expect(responseLinkEntry).toMatchObject({
      idx: 127,
      when: 1_792_108_800_000,
    });
    expect(responseLinkEntry?.when).toBeGreaterThan(timezoneEntry?.when ?? 0);
  });
});

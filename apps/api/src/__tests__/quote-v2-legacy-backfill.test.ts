import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  legacyDecimalToCents,
  prepareLegacyQuoteBackfill,
  quoteVersionBackfillLifecyclePath,
  revokePreparedLegacyCapabilityForInactiveContact,
  runQuoteV2LegacyBackfill,
  type LegacyQuoteBackfillCursor,
  type LegacyQuoteBackfillRow,
  type PreparedLegacyQuoteBackfill,
  type QuoteV2BackfillCheckpoint,
  type QuoteV2LegacyBackfillStore,
} from "@/lib/quote-v2-legacy-backfill";

const CREATED_AT = new Date("2026-08-01T14:00:00.000Z");
const SENT_AT = new Date("2026-08-02T14:00:00.000Z");
const EXPIRES_AT = new Date("2026-09-02T14:00:00.000Z");
const NOW = new Date("2026-08-30T16:00:00.000Z");
const RECIPIENT_HMAC_SECRET = "quote-backfill-test-secret-00000000000000000000";

function legacyRow(
  overrides: Partial<LegacyQuoteBackfillRow> = {},
): LegacyQuoteBackfillRow {
  const id = overrides.id ?? "11111111-1111-4111-8111-111111111111";
  return {
    id,
    contactId: "22222222-2222-4222-8222-222222222222",
    propertyId: "33333333-3333-4333-8333-333333333333",
    status: "accepted",
    services: ["junk-removal"],
    addOns: ["stairs"],
    surfaceArea: "500",
    zoneId: "zone-1",
    travelFee: "25.00",
    discounts: "100.00",
    addOnsTotal: "50.00",
    subtotal: "1300.00",
    total: "1200.00",
    depositDue: "300.00",
    depositRate: "0.25",
    balanceDue: "900.00",
    lineItems: [
      {
        id: "service-junk",
        label: "Junk removal",
        amount: 1150,
        category: "service",
      },
      { id: "addon-stairs", label: "Stairs", amount: 50, category: "add-on" },
      {
        id: "bundle-discount",
        label: "Discount",
        amount: -100,
        category: "discount",
      },
    ],
    availability: { state: "available" },
    marketing: { source: "referral" },
    notes: "Internal legacy note",
    quoteNumber: "Q-2026-1001",
    jobDurationMinutes: 180,
    clientScope: "Remove warehouse contents",
    revision: 3,
    shareToken: "legacy-secret-bearer-token",
    sentAt: SENT_AT,
    expiresAt: EXPIRES_AT,
    viewedAt: new Date("2026-08-03T14:00:00.000Z"),
    lastViewedAt: new Date("2026-08-04T14:00:00.000Z"),
    viewCount: 2,
    decisionAt: new Date("2026-08-05T14:00:00.000Z"),
    decisionNotes: "Approved by client",
    refreshRequestedAt: null,
    acceptedAppointmentId: "44444444-4444-4444-8444-444444444444",
    createdAt: CREATED_AT,
    updatedAt: new Date("2026-08-05T14:00:00.000Z"),
    contact: {
      firstName: "Avery",
      lastName: "Nguyen",
      company: "Northwind Logistics",
      email: "avery@example.com",
      phone: null,
      phoneE164: "+14155550123",
      salespersonMemberId: "55555555-5555-4555-8555-555555555555",
      deletedAt: null,
    },
    property: {
      addressLine1: "10 Commerce Way",
      addressLine2: "Dock 4",
      city: "Boston",
      state: "MA",
      postalCode: "02110",
      legacyContactId: "22222222-2222-4222-8222-222222222222",
    },
    linkedLeadCandidates: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        contactId: "22222222-2222-4222-8222-222222222222",
        propertyId: "33333333-3333-4333-8333-333333333333",
      },
    ],
    hasCanonicalContactPropertyLink: true,
    ownerTeamMemberExists: true,
    quoteNumberCollision: false,
    activeHoldCount: 0,
    acceptedAppointmentReferenceCount: 1,
    ...overrides,
  };
}

class MemoryBackfillStore implements QuoteV2LegacyBackfillStore {
  readonly imported = new Map<string, PreparedLegacyQuoteBackfill>();
  readonly reviews: PreparedLegacyQuoteBackfill[] = [];
  readonly calls = {
    start: 0,
    persist: 0,
    advance: 0,
    complete: 0,
    fail: 0,
  };
  checkpoint: QuoteV2BackfillCheckpoint = { status: "pending", cursor: null };
  failAfterFirstCommit = false;
  private didFail = false;

  constructor(readonly rows: LegacyQuoteBackfillRow[]) {}

  startCheckpoint(): Promise<QuoteV2BackfillCheckpoint> {
    this.calls.start += 1;
    if (this.checkpoint.status !== "completed")
      this.checkpoint.status = "running";
    return Promise.resolve({ ...this.checkpoint });
  }

  loadBatch(input: {
    cursor: LegacyQuoteBackfillCursor | null;
    limit: number;
  }): Promise<LegacyQuoteBackfillRow[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => {
          if (!input.cursor) return true;
          const timestampOrder = row.createdAt
            .toISOString()
            .localeCompare(input.cursor.createdAt);
          return (
            timestampOrder > 0 ||
            (timestampOrder === 0 && row.id > input.cursor.id)
          );
        })
        .sort(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id),
        )
        .slice(0, input.limit),
    );
  }

  persistPreparedQuote(prepared: PreparedLegacyQuoteBackfill) {
    this.calls.persist += 1;
    if (this.imported.has(prepared.quoteId)) {
      return Promise.resolve({ outcome: "skipped" as const });
    }
    this.imported.set(prepared.quoteId, prepared);
    if (prepared.reviews.length > 0) this.reviews.push(prepared);
    if (this.failAfterFirstCommit && !this.didFail) {
      this.didFail = true;
      return Promise.reject(
        new Error("simulated process interruption after durable row commit"),
      );
    }
    return Promise.resolve({
      outcome:
        prepared.reviews.length > 0
          ? ("review" as const)
          : ("migrated" as const),
    });
  }

  advanceCheckpoint(input: {
    cursor: LegacyQuoteBackfillCursor;
    status: "running" | "paused";
  }): Promise<void> {
    this.calls.advance += 1;
    this.checkpoint = { status: input.status, cursor: input.cursor };
    return Promise.resolve();
  }

  completeCheckpoint(input: {
    cursor: LegacyQuoteBackfillCursor | null;
  }): Promise<void> {
    this.calls.complete += 1;
    this.checkpoint = { status: "completed", cursor: input.cursor };
    return Promise.resolve();
  }

  failCheckpoint(): Promise<void> {
    this.calls.fail += 1;
    this.checkpoint.status = "failed";
    return Promise.resolve();
  }
}

describe("Quote V2 legacy backfill", () => {
  test("converts PostgreSQL numerics to cents without binary floating-point drift", () => {
    expect(legacyDecimalToCents("12.344")).toEqual({
      cents: 1234,
      valid: true,
      rounded: true,
    });
    expect(legacyDecimalToCents("12.345")).toEqual({
      cents: 1235,
      valid: true,
      rounded: true,
    });
    expect(legacyDecimalToCents("-0.005").cents).toBe(-1);
    expect(legacyDecimalToCents("1e6").valid).toBe(false);
    expect(legacyDecimalToCents("not-money").valid).toBe(false);
  });

  test("prepares one deterministic opportunity and honest imported version", () => {
    const row = legacyRow();
    const first = prepareLegacyQuoteBackfill(row, {
      now: NOW,
      recipientHashSecret: RECIPIENT_HMAC_SECRET,
    });
    const replay = prepareLegacyQuoteBackfill(row, {
      now: NOW,
      recipientHashSecret: RECIPIENT_HMAC_SECRET,
    });

    expect(first.opportunity.id).toBe(replay.opportunity.id);
    expect(first.version.id).toBe(replay.version.id);
    expect(first.capability?.id).toBe(replay.capability?.id);
    expect(first.opportunity.leadId).toBe(
      "66666666-6666-4666-8666-666666666666",
    );
    expect(first.opportunity.ownerTeamMemberId).toBe(
      "55555555-5555-4555-8555-555555555555",
    );
    expect(first.opportunity.status).toBe("approved");
    expect(first.version.targetState).toBe("accepted");
    expect(first.version.provenance).toBe("legacy_current_state");
    expect(first.version.documentSnapshot).toMatchObject({
      evidenceQuality: "legacy_imported_incomplete",
      exactOriginallySentDocumentReconstructable: false,
      exactAcceptanceEvidenceAvailable: false,
      legacyStatus: "accepted",
    });
    expect(first.version.totalMinCents).toBe(120_000);
    expect(first.version.subtotalMinCents).toBe(130_000);
    expect(first.version.discountMinCents).toBe(10_000);
    expect(first.version.depositCents).toBe(30_000);
    expect(first.version.balanceMinCents).toBe(90_000);
    expect(first.version.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.capability?.allowedActions).toEqual(["view", "pdf"]);
    expect(first.quotePatch.aggregateState).toBe("accepted");
    expect(first.reviews).toEqual([]);

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(row.shareToken);
    expect(first.capability?.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toHaveProperty("sendAttempts");
    expect(first).not.toHaveProperty("responses");
    expect(first.version.documentSnapshot).not.toHaveProperty(
      "acceptanceEvidence",
    );
  });

  test("normalizes dirty legacy values and routes every ambiguity or duplicate to review", () => {
    const row = legacyRow({
      status: "sent",
      services: ["junk-removal", "junk-removal"],
      addOns: ["stairs", "stairs"],
      subtotal: "100.00",
      discounts: "20.00",
      total: "95.00",
      depositDue: "200.00",
      balanceDue: "5.00",
      lineItems: [
        { id: "same", label: "First", amount: "50.00", category: "service" },
        { id: "same", label: "Second", amount: "45.00", category: "service" },
        { id: "bad", label: "Bad", amount: "invalid", category: "service" },
      ],
      quoteNumberCollision: true,
      hasCanonicalContactPropertyLink: false,
      property: {
        ...legacyRow().property,
        legacyContactId: "77777777-7777-4777-8777-777777777777",
      },
      linkedLeadCandidates: [
        ...legacyRow().linkedLeadCandidates,
        {
          id: "88888888-8888-4888-8888-888888888888",
          contactId: "77777777-7777-4777-8777-777777777777",
          propertyId: "33333333-3333-4333-8333-333333333333",
        },
      ],
      ownerTeamMemberExists: false,
      activeHoldCount: 2,
      acceptedAppointmentReferenceCount: 2,
    });
    const prepared = prepareLegacyQuoteBackfill(row, {
      now: NOW,
      recipientHashSecret: RECIPIENT_HMAC_SECRET,
    });
    const reasons = new Set(
      prepared.reviews.map((review) => review.reasonCode),
    );

    expect(reasons).toEqual(
      new Set([
        "quote_number_collision",
        "duplicate_active_hold",
        "duplicate_accepted_appointment_reference",
        "ambiguous_property_association",
        "duplicate_lead_association",
        "ambiguous_lead_association",
        "invalid_owner_reference",
        "duplicate_service_identifier",
        "duplicate_add_on_identifier",
        "invalid_total_equation",
        "invalid_deposit_equation",
        "duplicate_line_item_key",
        "invalid_line_item",
      ]),
    );
    expect(prepared.version.totalMinCents).toBe(9_500);
    expect(prepared.version.discountMinCents).toBe(2_000);
    expect(prepared.version.subtotalMinCents).toBe(11_500);
    expect(prepared.version.depositCents).toBe(9_500);
    expect(prepared.version.balanceMinCents).toBe(0);
    expect(
      prepared.version.subtotalMinCents - prepared.version.discountMinCents,
    ).toBe(prepared.version.totalMinCents);
    expect(prepared.lineItems.map((line) => line.lineKey)).toEqual([
      "same",
      "same-2",
    ]);
    expect(prepared.opportunity.leadId).toBe(
      "66666666-6666-4666-8666-666666666666",
    );
    expect(prepared.opportunity.ownerTeamMemberId).toBeNull();
  });

  test("does not manufacture an issued version when required legacy evidence is invalid", () => {
    const prepared = prepareLegacyQuoteBackfill(
      legacyRow({
        status: "sent",
        total: "0",
        subtotal: "0",
        discounts: "0",
        depositDue: "0",
        balanceDue: "0",
        sentAt: null,
        expiresAt: null,
      }),
      { now: NOW, recipientHashSecret: RECIPIENT_HMAC_SECRET },
    );

    expect(prepared.version.targetState).toBe("draft");
    expect(prepared.version.issuedAt).toBeNull();
    expect(prepared.version.expiresAt).toBeNull();
    expect(prepared.quotePatch.aggregateState).toBe("draft");
    expect(prepared.quotePatch.publishedVersionId).toBeNull();
    expect(prepared.reviews.map((review) => review.reasonCode)).toEqual(
      expect.arrayContaining([
        "invalid_zero_total",
        "invalid_expiry",
        "legacy_state_not_issueable",
      ]),
    );
  });

  test("uses a keyed deterministic capability identity when legacy recipient data is absent", () => {
    const row = legacyRow({
      status: "sent",
      contact: {
        ...legacyRow().contact,
        email: null,
        phone: null,
        phoneE164: null,
      },
    });
    const prepared = prepareLegacyQuoteBackfill(row, {
      now: NOW,
      recipientHashSecret: RECIPIENT_HMAC_SECRET,
    });
    const withDifferentKey = prepareLegacyQuoteBackfill(row, {
      now: NOW,
      recipientHashSecret: "different-quote-backfill-secret-0000000000000000",
    });

    expect(prepared.capability?.recipientAddressHash).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(prepared.capability?.recipientAddressHash).not.toBe(
      withDifferentKey.capability?.recipientAddressHash,
    );
    expect(prepared.reviews.map((review) => review.reasonCode)).toContain(
      "ambiguous_capability_recipient",
    );
    expect(JSON.stringify(prepared)).not.toContain(row.shareToken);
  });

  test("imports a deleted contact's legacy URL revoked when backfill runs after 0126", () => {
    const deletedAt = new Date("2026-08-20T12:00:00.000Z");
    const row = legacyRow({
      status: "sent",
      contact: { ...legacyRow().contact, deletedAt },
    });
    const prepared = prepareLegacyQuoteBackfill(row, {
      now: NOW,
      recipientHashSecret: RECIPIENT_HMAC_SECRET,
    });
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "src/db/migrations/0126_quote_v2_engagement_retention.sql",
      ),
      "utf8",
    );

    expect(migration).toContain('UPDATE "quote_capabilities" AS capability');
    expect(prepared.capability).toMatchObject({
      status: "revoked",
      allowedActions: ["view", "pdf"],
      actionExpiresAt: null,
      revocationReason: "contact_inactive",
      revokedAt: NOW,
    });
    expect(prepared.capability?.readExpiresAt.getTime()).toBeGreaterThan(
      prepared.capability?.issuedAt.getTime() ?? Number.MAX_SAFE_INTEGER,
    );
  });

  test("forces a stale active snapshot revoked when contact deletion wins persistence", () => {
    const prepared = prepareLegacyQuoteBackfill(legacyRow({ status: "sent" }), {
      now: NOW,
      recipientHashSecret: RECIPIENT_HMAC_SECRET,
    });
    const activeCapability = prepared.capability;
    expect(activeCapability?.status).toBe("active");
    expect(activeCapability?.allowedActions).toContain("accept");
    if (!activeCapability) throw new Error("Expected a legacy capability.");

    const deletionWonAt = new Date(NOW.getTime() + 60_000);
    const reconciled = revokePreparedLegacyCapabilityForInactiveContact(
      activeCapability,
      deletionWonAt,
    );

    expect(reconciled).toMatchObject({
      status: "revoked",
      allowedActions: ["view", "pdf"],
      actionExpiresAt: null,
      revokedAt: deletionWonAt,
      revocationReason: "contact_inactive",
    });
    expect(activeCapability.status).toBe("active");
  });

  test("serializes database persistence with deletion before inserting a capability", () => {
    const databaseStore = readFileSync(
      resolve(process.cwd(), "src/lib/quote-v2-legacy-backfill-db.ts"),
      "utf8",
    );
    const candidate = databaseStore.indexOf("const [candidateQuote]");
    const advisoryLock = databaseStore.indexOf(
      "pg_advisory_xact_lock(hashtextextended(${candidateQuote.contactId}, 0))",
      candidate,
    );
    const authoritativeRead = databaseStore.indexOf(
      "const [lockedQuote]",
      advisoryLock,
    );
    const liveDeletionReconciliation = databaseStore.indexOf(
      "prepared.capability && lockedQuote.contactDeletedAt",
      authoritativeRead,
    );
    const capabilityInsert = databaseStore.indexOf(
      ".insert(quoteCapabilities)",
      liveDeletionReconciliation,
    );

    expect(databaseStore).toContain("contactDeletedAt: contacts.deletedAt");
    expect(databaseStore).toContain("deletedAt: row.contactDeletedAt");
    expect(candidate).toBeGreaterThan(0);
    expect(advisoryLock).toBeGreaterThan(candidate);
    expect(authoritativeRead).toBeGreaterThan(advisoryLock);
    expect(liveDeletionReconciliation).toBeGreaterThan(authoritativeRead);
    expect(capabilityInsert).toBeGreaterThan(liveDeletionReconciliation);
  });

  test("keeps action read access beyond a long legacy validity window", () => {
    const prepared = prepareLegacyQuoteBackfill(
      legacyRow({
        status: "sent",
        expiresAt: new Date("2027-02-01T14:00:00.000Z"),
      }),
      { now: NOW, recipientHashSecret: RECIPIENT_HMAC_SECRET },
    );

    expect(prepared.capability?.allowedActions).toContain("accept");
    expect(prepared.capability?.actionExpiresAt?.getTime()).toBeLessThan(
      prepared.capability?.readExpiresAt.getTime() ?? 0,
    );
  });

  test("preserves an expired legacy URL as a version-bound refresh-only signer capability", () => {
    const prepared = prepareLegacyQuoteBackfill(
      legacyRow({
        status: "sent",
        expiresAt: new Date("2026-08-20T14:00:00.000Z"),
      }),
      { now: NOW, recipientHashSecret: RECIPIENT_HMAC_SECRET },
    );

    expect(prepared.version.targetState).toBe("expired");
    expect(prepared.quotePatch.aggregateState).toBe("open");
    expect(prepared.capability).toMatchObject({
      recipientRole: "signer",
      status: "active",
      allowedActions: ["view", "pdf", "refresh"],
      actionExpiresAt: null,
    });
    expect(prepared.capability?.readExpiresAt.getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
  });

  test("does not duplicate a proven legacy expired refresh request", () => {
    const prepared = prepareLegacyQuoteBackfill(
      legacyRow({
        status: "sent",
        expiresAt: new Date("2026-08-20T14:00:00.000Z"),
        refreshRequestedAt: new Date("2026-08-25T14:00:00.000Z"),
      }),
      { now: NOW, recipientHashSecret: RECIPIENT_HMAC_SECRET },
    );

    expect(prepared.version.targetState).toBe("expired");
    expect(prepared.capability).toMatchObject({
      allowedActions: ["view", "pdf"],
      actionExpiresAt: null,
    });
    expect(prepared.version.documentSnapshot).toMatchObject({
      lifecycle: {
        refreshRequestedAt: "2026-08-25T14:00:00.000Z",
      },
    });
  });

  test("uses legal draft-to-terminal lifecycle paths for immutable imports", () => {
    expect(quoteVersionBackfillLifecyclePath("draft")).toEqual([]);
    expect(quoteVersionBackfillLifecyclePath("issued")).toEqual([
      "ready",
      "issued",
    ]);
    expect(quoteVersionBackfillLifecyclePath("accepted")).toEqual([
      "ready",
      "issued",
      "accepted",
    ]);
  });

  test("pauses at a batch checkpoint and resumes without duplicate imports", async () => {
    const rows = [
      legacyRow({ id: "11111111-1111-4111-8111-111111111111" }),
      legacyRow({
        id: "11111111-1111-4111-8111-111111111112",
        createdAt: new Date(CREATED_AT.getTime() + 1_000),
      }),
      legacyRow({
        id: "11111111-1111-4111-8111-111111111113",
        createdAt: new Date(CREATED_AT.getTime() + 2_000),
      }),
    ];
    const store = new MemoryBackfillStore(rows);

    const first = await runQuoteV2LegacyBackfill({
      store,
      now: NOW,
      batchSize: 2,
      maxBatches: 1,
      recipientHashSecret: RECIPIENT_HMAC_SECRET,
    });
    expect(first).toMatchObject({
      status: "paused",
      scannedCount: 2,
      migratedCount: 2,
      batches: 1,
    });
    expect(store.imported.size).toBe(2);
    expect(store.checkpoint.status).toBe("paused");

    const second = await runQuoteV2LegacyBackfill({
      store,
      now: NOW,
      batchSize: 2,
      maxBatches: 5,
      recipientHashSecret: RECIPIENT_HMAC_SECRET,
    });
    expect(second).toMatchObject({
      status: "completed",
      scannedCount: 1,
      migratedCount: 1,
    });
    expect(store.imported.size).toBe(3);
    expect(store.checkpoint.status).toBe("completed");
  });

  test("replays safely after interruption between a row commit and checkpoint update", async () => {
    const rows = [
      legacyRow({ id: "11111111-1111-4111-8111-111111111111" }),
      legacyRow({
        id: "11111111-1111-4111-8111-111111111112",
        createdAt: new Date(CREATED_AT.getTime() + 1_000),
      }),
    ];
    const store = new MemoryBackfillStore(rows);
    store.failAfterFirstCommit = true;

    await expect(
      runQuoteV2LegacyBackfill({
        store,
        now: NOW,
        batchSize: 2,
        recipientHashSecret: RECIPIENT_HMAC_SECRET,
      }),
    ).rejects.toThrow("simulated process interruption");
    expect(store.imported.size).toBe(1);
    expect(store.calls.fail).toBe(1);
    expect(store.checkpoint.cursor).toBeNull();

    const resumed = await runQuoteV2LegacyBackfill({
      store,
      now: NOW,
      batchSize: 2,
      recipientHashSecret: RECIPIENT_HMAC_SECRET,
    });
    expect(resumed).toMatchObject({
      status: "completed",
      scannedCount: 2,
      migratedCount: 1,
      skippedCount: 1,
    });
    expect(store.imported.size).toBe(2);
  });

  test("dry-run scans and classifies without creating a checkpoint or writing rows", async () => {
    const store = new MemoryBackfillStore([
      legacyRow(),
      legacyRow({
        id: "11111111-1111-4111-8111-111111111112",
        quoteNumber: null,
        createdAt: new Date(CREATED_AT.getTime() + 1_000),
      }),
    ]);
    const summary = await runQuoteV2LegacyBackfill({
      store,
      dryRun: true,
      now: NOW,
      batchSize: 1,
      recipientHashSecret: RECIPIENT_HMAC_SECRET,
    });

    expect(summary).toMatchObject({
      dryRun: true,
      status: "completed",
      scannedCount: 2,
      migratedCount: 1,
      reviewCount: 1,
    });
    expect(store.calls).toEqual({
      start: 0,
      persist: 0,
      advance: 0,
      complete: 0,
      fail: 0,
    });
    expect(store.imported.size).toBe(0);
  });
});

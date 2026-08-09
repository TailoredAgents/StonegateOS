import fs from "node:fs";
import path from "node:path";
import {
  assessContactMergeRecovery,
  buildContactConsolidationPlan,
  buildMergePreviewHash,
  compareContactMergeRecoveryBaseline,
  compareContactMergeRecoveryEvidence,
  contactMergeInventoryEvidenceFailures,
  contactMergeOperationSafetyFailures,
  CONTACT_MERGE_DEPENDENCY_RULES,
  CONTACT_MERGE_RULE_VERSION,
  mergeDependencyRule,
  parseContactMergeReviewPayload,
  parseContactMergeScanOptions,
  parseManualContactMergePayload,
  stableMergeJson,
} from "../lib/contact-merge-contract";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const VERSION = "2026-08-08T12:00:00.000Z";
const HASH = "a".repeat(64);

describe("contact merge preview contract", () => {
  it("canonicalizes object keys before hashing a complete preview", () => {
    const first = {
      contacts: {
        source: { id: "source", version: 2 },
        target: { id: "target", version: 4 },
      },
      dependencies: [{ type: "quotes", id: "quote-1" }],
    };
    const reordered = {
      dependencies: [{ id: "quote-1", type: "quotes" }],
      contacts: {
        target: { version: 4, id: "target" },
        source: { version: 2, id: "source" },
      },
    };

    expect(stableMergeJson(first)).toBe(stableMergeJson(reordered));
    expect(buildMergePreviewHash(first)).toBe(buildMergePreviewHash(reordered));
    expect(buildMergePreviewHash(first)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("changes the preview hash when contact or dependency state changes", () => {
    const baseline = {
      sourceVersion: 1,
      rows: [{ id: "quote-1", owner: "source" }],
    };
    expect(buildMergePreviewHash(baseline)).not.toBe(
      buildMergePreviewHash({ ...baseline, sourceVersion: 2 }),
    );
    expect(buildMergePreviewHash(baseline)).not.toBe(
      buildMergePreviewHash({
        ...baseline,
        rows: [{ id: "quote-1", owner: "target" }],
      }),
    );
  });

  it("applies deterministic target-wins identity rules and deny-wins DNC", () => {
    const plan = buildContactConsolidationPlan(
      {
        company: "Source Company",
        email: "source@example.com",
        phone: "4045550100",
        phoneE164: "+14045550100",
        salespersonMemberId: "source-owner",
        doNotContact: true,
        doNotContactAt: new Date("2026-08-08T10:00:00.000Z"),
        doNotContactBy: "source-reviewer",
        doNotContactReason: "customer_request",
        preferredContactMethod: "sms",
        source: "referral",
      },
      {
        company: "Target Company",
        email: null,
        phone: "4045550199",
        phoneE164: "+14045550199",
        salespersonMemberId: null,
        doNotContact: false,
        doNotContactAt: null,
        doNotContactBy: null,
        doNotContactReason: null,
        preferredContactMethod: "email",
        source: null,
      },
    );

    expect(plan.ruleVersion).toBe(CONTACT_MERGE_RULE_VERSION);
    expect(plan.targetPatch).toMatchObject({
      email: "source@example.com",
      salespersonMemberId: "source-owner",
      source: "referral",
      doNotContact: true,
      doNotContactBy: "source-reviewer",
      doNotContactReason: "customer_request",
    });
    expect(plan.targetPatch).not.toHaveProperty("company");
    expect(plan.targetPatch).not.toHaveProperty("phone");
    expect(plan.uniqueDependencies).toBe(
      "target_wins_source_preserved_in_ledger",
    );
    expect(plan.historicalEvidence).toBe("retained_on_soft_deleted_source");
  });

  it("requires every discovered dependency to have an explicit reviewed rule", () => {
    expect(CONTACT_MERGE_DEPENDENCY_RULES.length).toBeGreaterThan(20);
    for (const rule of CONTACT_MERGE_DEPENDENCY_RULES) {
      expect(mergeDependencyRule(rule.key)).toEqual(rule);
    }
    expect(mergeDependencyRule("future_table.contact_id")).toBeNull();
    expect(
      mergeDependencyRule("partner_users.org_contact_id")?.disposition,
    ).toBe("block");
    expect(
      mergeDependencyRule(
        "contact_merge_recovery_ledgers.source_contact_snapshot_id",
      )?.disposition,
    ).toBe("preserve_historical");
    expect(
      mergeDependencyRule("staff_notification_operations.contact_id")
        ?.disposition,
    ).toBe("preserve_historical");
  });

  it("covers every current contact-shaped UUID dependency in the schema", () => {
    const schema = fs.readFileSync(
      path.resolve(__dirname, "../db/schema.ts"),
      "utf8",
    );
    const tablePattern =
      /export const\s+\w+\s*=\s*pgTable\(\s*"([^"]+)"(.*?)(?=\nexport const\s|$)/gsu;
    const columnPattern = /uuid\("([^"]+)"\)/gu;
    const discovered: string[] = [];
    for (const tableMatch of schema.matchAll(tablePattern)) {
      const tableName = tableMatch[1];
      const body = tableMatch[2] ?? "";
      if (!tableName) continue;
      for (const columnMatch of body.matchAll(columnPattern)) {
        const columnName = columnMatch[1];
        if (columnName && /(^|_)contact(_[a-z0-9]+)*_ids?$/u.test(columnName)) {
          discovered.push(`${tableName}.${columnName}`);
        }
      }
    }

    expect(discovered.length).toBeGreaterThan(25);
    expect(
      discovered.filter(
        (dependency) => mergeDependencyRule(dependency) === null,
      ),
    ).toEqual([]);
    expect(
      mergeDependencyRule(
        "instant_quote_relationship_backfill_ambiguities.contact_ids",
      )?.disposition,
    ).toBe("block");

    const mergeQueue = fs.readFileSync(
      path.resolve(__dirname, "../lib/merge-queue.ts"),
      "utf8",
    );
    expect(mergeQueue).toContain(
      "SELECT 'staff_notification_operations.contact_id'",
    );
    expect(mergeQueue).toContain(
      "from staff_notification_operations n where n.contact_id",
    );
  });
});

describe("contact merge recovery contract", () => {
  it("accepts only exact, bounded manual merge input", () => {
    const valid = {
      sourceContactId: SOURCE,
      targetContactId: TARGET,
      expectedSourceUpdatedAt: VERSION,
      expectedTargetUpdatedAt: VERSION,
      expectedPreviewHash: HASH,
      confirmation: `MERGE ${SOURCE} INTO ${TARGET}`,
      reason: "  Duplicate\u00a0record  ",
    };
    expect(parseManualContactMergePayload(valid)).toMatchObject({
      sourceContactId: SOURCE,
      targetContactId: TARGET,
      reason: "Duplicate record",
    });
    expect(
      parseManualContactMergePayload({ ...valid, ignored: true }),
    ).toBeNull();
    expect(
      parseManualContactMergePayload({
        ...valid,
        sourceContactId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      }),
    ).toBeNull();
    expect(
      parseManualContactMergePayload({
        ...valid,
        expectedSourceUpdatedAt: "2026-08-08T12:00:00Z",
      }),
    ).toBeNull();
    expect(
      parseManualContactMergePayload({ ...valid, reason: "x".repeat(241) }),
    ).toBeNull();
    expect(
      parseManualContactMergePayload({ ...valid, reason: "bad\nreason" }),
    ).toBeNull();
  });

  it("uses strict discriminated review and bounded scan inputs", () => {
    expect(
      parseContactMergeReviewPayload({
        action: "decline",
        expectedUpdatedAt: VERSION,
      }),
    ).toEqual({ action: "decline", expectedUpdatedAt: VERSION });
    expect(
      parseContactMergeReviewPayload({
        action: "decline",
        expectedUpdatedAt: VERSION,
        confirmation: "ignored",
      }),
    ).toBeNull();
    expect(
      parseContactMergeReviewPayload({
        action: "approve",
        confirmation: `MERGE ${SOURCE} INTO ${TARGET}`,
        expectedUpdatedAt: VERSION,
        expectedSourceUpdatedAt: VERSION,
        expectedTargetUpdatedAt: VERSION,
        expectedPreviewHash: HASH,
      }),
    ).not.toBeNull();
    expect(
      parseContactMergeScanOptions({
        sinceDays: 3650,
        limit: 1000,
        minConfidence: 100,
      }),
    ).toEqual({ sinceDays: 3650, limit: 1000, minConfidence: 100 });
    expect(parseContactMergeScanOptions({ limit: 1001 })).toBeNull();
    expect(parseContactMergeScanOptions({ limit: 10, extra: true })).toBeNull();
  });

  it("detects exact snapshot drift even when ownership is unchanged", () => {
    const after = {
      evidenceVersion: 1,
      expectation: "present_exact",
      dependencyKey: "quotes.contact_id",
      entityId: "quote-1",
      ownerContactId: TARGET,
      snapshot: { id: "quote-1", contact_id: TARGET, total_cents: 12_500 },
    };
    expect(
      compareContactMergeRecoveryEvidence("quote-1", after, [
        {
          dependencyKey: "quotes.contact_id",
          entityId: "quote-1",
          ownerContactId: TARGET,
          snapshot: {
            id: "quote-1",
            contact_id: TARGET,
            total_cents: 13_500,
          },
        },
      ]),
    ).toMatchObject({ reason: "snapshot_changed" });
  });

  it("flags a new target appointment or task that was absent from the merge baseline", () => {
    const appointment = {
      dependencyKey: "appointments.contact_id",
      entityId: "appointment-at-merge",
      ownerContactId: TARGET,
      snapshot: {
        id: "appointment-at-merge",
        contact_id: TARGET,
        status: "confirmed",
      },
    };
    const entries = [
      {
        entityId: appointment.entityId,
        after: {
          evidenceVersion: 1,
          expectation: "present_exact",
          dependencyKey: appointment.dependencyKey,
          entityId: appointment.entityId,
          ownerContactId: TARGET,
          snapshot: appointment.snapshot,
        },
      },
    ];
    expect(
      compareContactMergeRecoveryBaseline(entries, [
        appointment,
        {
          dependencyKey: "crm_tasks.contact_id",
          entityId: "task-created-later",
          ownerContactId: TARGET,
          snapshot: {
            id: "task-created-later",
            contact_id: TARGET,
            status: "open",
          },
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        dependencyKey: "crm_tasks.contact_id",
        entityId: "task-created-later",
        reason: "unexpected_record",
      }),
    ]);
  });

  it("flags an untouched pre-existing target row when it changes later", () => {
    const after = {
      evidenceVersion: 1,
      expectation: "present_exact",
      dependencyKey: "appointments.contact_id",
      entityId: "appointment-existing",
      ownerContactId: TARGET,
      snapshot: {
        id: "appointment-existing",
        contact_id: TARGET,
        status: "confirmed",
      },
    };
    expect(
      compareContactMergeRecoveryBaseline(
        [{ entityId: "appointment-existing", after }],
        [
          {
            dependencyKey: "appointments.contact_id",
            entityId: "appointment-existing",
            ownerContactId: TARGET,
            snapshot: {
              id: "appointment-existing",
              contact_id: TARGET,
              status: "completed",
            },
          },
        ],
      ),
    ).toEqual([
      expect.objectContaining({
        entityId: "appointment-existing",
        reason: "snapshot_changed",
      }),
    ]);
  });

  it("fails inventory review for an unknown target-side dependency", () => {
    expect(
      contactMergeInventoryEvidenceFailures(
        TARGET,
        [
          {
            contactId: TARGET,
            schemaName: "public",
            tableName: "future_target_jobs",
            columnName: "contact_id",
            referenceCount: 1,
            supported: false,
          },
        ],
        [],
      ),
    ).toEqual(["unreviewed schema dependency (future_target_jobs.contact_id)"]);
  });

  it("fails recovery safety for target-side active provider and call operations", () => {
    expect(
      contactMergeOperationSafetyFailures({
        contactId: TARGET,
        unresolvedOutboxIds: ["outbox-1"],
        activeExternalDispatchIds: ["dispatch-1"],
        activeManualCallIds: ["manual-call-1"],
        activeSalesCallIds: ["sales-call-1"],
        staleCompatibilityPropertyIds: ["property-1"],
      }),
    ).toEqual(
      expect.arrayContaining([
        "queued external or automation work",
        "message provider operations in progress or reconciliation",
        "manual calls in progress or reconciliation",
        "sales calls in progress or reconciliation",
        expect.stringContaining("stale property compatibility ownership"),
      ]),
    );
  });

  it("detects retained-target drift and a reappearing deduplicated source", () => {
    const after = {
      evidenceVersion: 1,
      expectation: "source_absent_retained_exact",
      dependencyKey: "team_inbox_new_lead_acknowledgements.contact_id",
      sourceEntityId: "ack-source",
      retainedEntityId: "ack-target",
      retainedOwnerContactId: TARGET,
      retainedSnapshot: {
        id: "ack-target",
        contact_id: TARGET,
        version: 4,
      },
    };
    const retained = {
      dependencyKey: "team_inbox_new_lead_acknowledgements.contact_id",
      entityId: "ack-target",
      ownerContactId: TARGET,
      snapshot: { id: "ack-target", contact_id: TARGET, version: 5 },
    };
    expect(
      compareContactMergeRecoveryEvidence("ack-source", after, [retained]),
    ).toMatchObject({ reason: "snapshot_changed" });
    expect(
      compareContactMergeRecoveryEvidence("ack-source", after, [
        retained,
        {
          dependencyKey: "team_inbox_new_lead_acknowledgements.contact_id",
          entityId: "ack-source",
          ownerContactId: SOURCE,
          snapshot: { id: "ack-source", contact_id: SOURCE, version: 1 },
        },
      ]),
    ).toMatchObject({ reason: "deduplicated_source_present" });
  });

  it("never authorizes automatic reversal even when recorded ownership is unchanged", () => {
    expect(
      assessContactMergeRecovery({
        sourcePresent: true,
        sourceStillBoundToLedger: true,
        targetPresent: true,
        targetVersionUnchanged: true,
        changedDependencyCount: 0,
        unknownDependencyCount: 0,
      }),
    ).toMatchObject({
      automaticRecoveryAllowed: false,
      status: "manual_review_possible",
      blockers: [],
    });
  });

  it("marks drift and unknown dependency behavior unsafe", () => {
    const assessment = assessContactMergeRecovery({
      sourcePresent: true,
      sourceStillBoundToLedger: false,
      targetPresent: true,
      targetVersionUnchanged: false,
      changedDependencyCount: 2,
      unknownDependencyCount: 1,
    });
    expect(assessment.automaticRecoveryAllowed).toBe(false);
    expect(assessment.status).toBe("unsafe");
    expect(assessment.blockers).toHaveLength(4);
  });

  it("keeps ledger identifiers independent from contact and suggestion cascades", () => {
    const migration = fs.readFileSync(
      path.resolve(
        __dirname,
        "../db/migrations/0091_contact_merge_recovery_ledger.sql",
      ),
      "utf8",
    );
    const ledgerHeader = migration.slice(
      migration.indexOf(
        'CREATE TABLE IF NOT EXISTS "contact_merge_recovery_ledgers"',
      ),
      migration.indexOf(
        'CREATE TABLE IF NOT EXISTS "contact_merge_recovery_entries"',
      ),
    );
    expect(ledgerHeader).not.toContain('REFERENCES "contacts"');
    expect(ledgerHeader).not.toContain('REFERENCES "merge_suggestions"');
    expect(migration).toContain("ON DELETE RESTRICT");
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON "contact_merge_recovery_ledgers"',
    );
    expect(migration).toContain(
      'BEFORE TRUNCATE ON "contact_merge_recovery_ledgers"',
    );
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON "contact_merge_recovery_entries"',
    );
    expect(migration).toContain(
      'BEFORE TRUNCATE ON "contact_merge_recovery_entries"',
    );
    expect(migration).toContain('"merged_into_contact_snapshot_id" uuid');
    expect(migration).toContain('"merge_recovery_ledger_id" uuid');
    expect(migration).toContain('"actor_member_snapshot_id" uuid NOT NULL');
    expect(migration).toContain('"session_snapshot_id" uuid NOT NULL');
    expect(migration).toContain(
      "CHECK (\"rule_version\" = 'contact-merge-v3')",
    );
    expect(migration).toContain(
      "CHECK (\"auth_method_snapshot\" IN ('team_session', 'break_glass'))",
    );
    expect(migration).toContain("'created',");
    expect(
      migration.match(/conrelid = 'public\.contacts'::regclass/gu),
    ).toHaveLength(2);
  });

  it("registers migration 0091 immediately after the purge-safety inventory", () => {
    const journal = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../db/migrations/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const purge = journal.entries.find(
      (entry) => entry.tag === "0090_contact_purge_maintenance",
    );
    const recovery = journal.entries.find(
      (entry) => entry.tag === "0091_contact_merge_recovery_ledger",
    );
    expect(recovery?.idx).toBe((purge?.idx ?? -2) + 1);
  });

  it("reuses only a verified baseline instead of bypassing append-only evidence", () => {
    const seedScript = fs.readFileSync(
      path.resolve(__dirname, "../../../../scripts/seed-e2e.ts"),
      "utf8",
    );
    expect(seedScript).toContain("findReusableBaseline");
    expect(seedScript).toContain("seed.initialized");
    expect(seedScript).toContain("runId");
    expect(seedScript).toContain(
      "fixture setup must never bypass contact recovery or append-only evidence controls",
    );
    expect(seedScript).not.toMatch(
      /set_config\([^)]*merge[^)]*(bypass|truncate|reset)/iu,
    );
  });
});

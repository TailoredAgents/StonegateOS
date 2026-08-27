import fs from "node:fs";
import path from "node:path";
import {
  TEAM_ASSIGNABLE_PERMISSION_CATALOG,
  TEAM_OWNER_ONLY_PERMISSION_CATALOG,
  TEAM_PERMISSION_CATALOG,
} from "@myst-os/sdk";
import {
  buildContactPurgePreview,
  type ContactPurgeDependency,
} from "@/lib/contact-purge-maintenance";
import {
  computeEffectivePermissions,
  getDefaultPermissionsForRole,
} from "@/lib/permissions";
import { buildTeamRouteSecurityContract } from "@/lib/team-route-security-manifest";

const API_ROOT = path.resolve(__dirname, "../..");
const CONTACT_ID = "037cfdb8-e3af-40a1-bf96-d487cab3eb91";
const DELETED_AT = new Date("2026-07-01T12:00:00.000Z");
const ELIGIBLE_AT = new Date("2026-07-31T12:00:00.000Z");
const UPDATED_AT = new Date("2026-08-01T12:00:00.000Z");
const NOW = new Date("2026-08-09T12:00:00.000Z");

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

function dependency(
  overrides: Partial<ContactPurgeDependency> = {},
): ContactPurgeDependency {
  return {
    sourceKind: "foreign_key",
    schemaName: "public",
    tableName: "appointments",
    columnName: "contact_id",
    constraintName: "appointments_contact_id_contacts_id_fk",
    deleteAction: "cascade",
    referenceCount: 0,
    supported: true,
    rule: "must_be_empty",
    blocking: false,
    ...overrides,
  };
}

function preview(dependencies: ContactPurgeDependency[]) {
  return buildContactPurgePreview({
    contact: {
      id: CONTACT_ID,
      deletedAt: DELETED_AT,
      purgeEligibleAt: ELIGIBLE_AT,
      updatedAt: UPDATED_AT,
    },
    dependencies,
    now: NOW,
  });
}

describe("contact purge preview decisions", () => {
  it("allows only an elapsed, complete, dependency-free inventory", () => {
    const result = preview([dependency()]);

    expect(result).toMatchObject({
      contactId: CONTACT_ID,
      recordVersion: UPDATED_AT.toISOString(),
      executable: true,
      reason: "eligible",
      blockingDependencyCount: 0,
      foreignKeyInventoryComplete: true,
      confirmationText: `PURGE ${CONTACT_ID}`,
    });
    expect(result.previewVersion).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.recoveryExpectation).toContain("irreversible");
  });

  it("blocks every FK delete action when a relationship exists", () => {
    for (const deleteAction of [
      "cascade",
      "set_null",
      "restrict",
      "no_action",
    ]) {
      const result = preview([
        dependency({
          deleteAction,
          referenceCount: 1,
          blocking: true,
        }),
      ]);
      expect(result.executable).toBe(false);
      expect(result.reason).toBe("dependencies_present");
      expect(result.blockingReferenceCount).toBe(1);
    }
  });

  it("fails closed on unsupported or unknown logical inventory", () => {
    expect(
      preview([
        dependency({
          supported: false,
          rule: "inventory_unavailable",
          blocking: true,
        }),
      ]).executable,
    ).toBe(false);
    expect(
      preview([
        dependency(),
        dependency({
          sourceKind: "logical_reference",
          tableName: "future_contact_work",
          constraintName: null,
          deleteAction: null,
          referenceCount: 1,
          rule: "manual_rule_required",
          blocking: true,
        }),
      ]).executable,
    ).toBe(false);
  });

  it("retains immutable provider evidence but separately blocks active work", () => {
    const retained = dependency({
      sourceKind: "logical_reference",
      tableName: "team_call_operations",
      constraintName: null,
      deleteAction: null,
      referenceCount: 4,
      rule: "retain_immutable_evidence",
      blocking: false,
    });
    const first = preview([dependency(), retained]);
    const later = preview([dependency(), { ...retained, referenceCount: 5 }]);
    expect(first.executable).toBe(true);
    expect(later.executable).toBe(true);
    expect(later.previewVersion).toBe(first.previewVersion);

    const active = preview([
      dependency(),
      retained,
      dependency({
        sourceKind: "active_operation",
        tableName: "team_call_operations",
        constraintName: null,
        deleteAction: null,
        referenceCount: 1,
        rule: "resolve_before_purge",
        blocking: true,
      }),
    ]);
    expect(active.executable).toBe(false);
  });

  it("keeps a valid preview non-executable during the 30-day window", () => {
    const result = buildContactPurgePreview({
      contact: {
        id: CONTACT_ID,
        deletedAt: DELETED_AT,
        purgeEligibleAt: ELIGIBLE_AT,
        updatedAt: UPDATED_AT,
      },
      dependencies: [dependency()],
      now: new Date("2026-07-20T12:00:00.000Z"),
    });
    expect(result.executable).toBe(false);
    expect(result.reason).toBe("recovery_window_active");
  });
});

describe("contact purge authorization and source contracts", () => {
  const route = source("app/api/admin/contacts/[contactId]/purge/route.ts");
  const helper = source("src/lib/contact-purge-maintenance.ts");
  const migration = source(
    "src/db/migrations/0090_contact_purge_maintenance.sql",
  );
  const schema = source("src/db/schema.ts");
  const mergeLibrary = source("src/lib/merge-queue.ts");
  const roleUpdateRoute = source("app/api/admin/roles/[roleId]/route.ts");
  const siteRoleUpdateRoute = source(
    "../site/src/app/api/team/access/roles/[roleId]/route.ts",
  );
  const roleEditForm = source(
    "../site/src/app/team/components/RoleEditForm.tsx",
  );

  it("keeps purge out of custom grants and grants it only when stored explicitly", () => {
    expect(TEAM_PERMISSION_CATALOG).toContain("contacts.purge");
    expect(TEAM_OWNER_ONLY_PERMISSION_CATALOG).toEqual([
      "contacts.purge",
      "expenses.approve",
      "financials.read",
      "ad_spend.write",
    ]);
    expect(TEAM_ASSIGNABLE_PERMISSION_CATALOG).not.toContain("contacts.purge");
    expect(TEAM_ASSIGNABLE_PERMISSION_CATALOG).not.toContain(
      "expenses.approve",
    );
    expect(TEAM_ASSIGNABLE_PERMISSION_CATALOG).not.toContain("financials.read");
    expect(TEAM_ASSIGNABLE_PERMISSION_CATALOG).not.toContain("ad_spend.write");
    expect(getDefaultPermissionsForRole("owner")).toEqual([
      "*",
      "contacts.purge",
      "expenses.approve",
      "financials.read",
      "ad_spend.write",
    ]);
    expect(
      computeEffectivePermissions({
        rolePermissions: ["*"],
        grant: [],
        deny: [],
      }),
    ).not.toContain("contacts.purge");
    expect(
      computeEffectivePermissions({
        rolePermissions: ["*", "contacts.purge"],
        grant: [],
        deny: [],
      }),
    ).toContain("contacts.purge");
    expect(
      computeEffectivePermissions({
        rolePermissions: ["*", "contacts.purge"],
        grant: [],
        deny: ["contacts.purge"],
      }),
    ).not.toContain("contacts.purge");
  });

  it("preserves the system-managed Owner permission through reviewed role edits", () => {
    expect(roleUpdateRoute).toContain("...TEAM_OWNER_ONLY_PERMISSION_CATALOG");
    expect(roleUpdateRoute).toContain("permissions: nextPermissions");
    expect(siteRoleUpdateRoute).toContain(
      "...TEAM_OWNER_ONLY_PERMISSION_CATALOG",
    );
    expect(siteRoleUpdateRoute).toContain("permissions: expectedPermissions");
    expect(roleEditForm).toContain(
      "Owner-only financial and maintenance permissions are system-managed",
    );
    expect(roleEditForm).toContain(
      "TEAM_OWNER_ONLY_PERMISSION_CATALOG.includes",
    );
  });

  it("declares human-only read/destructive route contracts", () => {
    const getContract = buildTeamRouteSecurityContract({
      route: "app/api/admin/contacts/[contactId]/purge/route.ts",
      method: "GET",
      permissions: ["contacts.purge"],
    });
    const postContract = buildTeamRouteSecurityContract({
      route: "app/api/admin/contacts/[contactId]/purge/route.ts",
      method: "POST",
      permissions: ["contacts.purge"],
    });
    expect(getContract).toMatchObject({
      principalTypes: ["human"],
      risk: "read",
      requiresIdempotency: false,
    });
    expect(postContract).toMatchObject({
      principalTypes: ["human"],
      risk: "destructive",
      requiresIdempotency: true,
    });
  });

  it("authorizes before params/body and requires preview, version, typed confirmation, and idempotency", () => {
    const getStart = route.indexOf("export async function GET");
    const postStart = route.indexOf("export async function POST");
    const getSource = route.slice(getStart, postStart);
    const postSource = route.slice(postStart);

    expect(getSource.indexOf("requirePermission(")).toBeLessThan(
      getSource.indexOf("await context.params"),
    );
    expect(getSource).toContain('requirePermission(request, "contacts.purge"');
    expect(getSource).toContain(
      'ignoredKillSwitches: ["destructive_mutations"]',
    );
    expect(getSource).toContain('actor?.type !== "human"');
    expect(getSource).toContain('action: "contact.purge_previewed"');

    expect(postSource.indexOf("beginTeamMutation(request")).toBeLessThan(
      postSource.indexOf("await context.params"),
    );
    expect(postSource.indexOf("beginTeamMutation(request")).toBeLessThan(
      postSource.indexOf("readBoundedJsonRequest(request"),
    );
    expect(postSource).toContain('requiredPermissions: ["contacts.purge"]');
    expect(postSource).toContain('risk: "destructive"');
    expect(postSource).toContain("requiresIdempotency: true");
    expect(postSource).toContain("claimTeamMutationIdempotency(");
    expect(postSource).toContain("assertTeamMutationExpectedVersion(");
    expect(postSource).toContain(
      "parsed.data.previewVersion !== preview.previewVersion",
    );
    expect(postSource).toContain(
      "parsed.data.confirmation !== preview.confirmationText",
    );
  });

  it("correlates preview evidence without logging a contact ID or raw exception message", () => {
    const getSource = route.slice(
      route.indexOf("export async function GET"),
      route.indexOf("export async function POST"),
    );
    const failureLog = getSource.slice(
      getSource.indexOf('console.error("[contact-purge] preview_failed"'),
      getSource.indexOf(
        "return NextResponse.json(",
        getSource.indexOf("preview_failed"),
      ),
    );
    expect(getSource).toContain(
      "const correlationId = readCorrelationId(request)",
    );
    expect(
      getSource.match(/"x-correlation-id": correlationId/gu)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(getSource).toContain("correlationId,");
    expect(failureLog).toContain("errorName:");
    expect(failureLog).not.toContain("contactId,");
    expect(failureLog).not.toContain("error.message");
    expect(failureLog).not.toContain("String(error)");
    expect(getSource).toContain('error: timedOut ? "preview_timeout"');
    expect(getSource).toContain("status: timedOut ? 504 : 503");
  });

  it("keeps authorized execute responses correlated and settlement logs privacy-bounded", () => {
    const postSource = route.slice(route.indexOf("export async function POST"));
    const settlementLog = postSource.slice(
      postSource.indexOf(
        'console.error("[contact-purge] idempotency_settlement_failed"',
      ),
      postSource.indexOf(
        "return teamMutationErrorResponse(",
        postSource.indexOf("idempotency_settlement_failed"),
      ),
    );

    expect(postSource).toContain(
      "teamMutationResultResponse(result, 200, mutation.correlationId)",
    );
    expect(postSource).toContain(
      "teamMutationExceptionResponse(failure, mutation)",
    );
    expect(postSource).toContain(
      "teamMutationExceptionResponse(error, mutation)",
    );
    expect(postSource).toContain("correlationId: mutation.correlationId");
    expect(settlementLog).toContain("errorName:");
    expect(settlementLog).not.toContain("contactId");
    expect(settlementLog).not.toContain("settlementError.message");
    expect(settlementLog).not.toContain("String(settlementError)");
  });

  it("locks, re-previews, invokes the DB guard, and atomically audits exactly one hard delete", () => {
    const postSource = route.slice(route.indexOf("export async function POST"));
    const lockTimeout = postSource.indexOf("SET LOCAL lock_timeout = '5s'");
    const statementTimeout = postSource.indexOf(
      "SET LOCAL statement_timeout = '15s'",
    );
    const lock = postSource.indexOf("pg_advisory_xact_lock(hashtextextended");
    const dependencyLocks = postSource.indexOf(
      "lockContactPurgeDependencyTables(tx)",
      lock,
    );
    const rowLock = postSource.indexOf('.for("update")', dependencyLocks);
    const previewIndex = postSource.indexOf(
      "buildContactPurgePreview(",
      rowLock,
    );
    const guard = postSource.indexOf(
      "set_config('app.contact_purge_authorized_id'",
      previewIndex,
    );
    const deletion = postSource.indexOf(".delete(contacts)", guard);
    const audit = postSource.indexOf(
      "mutation.audit.insertSuccess(tx",
      deletion,
    );
    const complete = postSource.indexOf(
      "completeTeamMutationIdempotency(",
      audit,
    );

    expect(lockTimeout).toBeGreaterThan(-1);
    expect(lockTimeout).toBeLessThan(statementTimeout);
    expect(statementTimeout).toBeLessThan(lock);
    expect(lock).toBeLessThan(dependencyLocks);
    expect(dependencyLocks).toBeLessThan(rowLock);
    expect(rowLock).toBeLessThan(previewIndex);
    expect(previewIndex).toBeLessThan(guard);
    expect(guard).toBeLessThan(deletion);
    expect(deletion).toBeLessThan(audit);
    expect(audit).toBeLessThan(complete);
    expect(postSource.match(/\.delete\(contacts\)/gu)).toHaveLength(1);
    expect(postSource).toContain("settleTeamMutationIdempotencyFailure(");
    expect(postSource).toContain('metadata: { boundary: "execute"');
    expect(postSource).toContain("errorName:");
    expect(postSource).not.toContain("settlementError.message");
    expect(postSource).toContain("immutableAuditEvidenceRetained: true");
    expect(postSource).toContain("immutableProviderEvidenceRetained: true");
  });

  it("uses live catalog inventory and fails every current FK cascade/set-null/restrict reference closed", () => {
    const currentContactReferences =
      schema.match(/\.references\(\(\) => contacts\.id/gu) ?? [];
    expect(currentContactReferences.length).toBeGreaterThan(20);
    expect(migration).toContain(
      `constraint_row."confrelid" = 'public.contacts'::regclass`,
    );
    expect(migration).toContain('cardinality(constraint_row."conkey")');
    expect(migration).toContain("contact_purge_fk_inventory");
    expect(migration).toContain("contact_purge_lock_dependency_tables");
    expect(migration).toContain("LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE");
    expect(migration).toContain(
      `column_row."attname" ~ '(^|_)contact(_[a-z0-9]+)*_ids?$'`,
    );
    // Merge recovery ledgers retain full before-state JSON, including identity
    // data. Their snapshot UUIDs must therefore block hard purge until a
    // separately approved retention/minimization design removes that PII.
    expect(helper).not.toContain(
      "public.contact_merge_recovery_ledgers.source_contact_snapshot_id",
    );
    expect(helper).not.toContain(
      "public.contact_merge_recovery_ledgers.target_contact_snapshot_id",
    );
    expect(migration).not.toContain(
      "dependency.table_name = 'contact_merge_recovery_ledgers'",
    );
    expect(migration).toContain("dependency.reference_count > 0");
    expect(migration).toContain("contact_purge_foreign_key_dependency_guard");
    expect(helper).toContain('? "must_be_empty"');
    expect(helper).toContain('sourceKind === "foreign_key"');
  });

  it("blocks unclassified logical references and unresolved provider/outbox work at both layers", () => {
    expect(migration).toContain("contact_purge_logical_inventory");
    expect(migration).toContain("team_call_operations");
    expect(migration).toContain("team_call_operation_task_intents");
    expect(migration).toContain("sales_escalation_call_operations");
    expect(migration).toContain("contact_purge_active_operation_guard");
    expect(migration).toContain("\"payload\" ->> 'contactId'");
    expect(helper).toContain("RETAINED_LOGICAL_EVIDENCE");
    expect(helper).toContain('"manual_rule_required"');
    expect(helper).toContain('"resolve_before_purge"');
  });

  it("registers the owner permission and database guard in migration 0090", () => {
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    expect(journal.entries).toContainEqual({
      idx: 87,
      version: "7",
      when: 1788652800000,
      tag: "0090_contact_purge_maintenance",
      breakpoints: true,
    });
    expect(migration).toContain("ARRAY['contacts.purge']::text[]");
    expect(migration).toContain("lower(trim(\"slug\")) = 'owner'");
    expect(migration).toContain(
      'CREATE TRIGGER "contacts_purge_maintenance_guard"',
    );
    expect(migration).toContain("interval '30 days'");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"?contacts"?/iu);
  });

  it("does not let merge or scoped fixture cleanup opt into hard purge", () => {
    expect(mergeLibrary).not.toContain("app.contact_purge_authorized_id");
    expect(migration).toContain(
      "current_setting('app.contact_purge_authorized_id', true)",
    );
    expect(migration).toContain(
      "contacts may only be hard-deleted by the authorized purge maintenance process",
    );

    const seed = source("../../scripts/seed-e2e.ts");
    const cleanup = source("../../scripts/cleanup-e2e.ts");
    const journeyFixtures = source("../../tests/e2e/audit/journey-fixtures.ts");
    const quoteLifecycle = source("src/__tests__/quote-lifecycle.test.ts");
    expect(seed).not.toContain(
      'TRUNCATE TABLE "contacts" RESTART IDENTITY CASCADE',
    );
    expect(seed).toContain("findReusableBaseline");
    expect(seed).toContain("fixture setup must never bypass contact recovery");
    expect(seed).toContain(
      "setup will not guess at or overwrite an unverified fixture",
    );
    expect(seed).not.toContain("database.delete(contacts)");
    expect(cleanup).not.toContain("db.delete(contacts)");
    expect(cleanup).toContain("contactsArchivedForRecovery");
    expect(journeyFixtures).not.toContain("DELETE FROM contacts WHERE id");
    expect(journeyFixtures).toContain(
      "purge_eligible_at = statement_timestamp() + interval '30 days'",
    );
    expect(journeyFixtures).not.toContain("DELETE FROM properties WHERE id");
    expect(journeyFixtures).toContain(
      "address_key = 'audit-fixture-redacted|' || id::text",
    );
    expect(journeyFixtures).toContain("SET share_token = NULL");
    expect(quoteLifecycle).not.toContain("db.delete(contacts)");
  });
});

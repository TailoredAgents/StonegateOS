import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import {
  evaluateContactPurgeEligibility,
  type ContactPurgeEligibility,
} from "@/lib/contact-retention";

export type ContactPurgeDependencyRule =
  | "must_be_empty"
  | "resolve_before_purge"
  | "retain_immutable_evidence"
  | "manual_rule_required"
  | "inventory_unavailable";

export type ContactPurgeDependency = {
  sourceKind:
    | "foreign_key"
    | "logical_reference"
    | "active_operation"
    | "inventory_guard";
  schemaName: string;
  tableName: string;
  columnName: string;
  constraintName: string | null;
  deleteAction: string | null;
  referenceCount: number;
  supported: boolean;
  rule: ContactPurgeDependencyRule;
  blocking: boolean;
};

export type ContactPurgePreview = {
  contactId: string;
  recordVersion: string;
  deletedAt: string | null;
  purgeEligibleAt: string | null;
  retention: ContactPurgeEligibility;
  dependencies: ContactPurgeDependency[];
  blockingDependencyCount: number;
  blockingReferenceCount: number;
  foreignKeyInventoryComplete: boolean;
  executable: boolean;
  reason:
    | ContactPurgeEligibility["reason"]
    | "dependencies_present"
    | "eligible";
  previewVersion: string;
  confirmationText: string;
  recoveryExpectation: string;
};

type ContactPurgeExecutor = Pick<DatabaseClient, "execute">;

type InventoryRow = {
  sourceKind?: unknown;
  schemaName?: unknown;
  tableName?: unknown;
  columnName?: unknown;
  constraintName?: unknown;
  deleteAction?: unknown;
  referenceCount?: unknown;
  supported?: unknown;
};

const RETAINED_LOGICAL_EVIDENCE = new Set([
  "public.sales_escalation_call_operations.contact_id",
  "public.team_call_operation_task_intents.expected_contact_id",
  "public.team_call_operations.contact_id",
]);

/**
 * Freeze every table that can create a contact dependency while execute
 * performs its final inventory and delete. Migration 0090 discovers both
 * contact foreign-key tables and UUID-shaped logical/snapshot-reference
 * tables, plus the JSON outbox dependency. The lock is transaction-scoped.
 */
export async function lockContactPurgeDependencyTables(
  db: ContactPurgeExecutor,
): Promise<void> {
  await db.execute(
    sql`select "public"."contact_purge_lock_dependency_tables"()`,
  );
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function countValue(value: unknown): number | null {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeInventoryRow(row: InventoryRow): ContactPurgeDependency {
  const sourceKind =
    row.sourceKind === "foreign_key"
      ? "foreign_key"
      : row.sourceKind === "logical_reference"
        ? "logical_reference"
        : "inventory_guard";
  const schemaName = textValue(row.schemaName, "unknown");
  const tableName = textValue(row.tableName, "unknown");
  const columnName = textValue(row.columnName, "unknown");
  const referenceCount = countValue(row.referenceCount);
  const supported = row.supported === true && referenceCount !== null;
  const logicalKey = `${schemaName}.${tableName}.${columnName}`;
  const retainedEvidence =
    sourceKind === "logical_reference" &&
    RETAINED_LOGICAL_EVIDENCE.has(logicalKey);
  const rule: ContactPurgeDependencyRule = !supported
    ? "inventory_unavailable"
    : sourceKind === "foreign_key"
      ? "must_be_empty"
      : retainedEvidence
        ? "retain_immutable_evidence"
        : "manual_rule_required";
  const normalizedCount = referenceCount ?? 0;
  return {
    sourceKind,
    schemaName,
    tableName,
    columnName,
    constraintName:
      typeof row.constraintName === "string" ? row.constraintName : null,
    deleteAction:
      typeof row.deleteAction === "string" ? row.deleteAction : null,
    referenceCount: normalizedCount,
    supported,
    rule,
    blocking:
      !supported ||
      (normalizedCount > 0 && rule !== "retain_immutable_evidence"),
  };
}

function activeDependency(
  tableName: string,
  columnName: string,
  referenceCount: unknown,
): ContactPurgeDependency {
  const count = countValue(referenceCount);
  return {
    sourceKind: "active_operation",
    schemaName: "public",
    tableName,
    columnName,
    constraintName: null,
    deleteAction: null,
    referenceCount: count ?? 0,
    supported: count !== null,
    rule: count === null ? "inventory_unavailable" : "resolve_before_purge",
    blocking: count === null || count > 0,
  };
}

function dependencySortKey(dependency: ContactPurgeDependency): string {
  return [
    dependency.sourceKind,
    dependency.schemaName,
    dependency.tableName,
    dependency.columnName,
    dependency.constraintName ?? "",
  ].join(":");
}

/**
 * Read every live FK pointing at contacts plus UUID-shaped logical references.
 * The database functions are installed by migration 0090 and deliberately
 * return unsupported catalog shapes instead of guessing how to count them.
 */
export async function loadContactPurgeDependencies(
  db: ContactPurgeExecutor,
  contactId: string,
): Promise<ContactPurgeDependency[]> {
  const inventoryRows = (await db.execute(sql`
    select
      'foreign_key'::text as "sourceKind",
      inventory.schema_name as "schemaName",
      inventory.table_name as "tableName",
      inventory.column_name as "columnName",
      inventory.constraint_name as "constraintName",
      inventory.delete_action as "deleteAction",
      inventory.reference_count as "referenceCount",
      inventory.supported as "supported"
    from "public"."contact_purge_fk_inventory"(${contactId}::uuid) as inventory
    union all
    select
      'logical_reference'::text as "sourceKind",
      inventory.schema_name as "schemaName",
      inventory.table_name as "tableName",
      inventory.column_name as "columnName",
      null::text as "constraintName",
      null::text as "deleteAction",
      inventory.reference_count as "referenceCount",
      inventory.supported as "supported"
    from "public"."contact_purge_logical_inventory"(${contactId}::uuid) as inventory
  `)) as InventoryRow[];

  const dependencies = inventoryRows.map(normalizeInventoryRow);
  const activeRows = (await db.execute(sql`
    select
      (
        select count(*)::bigint
        from "team_call_operations"
        where "contact_id" = ${contactId}::uuid
          and "guard_released_at" is null
      ) as "manualCalls",
      (
        select count(*)::bigint
        from "team_call_operation_task_intents" as intent
        inner join "team_call_operations" as operation
          on operation."id" = intent."operation_id"
        where intent."expected_contact_id" = ${contactId}::uuid
          and operation."guard_released_at" is null
      ) as "manualCallIntents",
      (
        select count(*)::bigint
        from "sales_escalation_call_operations"
        where "contact_id" = ${contactId}::uuid
          and "guard_released_at" is null
      ) as "salesEscalationCalls",
      (
        select count(*)::bigint
        from "outbox_events"
        where "processed_at" is null
          and "payload" ->> 'contactId' = ${contactId}
      ) as "unresolvedOutbox"
  `)) as Array<Record<string, unknown>>;
  const active = activeRows[0];
  if (!active) {
    dependencies.push({
      sourceKind: "inventory_guard",
      schemaName: "public",
      tableName: "contact_purge_active_operation_inventory",
      columnName: "contact_id",
      constraintName: null,
      deleteAction: null,
      referenceCount: 0,
      supported: false,
      rule: "inventory_unavailable",
      blocking: true,
    });
  } else {
    dependencies.push(
      activeDependency(
        "team_call_operations",
        "contact_id",
        active["manualCalls"],
      ),
      activeDependency(
        "team_call_operation_task_intents",
        "expected_contact_id",
        active["manualCallIntents"],
      ),
      activeDependency(
        "sales_escalation_call_operations",
        "contact_id",
        active["salesEscalationCalls"],
      ),
      activeDependency(
        "outbox_events",
        "payload.contactId",
        active["unresolvedOutbox"],
      ),
    );
  }

  if (
    !dependencies.some((dependency) => dependency.sourceKind === "foreign_key")
  ) {
    dependencies.push({
      sourceKind: "inventory_guard",
      schemaName: "public",
      tableName: "contacts",
      columnName: "id",
      constraintName: null,
      deleteAction: null,
      referenceCount: 0,
      supported: false,
      rule: "inventory_unavailable",
      blocking: true,
    });
  }

  return dependencies.sort((left, right) =>
    dependencySortKey(left).localeCompare(dependencySortKey(right)),
  );
}

function previewHash(input: {
  contactId: string;
  recordVersion: string;
  deletedAt: string | null;
  purgeEligibleAt: string | null;
  dependencies: ContactPurgeDependency[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        dependencies: input.dependencies.map((dependency) => ({
          sourceKind: dependency.sourceKind,
          schemaName: dependency.schemaName,
          tableName: dependency.tableName,
          columnName: dependency.columnName,
          constraintName: dependency.constraintName,
          deleteAction: dependency.deleteAction,
          supported: dependency.supported,
          rule: dependency.rule,
          blocking: dependency.blocking,
          // Immutable evidence is deliberately retained. Its count may grow
          // through audit/provider finalization without invalidating a safe
          // preview; any unresolved operation is represented separately.
          referenceCount:
            dependency.rule === "retain_immutable_evidence"
              ? null
              : dependency.referenceCount,
        })),
      }),
      "utf8",
    )
    .digest("hex");
}

export function buildContactPurgePreview(input: {
  contact: {
    id: string;
    updatedAt: Date;
    deletedAt: Date | null;
    purgeEligibleAt: Date | null;
  };
  dependencies: ContactPurgeDependency[];
  now?: Date;
}): ContactPurgePreview {
  const retention = evaluateContactPurgeEligibility(
    input.contact,
    input.now ?? new Date(),
  );
  const deletedAt = input.contact.deletedAt?.toISOString() ?? null;
  const purgeEligibleAt = input.contact.purgeEligibleAt?.toISOString() ?? null;
  const recordVersion = input.contact.updatedAt.toISOString();
  const dependencies = [...input.dependencies].sort((left, right) =>
    dependencySortKey(left).localeCompare(dependencySortKey(right)),
  );
  const blocking = dependencies.filter((dependency) => dependency.blocking);
  const foreignKeyInventoryComplete =
    dependencies.some(
      (dependency) => dependency.sourceKind === "foreign_key",
    ) &&
    dependencies
      .filter((dependency) => dependency.sourceKind === "foreign_key")
      .every((dependency) => dependency.supported);
  const executable =
    retention.eligible && foreignKeyInventoryComplete && blocking.length === 0;
  const reason: ContactPurgePreview["reason"] = !retention.eligible
    ? retention.reason
    : executable
      ? "eligible"
      : "dependencies_present";
  const hashInput = {
    contactId: input.contact.id,
    recordVersion,
    deletedAt,
    purgeEligibleAt,
    dependencies,
  };

  return {
    contactId: input.contact.id,
    recordVersion,
    deletedAt,
    purgeEligibleAt,
    retention,
    dependencies,
    blockingDependencyCount: blocking.length,
    blockingReferenceCount: blocking.reduce(
      (sum, dependency) => sum + dependency.referenceCount,
      0,
    ),
    foreignKeyInventoryComplete,
    executable,
    reason,
    previewVersion: previewHash(hashInput),
    confirmationText: `PURGE ${input.contact.id}`,
    recoveryExpectation:
      "This hard purge is irreversible in the CRM. Recovery requires an independently verified database backup; immutable audit and provider evidence remains retained.",
  };
}

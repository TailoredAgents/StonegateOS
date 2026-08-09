import { createHash } from "node:crypto";

export const CONTACT_MERGE_RULE_VERSION = "contact-merge-v3";

export const CONTACT_MERGE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const CONTACT_MERGE_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const CONTACT_MERGE_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REASON_MAXIMUM_LENGTH = 240;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

export function isExactContactMergeUuid(value: unknown): value is string {
  return typeof value === "string" && CONTACT_MERGE_UUID_PATTERN.test(value);
}

export function isExactContactMergeHash(value: unknown): value is string {
  return typeof value === "string" && CONTACT_MERGE_HASH_PATTERN.test(value);
}

export function isExactContactMergeInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CONTACT_MERGE_ISO_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export type ManualContactMergePayload = {
  sourceContactId: string;
  targetContactId: string;
  expectedSourceUpdatedAt: string;
  expectedTargetUpdatedAt: string;
  expectedPreviewHash: string;
  confirmation: string;
  reason: string;
};

export function parseManualContactMergePayload(
  value: unknown,
): ManualContactMergePayload | null {
  const input = record(value);
  if (
    !input ||
    !exactKeys(
      input,
      [
        "sourceContactId",
        "targetContactId",
        "expectedSourceUpdatedAt",
        "expectedTargetUpdatedAt",
        "expectedPreviewHash",
        "confirmation",
      ],
      ["reason"],
    ) ||
    !isExactContactMergeUuid(input["sourceContactId"]) ||
    !isExactContactMergeUuid(input["targetContactId"]) ||
    !isExactContactMergeInstant(input["expectedSourceUpdatedAt"]) ||
    !isExactContactMergeInstant(input["expectedTargetUpdatedAt"]) ||
    !isExactContactMergeHash(input["expectedPreviewHash"]) ||
    typeof input["confirmation"] !== "string"
  ) {
    return null;
  }
  const rawReason = input["reason"];
  if (
    rawReason !== undefined &&
    (typeof rawReason !== "string" ||
      rawReason.length > REASON_MAXIMUM_LENGTH * 4 ||
      /[\p{Cc}\p{Cf}]/u.test(rawReason))
  ) {
    return null;
  }
  const reason =
    typeof rawReason === "string"
      ? rawReason.normalize("NFKC").replace(/\s+/gu, " ").trim()
      : "";
  if (reason.length > REASON_MAXIMUM_LENGTH) return null;
  return {
    sourceContactId: input["sourceContactId"],
    targetContactId: input["targetContactId"],
    expectedSourceUpdatedAt: input["expectedSourceUpdatedAt"],
    expectedTargetUpdatedAt: input["expectedTargetUpdatedAt"],
    expectedPreviewHash: input["expectedPreviewHash"],
    confirmation: input["confirmation"],
    reason: reason || "manual",
  };
}

export type ContactMergeReviewPayload =
  | {
      action: "approve";
      confirmation: string;
      expectedUpdatedAt: string;
      expectedSourceUpdatedAt: string;
      expectedTargetUpdatedAt: string;
      expectedPreviewHash: string;
    }
  | { action: "decline"; expectedUpdatedAt: string };

export function parseContactMergeReviewPayload(
  value: unknown,
): ContactMergeReviewPayload | null {
  const input = record(value);
  if (
    !input ||
    (input["action"] !== "approve" && input["action"] !== "decline")
  ) {
    return null;
  }
  if (input["action"] === "decline") {
    return exactKeys(input, ["action", "expectedUpdatedAt"]) &&
      isExactContactMergeInstant(input["expectedUpdatedAt"])
      ? { action: "decline", expectedUpdatedAt: input["expectedUpdatedAt"] }
      : null;
  }
  if (
    !exactKeys(input, [
      "action",
      "confirmation",
      "expectedUpdatedAt",
      "expectedSourceUpdatedAt",
      "expectedTargetUpdatedAt",
      "expectedPreviewHash",
    ]) ||
    typeof input["confirmation"] !== "string" ||
    !isExactContactMergeInstant(input["expectedUpdatedAt"]) ||
    !isExactContactMergeInstant(input["expectedSourceUpdatedAt"]) ||
    !isExactContactMergeInstant(input["expectedTargetUpdatedAt"]) ||
    !isExactContactMergeHash(input["expectedPreviewHash"])
  ) {
    return null;
  }
  return {
    action: "approve",
    confirmation: input["confirmation"],
    expectedUpdatedAt: input["expectedUpdatedAt"],
    expectedSourceUpdatedAt: input["expectedSourceUpdatedAt"],
    expectedTargetUpdatedAt: input["expectedTargetUpdatedAt"],
    expectedPreviewHash: input["expectedPreviewHash"],
  };
}

export type ContactMergeScanOptions = {
  sinceDays?: number;
  limit?: number;
  minConfidence?: number;
};

export function parseContactMergeScanOptions(
  value: unknown,
): ContactMergeScanOptions | null {
  const input = record(value);
  if (
    !input ||
    !exactKeys(input, [], ["sinceDays", "limit", "minConfidence"])
  ) {
    return null;
  }
  const ranges = {
    sinceDays: [1, 3650],
    limit: [1, 1000],
    minConfidence: [1, 100],
  } as const;
  const result: ContactMergeScanOptions = {};
  for (const key of Object.keys(ranges) as Array<keyof typeof ranges>) {
    const candidate = input[key];
    if (candidate === undefined) continue;
    const [minimum, maximum] = ranges[key];
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < minimum ||
      candidate > maximum
    ) {
      return null;
    }
    result[key] = candidate;
  }
  return result;
}

export type MergeDependencyDisposition =
  | "move"
  | "deduplicate_target_wins"
  | "preserve_historical"
  | "block";

export type MergeDependencyRule = {
  key: string;
  label: string;
  disposition: MergeDependencyDisposition;
};

/**
 * Every direct or logical contact dependency known to the current schema.
 * Runtime catalog inventory is compared with this list so a newly added
 * dependency fails closed until its merge behavior is reviewed explicitly.
 */
export const CONTACT_MERGE_DEPENDENCY_RULES = [
  {
    key: "properties.contact_id",
    label: "property compatibility owners",
    disposition: "move",
  },
  {
    key: "contact_properties.contact_id",
    label: "property associations",
    disposition: "deduplicate_target_wins",
  },
  {
    key: "crm_pipeline.contact_id",
    label: "pipeline record",
    disposition: "deduplicate_target_wins",
  },
  { key: "crm_tasks.contact_id", label: "CRM tasks", disposition: "move" },
  { key: "leads.contact_id", label: "leads", disposition: "move" },
  {
    key: "team_inbox_new_lead_acknowledgements.contact_id",
    label: "new-lead acknowledgements",
    disposition: "deduplicate_target_wins",
  },
  {
    key: "merge_suggestions.source_contact_id",
    label: "source merge suggestions",
    disposition: "preserve_historical",
  },
  {
    key: "merge_suggestions.target_contact_id",
    label: "target merge suggestions",
    disposition: "preserve_historical",
  },
  {
    key: "sales_agent_memories.contact_id",
    label: "sales-agent memory",
    disposition: "deduplicate_target_wins",
  },
  {
    key: "sales_agent_next_actions.contact_id",
    label: "sales-agent next action",
    disposition: "deduplicate_target_wins",
  },
  {
    key: "facebook_sales_autopilot_sessions.contact_id",
    label: "automation sessions",
    disposition: "move",
  },
  {
    key: "facebook_sales_autopilot_actions.contact_id",
    label: "automation actions",
    disposition: "move",
  },
  {
    key: "media_job_analyses.contact_id",
    label: "media analysis",
    disposition: "deduplicate_target_wins",
  },
  {
    key: "conversation_threads.contact_id",
    label: "conversation threads",
    disposition: "move",
  },
  {
    key: "conversation_participants.contact_id",
    label: "conversation participants",
    disposition: "move",
  },
  {
    key: "partner_users.org_contact_id",
    label: "partner portal users",
    disposition: "block",
  },
  {
    key: "partner_invite_operations.org_contact_id",
    label: "partner invite evidence",
    disposition: "block",
  },
  {
    key: "partner_rate_cards.org_contact_id",
    label: "partner rate cards",
    disposition: "block",
  },
  {
    key: "external_message_dispatches.contact_id",
    label: "message dispatch evidence",
    disposition: "preserve_historical",
  },
  {
    key: "eta_message_drafts.contact_id",
    label: "ETA drafts",
    disposition: "move",
  },
  {
    key: "appointments.contact_id",
    label: "appointments",
    disposition: "move",
  },
  {
    key: "appointment_holds.contact_id",
    label: "appointment holds",
    disposition: "move",
  },
  {
    key: "media_assets.contact_id",
    label: "media assets",
    disposition: "move",
  },
  {
    key: "partner_bookings.org_contact_id",
    label: "partner bookings",
    disposition: "block",
  },
  {
    key: "call_records.contact_id",
    label: "call records",
    disposition: "move",
  },
  { key: "quotes.contact_id", label: "quotes", disposition: "move" },
  {
    key: "instant_quotes.contact_id",
    label: "instant quotes",
    disposition: "move",
  },
  {
    key: "outbox_events.quarantined_contact_id",
    label: "quarantined provider work",
    disposition: "preserve_historical",
  },
  {
    key: "team_call_operations.contact_id",
    label: "manual-call evidence",
    disposition: "preserve_historical",
  },
  {
    key: "team_call_operation_task_intents.expected_contact_id",
    label: "manual-call task evidence",
    disposition: "preserve_historical",
  },
  {
    key: "sales_escalation_call_operations.contact_id",
    label: "sales-call evidence",
    disposition: "preserve_historical",
  },
  {
    key: "staff_notification_operations.contact_id",
    label: "staff-notification delivery evidence",
    disposition: "preserve_historical",
  },
  {
    key: "contacts.merged_into_contact_snapshot_id",
    label: "prior merged-contact recovery chain",
    disposition: "preserve_historical",
  },
  {
    key: "contact_merge_recovery_ledgers.source_contact_snapshot_id",
    label: "prior source merge ledger",
    disposition: "preserve_historical",
  },
  {
    key: "contact_merge_recovery_ledgers.target_contact_snapshot_id",
    label: "prior target merge ledger",
    disposition: "preserve_historical",
  },
  {
    key: "instant_quote_relationship_backfill_ambiguities.contact_ids",
    label: "unresolved instant-quote contact ambiguity",
    disposition: "block",
  },
] as const satisfies readonly MergeDependencyRule[];

const RULE_BY_KEY: ReadonlyMap<string, MergeDependencyRule> = new Map(
  CONTACT_MERGE_DEPENDENCY_RULES.map((rule) => [rule.key, rule]),
);

export function mergeDependencyRule(key: string): MergeDependencyRule | null {
  return RULE_BY_KEY.get(key) ?? null;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function normalizeStable(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non_finite_merge_hash_value");
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeStable);
  if (value && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (item !== undefined) result[key] = normalizeStable(item);
    }
    return result;
  }
  throw new Error("unsupported_merge_hash_value");
}

export function stableMergeJson(value: unknown): string {
  return JSON.stringify(normalizeStable(value));
}

export function buildMergePreviewHash(value: unknown): string {
  return createHash("sha256").update(stableMergeJson(value)).digest("hex");
}

export function contactMergeSnapshotsEqual(
  left: unknown,
  right: unknown,
): boolean {
  return stableMergeJson(left) === stableMergeJson(right);
}

export type ContactMergeEvidenceRow = {
  dependencyKey: string;
  entityId: string;
  ownerContactId: string | null;
  snapshot: Record<string, unknown>;
};

export type ContactMergeEvidenceDrift = {
  dependencyKey: string;
  entityId: string;
  reason:
    | "invalid_evidence"
    | "expected_record_missing"
    | "owner_changed"
    | "snapshot_changed"
    | "deduplicated_source_present"
    | "unexpected_record";
  expectedOwnerContactId: string | null;
  actualOwnerContactId: string | null;
};

export type ContactMergeEvidenceIdentity = {
  dependencyKey: string;
  entityId: string;
};

export function contactMergeExpectedEvidenceIdentity(
  afterState: unknown,
): ContactMergeEvidenceIdentity | null {
  const after = record(afterState);
  if (!after || typeof after["dependencyKey"] !== "string") return null;
  if (
    after["expectation"] === "present_exact" &&
    typeof after["entityId"] === "string"
  ) {
    return {
      dependencyKey: after["dependencyKey"],
      entityId: after["entityId"],
    };
  }
  if (
    after["expectation"] === "source_absent_retained_exact" &&
    typeof after["retainedEntityId"] === "string"
  ) {
    return {
      dependencyKey: after["dependencyKey"],
      entityId: after["retainedEntityId"],
    };
  }
  if (
    after["expectation"] === "source_absent_destination_exact" &&
    typeof after["destinationEntityId"] === "string"
  ) {
    return {
      dependencyKey: after["dependencyKey"],
      entityId: after["destinationEntityId"],
    };
  }
  return null;
}

export function compareContactMergeRecoveryEvidence(
  entryEntityId: string,
  afterState: unknown,
  currentRows: readonly ContactMergeEvidenceRow[],
): ContactMergeEvidenceDrift | null {
  const after = record(afterState);
  if (
    !after ||
    after["evidenceVersion"] !== 1 ||
    typeof after["dependencyKey"] !== "string"
  ) {
    return {
      dependencyKey: "unknown",
      entityId: entryEntityId,
      reason: "invalid_evidence",
      expectedOwnerContactId: null,
      actualOwnerContactId: null,
    };
  }
  const dependencyKey = after["dependencyKey"];
  if (after["expectation"] === "present_exact") {
    const expectedEntityId = after["entityId"];
    const expectedOwnerContactId = after["ownerContactId"];
    const expectedSnapshot = record(after["snapshot"]);
    if (
      typeof expectedEntityId !== "string" ||
      (typeof expectedOwnerContactId !== "string" &&
        expectedOwnerContactId !== null) ||
      !expectedSnapshot ||
      !exactKeys(after, [
        "evidenceVersion",
        "expectation",
        "dependencyKey",
        "entityId",
        "ownerContactId",
        "snapshot",
      ])
    ) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "invalid_evidence",
        expectedOwnerContactId: null,
        actualOwnerContactId: null,
      };
    }
    const current = currentRows.find(
      (row) =>
        row.dependencyKey === dependencyKey &&
        row.entityId === expectedEntityId,
    );
    if (!current) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "expected_record_missing",
        expectedOwnerContactId,
        actualOwnerContactId: null,
      };
    }
    if (current.ownerContactId !== expectedOwnerContactId) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "owner_changed",
        expectedOwnerContactId,
        actualOwnerContactId: current.ownerContactId,
      };
    }
    if (!contactMergeSnapshotsEqual(current.snapshot, expectedSnapshot)) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "snapshot_changed",
        expectedOwnerContactId,
        actualOwnerContactId: current.ownerContactId,
      };
    }
    return null;
  }
  if (after["expectation"] === "source_absent_retained_exact") {
    const sourceEntityId = after["sourceEntityId"];
    const retainedEntityId = after["retainedEntityId"];
    const expectedOwnerContactId = after["retainedOwnerContactId"];
    const retainedSnapshot = record(after["retainedSnapshot"]);
    if (
      typeof sourceEntityId !== "string" ||
      typeof retainedEntityId !== "string" ||
      (typeof expectedOwnerContactId !== "string" &&
        expectedOwnerContactId !== null) ||
      !retainedSnapshot ||
      !exactKeys(after, [
        "evidenceVersion",
        "expectation",
        "dependencyKey",
        "sourceEntityId",
        "retainedEntityId",
        "retainedOwnerContactId",
        "retainedSnapshot",
      ])
    ) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "invalid_evidence",
        expectedOwnerContactId: null,
        actualOwnerContactId: null,
      };
    }
    const sourceStillPresent = currentRows.find(
      (row) =>
        row.dependencyKey === dependencyKey && row.entityId === sourceEntityId,
    );
    if (sourceStillPresent) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "deduplicated_source_present",
        expectedOwnerContactId: null,
        actualOwnerContactId: sourceStillPresent.ownerContactId,
      };
    }
    const retained = currentRows.find(
      (row) =>
        row.dependencyKey === dependencyKey &&
        row.entityId === retainedEntityId,
    );
    if (!retained) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "expected_record_missing",
        expectedOwnerContactId,
        actualOwnerContactId: null,
      };
    }
    if (retained.ownerContactId !== expectedOwnerContactId) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "owner_changed",
        expectedOwnerContactId,
        actualOwnerContactId: retained.ownerContactId,
      };
    }
    if (!contactMergeSnapshotsEqual(retained.snapshot, retainedSnapshot)) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "snapshot_changed",
        expectedOwnerContactId,
        actualOwnerContactId: retained.ownerContactId,
      };
    }
    return null;
  }
  if (after["expectation"] === "source_absent_destination_exact") {
    const sourceEntityId = after["sourceEntityId"];
    const destinationEntityId = after["destinationEntityId"];
    const expectedOwnerContactId = after["destinationOwnerContactId"];
    const destinationSnapshot = record(after["destinationSnapshot"]);
    if (
      typeof sourceEntityId !== "string" ||
      typeof destinationEntityId !== "string" ||
      (typeof expectedOwnerContactId !== "string" &&
        expectedOwnerContactId !== null) ||
      !destinationSnapshot ||
      !exactKeys(after, [
        "evidenceVersion",
        "expectation",
        "dependencyKey",
        "sourceEntityId",
        "destinationEntityId",
        "destinationOwnerContactId",
        "destinationSnapshot",
      ])
    ) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "invalid_evidence",
        expectedOwnerContactId: null,
        actualOwnerContactId: null,
      };
    }
    const sourceStillPresent = currentRows.find(
      (row) =>
        row.dependencyKey === dependencyKey && row.entityId === sourceEntityId,
    );
    if (sourceStillPresent) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "deduplicated_source_present",
        expectedOwnerContactId: null,
        actualOwnerContactId: sourceStillPresent.ownerContactId,
      };
    }
    const destination = currentRows.find(
      (row) =>
        row.dependencyKey === dependencyKey &&
        row.entityId === destinationEntityId,
    );
    if (!destination) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "expected_record_missing",
        expectedOwnerContactId,
        actualOwnerContactId: null,
      };
    }
    if (destination.ownerContactId !== expectedOwnerContactId) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "owner_changed",
        expectedOwnerContactId,
        actualOwnerContactId: destination.ownerContactId,
      };
    }
    if (
      !contactMergeSnapshotsEqual(destination.snapshot, destinationSnapshot)
    ) {
      return {
        dependencyKey,
        entityId: entryEntityId,
        reason: "snapshot_changed",
        expectedOwnerContactId,
        actualOwnerContactId: destination.ownerContactId,
      };
    }
    return null;
  }
  return {
    dependencyKey,
    entityId: entryEntityId,
    reason: "invalid_evidence",
    expectedOwnerContactId: null,
    actualOwnerContactId: null,
  };
}

export function compareContactMergeRecoveryBaseline(
  entries: ReadonlyArray<{ entityId: string; after: unknown }>,
  currentRows: readonly ContactMergeEvidenceRow[],
): ContactMergeEvidenceDrift[] {
  const drifts: ContactMergeEvidenceDrift[] = [];
  const expected = new Set<string>();
  const identityKey = (dependencyKey: string, entityId: string) =>
    `${dependencyKey}\u0000${entityId}`;
  for (const entry of entries) {
    const identity = contactMergeExpectedEvidenceIdentity(entry.after);
    if (identity) {
      expected.add(identityKey(identity.dependencyKey, identity.entityId));
    }
    const drift = compareContactMergeRecoveryEvidence(
      entry.entityId,
      entry.after,
      currentRows,
    );
    if (drift) drifts.push(drift);
  }
  const unexpected = new Set<string>();
  for (const row of currentRows) {
    const key = identityKey(row.dependencyKey, row.entityId);
    if (expected.has(key) || unexpected.has(key)) continue;
    unexpected.add(key);
    drifts.push({
      dependencyKey: row.dependencyKey,
      entityId: row.entityId,
      reason: "unexpected_record",
      expectedOwnerContactId: null,
      actualOwnerContactId: row.ownerContactId,
    });
  }
  return drifts;
}

export type ContactMergeInventoryEvidence = {
  contactId: string;
  schemaName: string;
  tableName: string;
  columnName: string;
  referenceCount: number;
  supported: boolean;
};

export function contactMergeInventoryEvidenceFailures(
  contactId: string,
  inventory: readonly ContactMergeInventoryEvidence[],
  rows: readonly ContactMergeEvidenceRow[],
): string[] {
  const failures = new Set<string>();
  for (const item of inventory) {
    if (item.contactId !== contactId || item.referenceCount === 0) continue;
    const dependencyKey = `${item.tableName}.${item.columnName}`;
    const rule = mergeDependencyRule(dependencyKey);
    const evidencedCount = rows.filter(
      (row) =>
        row.dependencyKey === dependencyKey && row.ownerContactId === contactId,
    ).length;
    if (item.schemaName !== "public" || !item.supported || !rule) {
      failures.add(`unreviewed schema dependency (${dependencyKey})`);
    } else if (evidencedCount !== item.referenceCount) {
      failures.add(
        `incomplete dependency evidence (${dependencyKey}: expected ${item.referenceCount}, captured ${evidencedCount})`,
      );
    }
  }
  for (const row of rows) {
    if (
      row.ownerContactId === contactId &&
      !mergeDependencyRule(row.dependencyKey)
    ) {
      failures.add(`unreviewed dependency row (${row.dependencyKey})`);
    }
  }
  return Array.from(failures).sort();
}

export type ContactMergeOperationSafetyState = {
  contactId: string;
  unresolvedOutboxIds: string[];
  activeExternalDispatchIds: string[];
  activeManualCallIds: string[];
  activeSalesCallIds: string[];
  staleCompatibilityPropertyIds: string[];
};

export function contactMergeOperationSafetyFailures(
  state: ContactMergeOperationSafetyState | undefined,
): string[] {
  if (!state) return ["contact operation safety inventory unavailable"];
  const failures: string[] = [];
  if (state.unresolvedOutboxIds.length > 0)
    failures.push("queued external or automation work");
  if (state.activeExternalDispatchIds.length > 0)
    failures.push("message provider operations in progress or reconciliation");
  if (state.activeManualCallIds.length > 0)
    failures.push("manual calls in progress or reconciliation");
  if (state.activeSalesCallIds.length > 0)
    failures.push("sales calls in progress or reconciliation");
  if (state.staleCompatibilityPropertyIds.length > 0) {
    failures.push(
      `stale property compatibility ownership (${state.staleCompatibilityPropertyIds.length} record(s)); correct the property owner before merging`,
    );
  }
  return failures.sort();
}

export type MergeContactFieldSnapshot = {
  company: string | null;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
  salespersonMemberId: string | null;
  doNotContact: boolean;
  doNotContactAt: Date | null;
  doNotContactBy: string | null;
  doNotContactReason: string | null;
  preferredContactMethod: string | null;
  source: string | null;
};

export type ContactMergeConsolidationPlan = {
  ruleVersion: typeof CONTACT_MERGE_RULE_VERSION;
  identity: "target_nonempty_else_source";
  names: "target_wins";
  doNotContact: "deny_wins";
  uniqueDependencies: "target_wins_source_preserved_in_ledger";
  historicalEvidence: "retained_on_soft_deleted_source";
  legacyPropertyOwners: "move_linked_and_block_stale";
  targetPatch: Partial<MergeContactFieldSnapshot>;
  targetUpdatedFields: string[];
  sourceIdentityCleared: true;
};

export function buildContactConsolidationPlan(
  source: MergeContactFieldSnapshot,
  target: MergeContactFieldSnapshot,
): ContactMergeConsolidationPlan {
  const targetPatch: Partial<MergeContactFieldSnapshot> = {};
  const fill = <K extends keyof MergeContactFieldSnapshot>(key: K) => {
    if (
      (target[key] === null || target[key] === "") &&
      source[key] !== null &&
      source[key] !== ""
    ) {
      targetPatch[key] = source[key];
    }
  };
  fill("company");
  fill("email");
  fill("phone");
  fill("phoneE164");
  fill("salespersonMemberId");
  fill("source");

  // Do-not-contact is a safety deny. It can only become stricter during a
  // merge; target data is never allowed to clear a source opt-out.
  if (source.doNotContact && !target.doNotContact) {
    targetPatch.doNotContact = true;
    targetPatch.doNotContactAt = source.doNotContactAt;
    targetPatch.doNotContactBy = source.doNotContactBy;
    targetPatch.doNotContactReason = source.doNotContactReason;
  }

  return {
    ruleVersion: CONTACT_MERGE_RULE_VERSION,
    identity: "target_nonempty_else_source",
    names: "target_wins",
    doNotContact: "deny_wins",
    uniqueDependencies: "target_wins_source_preserved_in_ledger",
    historicalEvidence: "retained_on_soft_deleted_source",
    legacyPropertyOwners: "move_linked_and_block_stale",
    targetPatch,
    targetUpdatedFields: Object.keys(targetPatch).sort(),
    sourceIdentityCleared: true,
  };
}

export type MergeRecoveryAssessment = {
  automaticRecoveryAllowed: false;
  status: "manual_review_possible" | "unsafe";
  blockers: string[];
  guidance: string;
};

export function assessContactMergeRecovery(input: {
  sourcePresent: boolean;
  sourceStillBoundToLedger: boolean;
  targetPresent: boolean;
  targetVersionUnchanged: boolean;
  changedDependencyCount: number;
  unknownDependencyCount: number;
}): MergeRecoveryAssessment {
  const blockers: string[] = [];
  if (!input.sourcePresent)
    blockers.push("The merged source snapshot no longer exists.");
  if (!input.sourceStillBoundToLedger)
    blockers.push("The source no longer points to this recovery ledger.");
  if (!input.targetPresent)
    blockers.push("The kept target contact no longer exists.");
  if (!input.targetVersionUnchanged)
    blockers.push("The kept contact changed after the merge.");
  if (input.changedDependencyCount > 0)
    blockers.push(
      `${input.changedDependencyCount} recorded merge change(s) drifted after the merge.`,
    );
  if (input.unknownDependencyCount > 0)
    blockers.push(
      `${input.unknownDependencyCount} current dependency or inventory safety check(s) failed.`,
    );

  return {
    automaticRecoveryAllowed: false,
    status: blockers.length === 0 ? "manual_review_possible" : "unsafe",
    blockers,
    guidance:
      blockers.length === 0
        ? "The recorded changes are still intact. An owner must review and execute a separate, audited recovery procedure; this assessment never changes data."
        : "Do not reverse this merge automatically. Preserve the ledger and have an owner review the listed drift before any corrective migration.",
  };
}

import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import {
  getDb,
  partnerAccountLocations,
  partnerAccounts,
  partnerApprovalRules,
  partnerServiceCatalog,
} from "@/db";
import {
  parsePartnerApprovalRuleConditions,
  type PartnerApprovalRuleConditionsSnapshot,
} from "@/lib/partner-portal-v2-approvals";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";
import {
  encodePortalV2Cursor,
  type PortalV2Cursor,
} from "@/lib/portal-v2-contract";

export const PARTNER_APPROVAL_RULE_CURSOR_KIND = "partner-approval-rules-staff";
export const MAX_ACTIVE_PARTNER_APPROVAL_RULES = 50;
export const FIXED_PARTNER_APPROVER_CAPABILITIES = Object.freeze([
  "approvals.decide",
] as const);

const CANONICAL_CONDITION_KEYS = new Set([
  "serviceKeys",
  "locationIds",
  "minimumAmountMinor",
  "maximumAmountMinor",
  "requesterRoleKeys",
  "poNumberState",
  "costCenterState",
]);
const LAUNCH_ROLE_KEYS = new Set([
  "administrator",
  "operations",
  "billing_approver",
  "viewer",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ApprovalRuleRow = typeof partnerApprovalRules.$inferSelect;

export type StaffPartnerApprovalRule = Readonly<{
  id: string;
  partnerAccountId: string;
  name: string;
  conditions: PartnerApprovalRuleConditionsSnapshot;
  requiredApproverCapabilities: readonly ["approvals.decide"];
  requiredDecisionCount: number;
  active: boolean;
  revision: number;
  creator: Readonly<{
    type: "partner_membership" | "team_member";
    id: string;
  }>;
  updatedByTeamMemberId: string | null;
  createdAt: string;
  updatedAt: string;
  etag: string;
}>;

export type StaffPartnerApprovalRuleCursorPayload = Readonly<{
  partnerAccountId: string;
  includeInactive: boolean;
  createdAt: string;
  id: string;
}>;

export type StaffPartnerApprovalRulePage = Readonly<{
  items: readonly StaffPartnerApprovalRule[];
  page: Readonly<{
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
    returned: number;
  }>;
}>;

export type StaffPartnerApprovalRuleOptions = Readonly<{
  services: readonly Readonly<{ key: string; label: string }>[];
  locations: readonly Readonly<{
    id: string;
    label: string;
    address: string;
  }>[];
  servicesTruncated: boolean;
  locationsTruncated: boolean;
}>;

export type StaffPartnerApprovalRuleValues = Readonly<{
  name: string;
  conditions: PartnerApprovalRuleConditionsSnapshot;
  requiredDecisionCount: number;
  active: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRuleName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    normalized.length < 1 ||
    normalized.length > 160 ||
    [...normalized].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    })
  ) {
    return null;
  }
  return normalized;
}

function cloneConditions(
  conditions: PartnerApprovalRuleConditionsSnapshot,
): PartnerApprovalRuleConditionsSnapshot {
  return Object.freeze({
    ...(conditions.serviceKeys
      ? { serviceKeys: Object.freeze([...conditions.serviceKeys]) as string[] }
      : {}),
    ...(conditions.locationIds
      ? { locationIds: Object.freeze([...conditions.locationIds]) as string[] }
      : {}),
    ...(conditions.minimumAmountMinor !== undefined
      ? { minimumAmountMinor: conditions.minimumAmountMinor }
      : {}),
    ...(conditions.maximumAmountMinor !== undefined
      ? { maximumAmountMinor: conditions.maximumAmountMinor }
      : {}),
    ...(conditions.requesterRoleKeys
      ? {
          requesterRoleKeys: Object.freeze([
            ...conditions.requesterRoleKeys,
          ]) as string[],
        }
      : {}),
    ...(conditions.poNumberState
      ? { poNumberState: conditions.poNumberState }
      : {}),
    ...(conditions.costCenterState
      ? { costCenterState: conditions.costCenterState }
      : {}),
  });
}

/** Accepts only the canonical launch shape, never legacy aliases. */
export function normalizeStaffPartnerApprovalRuleValues(input: {
  name: unknown;
  conditions: unknown;
  requiredDecisionCount: unknown;
  active: unknown;
}): StaffPartnerApprovalRuleValues {
  const name = normalizeRuleName(input.name);
  if (!name) {
    throw new TeamMutationFailure(
      "invalid",
      "Enter an approval-rule name between 1 and 160 characters.",
      { fieldErrors: { name: "Enter a concise rule name." } },
    );
  }
  if (
    !isRecord(input.conditions) ||
    Object.keys(input.conditions).some(
      (key) => !CANONICAL_CONDITION_KEYS.has(key),
    )
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The approval-rule conditions are invalid.",
      {
        fieldErrors: { conditions: "Use only supported approval conditions." },
      },
    );
  }
  const parsed = parsePartnerApprovalRuleConditions(input.conditions);
  if (
    !parsed ||
    parsed.requesterRoleKeys?.some((roleKey) => !LAUNCH_ROLE_KEYS.has(roleKey))
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The approval-rule conditions are invalid.",
      {
        fieldErrors: {
          conditions:
            "Check service, location, amount, requester role, PO, and cost-center conditions.",
        },
      },
    );
  }
  if (
    !Number.isSafeInteger(input.requiredDecisionCount) ||
    Number(input.requiredDecisionCount) < 1 ||
    Number(input.requiredDecisionCount) > 20
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The required decision count is invalid.",
      {
        fieldErrors: { requiredDecisionCount: "Choose a value from 1 to 20." },
      },
    );
  }
  if (typeof input.active !== "boolean") {
    throw new TeamMutationFailure(
      "invalid",
      "Choose whether the rule is active.",
      {
        fieldErrors: { active: "Choose active or inactive." },
      },
    );
  }
  return Object.freeze({
    name,
    conditions: cloneConditions(parsed),
    requiredDecisionCount: Number(input.requiredDecisionCount),
    active: input.active,
  });
}

export function isStaffPartnerApprovalRuleCursorPayload(
  value: unknown,
): value is StaffPartnerApprovalRuleCursorPayload {
  if (!isRecord(value)) return false;
  const createdAt = value["createdAt"];
  const parsedAt = typeof createdAt === "string" ? new Date(createdAt) : null;
  return (
    Object.keys(value).sort().join(",") ===
      "createdAt,id,includeInactive,partnerAccountId" &&
    typeof value["partnerAccountId"] === "string" &&
    UUID_PATTERN.test(value["partnerAccountId"]) &&
    typeof value["includeInactive"] === "boolean" &&
    typeof value["id"] === "string" &&
    UUID_PATTERN.test(value["id"]) &&
    parsedAt !== null &&
    !Number.isNaN(parsedAt.getTime()) &&
    parsedAt.toISOString() === createdAt
  );
}

function serializeRule(row: ApprovalRuleRow): StaffPartnerApprovalRule {
  const conditions = parsePartnerApprovalRuleConditions(row.conditions);
  if (
    !conditions ||
    row.requiredApproverCapabilities.length !== 1 ||
    row.requiredApproverCapabilities[0] !== "approvals.decide" ||
    row.requiredApproverRoleKeys.length !== 0 ||
    (!row.createdByMembershipId && !row.createdByTeamMemberId) ||
    (row.createdByMembershipId && row.createdByTeamMemberId)
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "An approval rule is not safe to administer. Keep it inactive and reconcile its configuration.",
    );
  }
  const creator = row.createdByTeamMemberId
    ? ({ type: "team_member", id: row.createdByTeamMemberId } as const)
    : ({
        type: "partner_membership",
        id: row.createdByMembershipId!,
      } as const);
  return Object.freeze({
    id: row.id,
    partnerAccountId: row.partnerAccountId,
    name: row.name,
    conditions: cloneConditions(conditions),
    requiredApproverCapabilities: FIXED_PARTNER_APPROVER_CAPABILITIES,
    requiredDecisionCount: row.requiredDecisionCount,
    active: row.active,
    revision: row.version,
    creator: Object.freeze(creator),
    updatedByTeamMemberId: row.updatedByTeamMemberId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    etag: `"${row.version}"`,
  });
}

function cursorWhere(input: {
  cursor: PortalV2Cursor<StaffPartnerApprovalRuleCursorPayload> | null;
  partnerAccountId: string;
  includeInactive: boolean;
}): SQL | null {
  if (!input.cursor) return null;
  const payload = input.cursor.payload;
  if (
    payload.partnerAccountId !== input.partnerAccountId ||
    payload.includeInactive !== input.includeInactive
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The approval-rule cursor belongs to a different account or filter.",
      { fieldErrors: { cursor: "Return to the first approval-rule page." } },
    );
  }
  const createdAt = new Date(payload.createdAt);
  return or(
    lt(partnerApprovalRules.createdAt, createdAt),
    and(
      eq(partnerApprovalRules.createdAt, createdAt),
      lt(partnerApprovalRules.id, payload.id),
    ),
  )!;
}

export async function listPartnerApprovalRulesForStaff(input: {
  partnerAccountId: string;
  includeInactive: boolean;
  limit: number;
  cursor: PortalV2Cursor<StaffPartnerApprovalRuleCursorPayload> | null;
}): Promise<StaffPartnerApprovalRulePage | null> {
  const db = getDb();
  const [account] = await db
    .select({ id: partnerAccounts.id })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, input.partnerAccountId))
    .limit(1);
  if (!account) return null;
  const after = cursorWhere(input);
  const rows = await db
    .select()
    .from(partnerApprovalRules)
    .where(
      and(
        eq(partnerApprovalRules.partnerAccountId, input.partnerAccountId),
        input.includeInactive
          ? undefined
          : eq(partnerApprovalRules.active, true),
        after ?? undefined,
      ),
    )
    .orderBy(
      desc(partnerApprovalRules.createdAt),
      desc(partnerApprovalRules.id),
    )
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const last = pageRows.at(-1) ?? null;
  const nextCursor =
    hasMore && last
      ? encodePortalV2Cursor({
          kind: PARTNER_APPROVAL_RULE_CURSOR_KIND,
          limit: input.limit,
          payload: {
            partnerAccountId: input.partnerAccountId,
            includeInactive: input.includeInactive,
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          } satisfies StaffPartnerApprovalRuleCursorPayload,
        })
      : null;
  return Object.freeze({
    items: Object.freeze(pageRows.map(serializeRule)),
    page: Object.freeze({
      hasMore,
      limit: input.limit,
      nextCursor,
      returned: pageRows.length,
    }),
  });
}

export async function getPartnerApprovalRuleForStaff(input: {
  partnerAccountId: string;
  ruleId: string;
}): Promise<StaffPartnerApprovalRule | null> {
  const [row] = await getDb()
    .select()
    .from(partnerApprovalRules)
    .where(
      and(
        eq(partnerApprovalRules.partnerAccountId, input.partnerAccountId),
        eq(partnerApprovalRules.id, input.ruleId),
      ),
    )
    .limit(1);
  return row ? serializeRule(row) : null;
}

export async function listPartnerApprovalRuleOptionsForStaff(input: {
  partnerAccountId: string;
}): Promise<StaffPartnerApprovalRuleOptions> {
  const [services, locations] = await Promise.all([
    getDb()
      .select({
        key: partnerServiceCatalog.key,
        label: partnerServiceCatalog.label,
      })
      .from(partnerServiceCatalog)
      .where(eq(partnerServiceCatalog.active, true))
      .orderBy(partnerServiceCatalog.label, partnerServiceCatalog.key)
      .limit(201),
    getDb()
      .select({
        id: partnerAccountLocations.id,
        siteName: partnerAccountLocations.siteName,
        addressLine1: partnerAccountLocations.addressLine1,
        city: partnerAccountLocations.city,
        state: partnerAccountLocations.state,
        postalCode: partnerAccountLocations.postalCode,
      })
      .from(partnerAccountLocations)
      .where(
        and(
          eq(partnerAccountLocations.partnerAccountId, input.partnerAccountId),
          eq(partnerAccountLocations.active, true),
        ),
      )
      .orderBy(partnerAccountLocations.siteName, partnerAccountLocations.id)
      .limit(501),
  ]);
  return Object.freeze({
    services: Object.freeze(
      services.slice(0, 200).map((service) => Object.freeze(service)),
    ),
    locations: Object.freeze(
      locations.slice(0, 500).map((location) =>
        Object.freeze({
          id: location.id,
          label: location.siteName,
          address: `${location.addressLine1}, ${location.city}, ${location.state} ${location.postalCode}`,
        }),
      ),
    ),
    servicesTruncated: services.length > 200,
    locationsTruncated: locations.length > 500,
  });
}

async function lockAccount(
  tx: TeamMutationTransaction,
  partnerAccountId: string,
): Promise<void> {
  const [account] = await tx
    .select({ id: partnerAccounts.id })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, partnerAccountId))
    .for("update")
    .limit(1);
  if (!account) {
    throw new TeamMutationFailure(
      "invalid",
      "The partner account was not found.",
      {
        status: 404,
      },
    );
  }
}

async function validateConditionTargets(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    conditions: PartnerApprovalRuleConditionsSnapshot;
    requireActive: boolean;
  },
): Promise<void> {
  if (input.conditions.serviceKeys?.length) {
    const rows = await tx
      .select({ key: partnerServiceCatalog.key })
      .from(partnerServiceCatalog)
      .where(
        and(
          inArray(partnerServiceCatalog.key, input.conditions.serviceKeys),
          input.requireActive
            ? eq(partnerServiceCatalog.active, true)
            : undefined,
        ),
      );
    if (
      new Set(rows.map((row) => row.key)).size !==
      input.conditions.serviceKeys.length
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "One or more approval-rule services are unavailable.",
        { fieldErrors: { serviceKeys: "Choose active catalog services." } },
      );
    }
  }
  if (input.conditions.locationIds?.length) {
    const rows = await tx
      .select({ id: partnerAccountLocations.id })
      .from(partnerAccountLocations)
      .where(
        and(
          eq(partnerAccountLocations.partnerAccountId, input.partnerAccountId),
          inArray(partnerAccountLocations.id, input.conditions.locationIds),
          input.requireActive
            ? eq(partnerAccountLocations.active, true)
            : undefined,
        ),
      );
    if (
      new Set(rows.map((row) => row.id)).size !==
      input.conditions.locationIds.length
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "One or more approval-rule locations are unavailable for this account.",
        { fieldErrors: { locationIds: "Choose locations from this account." } },
      );
    }
  }
}

async function assertActiveRuleCapacity(
  tx: TeamMutationTransaction,
  partnerAccountId: string,
  existingRuleId?: string,
): Promise<void> {
  const active = await tx
    .select({ id: partnerApprovalRules.id })
    .from(partnerApprovalRules)
    .where(
      and(
        eq(partnerApprovalRules.partnerAccountId, partnerAccountId),
        eq(partnerApprovalRules.active, true),
      ),
    )
    .limit(MAX_ACTIVE_PARTNER_APPROVAL_RULES + 1);
  const otherActiveCount = active.reduce(
    (count, rule) => count + (rule.id === existingRuleId ? 0 : 1),
    0,
  );
  if (otherActiveCount >= MAX_ACTIVE_PARTNER_APPROVAL_RULES) {
    throw new TeamMutationFailure(
      "conflict",
      "This account already has the maximum number of active approval rules. Deactivate an existing rule before activating another.",
    );
  }
}

function ruleSnapshot(row: ApprovalRuleRow): Record<string, unknown> {
  const serialized = serializeRule(row);
  return {
    id: serialized.id,
    partnerAccountId: serialized.partnerAccountId,
    name: serialized.name,
    conditions: serialized.conditions,
    requiredApproverCapabilities: serialized.requiredApproverCapabilities,
    requiredDecisionCount: serialized.requiredDecisionCount,
    active: serialized.active,
    revision: serialized.revision,
    creator: serialized.creator,
    updatedByTeamMemberId: serialized.updatedByTeamMemberId,
    createdAt: serialized.createdAt,
    updatedAt: serialized.updatedAt,
  };
}

export async function createPartnerApprovalRuleAsStaff(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    values: StaffPartnerApprovalRuleValues;
    teamMemberId: string;
    now?: Date;
  },
): Promise<{
  rule: StaffPartnerApprovalRule;
  before: null;
  after: Record<string, unknown>;
}> {
  const values = normalizeStaffPartnerApprovalRuleValues(input.values);
  await lockAccount(tx, input.partnerAccountId);
  await validateConditionTargets(tx, {
    partnerAccountId: input.partnerAccountId,
    conditions: values.conditions,
    requireActive: values.active,
  });
  if (values.active) {
    await assertActiveRuleCapacity(tx, input.partnerAccountId);
  }
  const now = input.now ?? new Date();
  const [inserted] = await tx
    .insert(partnerApprovalRules)
    .values({
      partnerAccountId: input.partnerAccountId,
      name: values.name,
      conditions: values.conditions,
      requiredApproverRoleKeys: [],
      requiredApproverCapabilities: [...FIXED_PARTNER_APPROVER_CAPABILITIES],
      requiredDecisionCount: values.requiredDecisionCount,
      active: values.active,
      version: 1,
      createdByMembershipId: null,
      createdByTeamMemberId: input.teamMemberId,
      updatedByTeamMemberId: input.teamMemberId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!inserted) throw new Error("partner_approval_rule_create_failed");
  return {
    rule: serializeRule(inserted),
    before: null,
    after: ruleSnapshot(inserted),
  };
}

export async function updatePartnerApprovalRuleAsStaff(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    ruleId: string;
    values: StaffPartnerApprovalRuleValues;
    expectedVersion: string;
    teamMemberId: string;
    now?: Date;
  },
): Promise<{
  rule: StaffPartnerApprovalRule;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}> {
  const values = normalizeStaffPartnerApprovalRuleValues(input.values);
  await lockAccount(tx, input.partnerAccountId);
  const [current] = await tx
    .select()
    .from(partnerApprovalRules)
    .where(
      and(
        eq(partnerApprovalRules.partnerAccountId, input.partnerAccountId),
        eq(partnerApprovalRules.id, input.ruleId),
      ),
    )
    .for("update")
    .limit(1);
  if (!current) {
    throw new TeamMutationFailure(
      "invalid",
      "The approval rule was not found.",
      {
        status: 404,
      },
    );
  }
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    current.version,
  );
  await validateConditionTargets(tx, {
    partnerAccountId: input.partnerAccountId,
    conditions: values.conditions,
    requireActive: values.active,
  });
  if (values.active) {
    await assertActiveRuleCapacity(tx, input.partnerAccountId, current.id);
  }
  const now = input.now ?? new Date();
  const [updated] = await tx
    .update(partnerApprovalRules)
    .set({
      name: values.name,
      conditions: values.conditions,
      requiredApproverRoleKeys: [],
      requiredApproverCapabilities: [...FIXED_PARTNER_APPROVER_CAPABILITIES],
      requiredDecisionCount: values.requiredDecisionCount,
      active: values.active,
      version: sql`${partnerApprovalRules.version} + 1`,
      updatedByTeamMemberId: input.teamMemberId,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerApprovalRules.partnerAccountId, input.partnerAccountId),
        eq(partnerApprovalRules.id, input.ruleId),
        eq(partnerApprovalRules.version, current.version),
      ),
    )
    .returning();
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The approval rule changed while it was being saved. Refresh and try again.",
      { retryable: true },
    );
  }
  return {
    rule: serializeRule(updated),
    before: ruleSnapshot(current),
    after: ruleSnapshot(updated),
  };
}

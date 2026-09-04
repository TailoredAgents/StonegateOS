import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import {
  appointmentHolds,
  appointments,
  auditLogs,
  getDb,
  outboxEvents,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerApprovalDecisions,
  partnerApprovalRequests,
  partnerApprovalRules,
  partnerBookings,
  partnerJobEvents,
  partnerRoleTemplates,
  partnerUsers,
  type DatabaseClient,
} from "@/db";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import {
  computePartnerCapabilities,
  type PartnerPrincipal,
} from "@/lib/partner-account-authorization";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import type { PortalV2StoredResult } from "@/lib/partner-portal-v2-idempotency";
import {
  createPortalV2StrongEtag,
  encodePortalV2Cursor,
  evaluatePortalV2RevisionPrecondition,
  parsePortalV2Pagination,
  parsePortalV2Rfc3339,
} from "@/lib/portal-v2-contract";
import { isPortalV2Uuid } from "@/lib/partner-portal-v2-security";

const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/u;
const SERVICE_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,79}$/u;
const MAX_ACTIVE_APPROVAL_RULES = 50;
const APPROVAL_STATES = new Set([
  "pending",
  "approved",
  "declined",
  "expired",
  "approved_needs_reschedule",
  "withdrawn",
]);

const APPROVAL_RULE_CONDITION_KEYS = new Set([
  "serviceKey",
  "serviceKeys",
  "locationId",
  "locationIds",
  "minimumAmountMinor",
  "minimumAmountCents",
  "maximumAmountMinor",
  "maximumAmountCents",
  "requesterRoleKey",
  "requesterRoleKeys",
  "poNumberState",
  "poNumberRequired",
  "poRequired",
  "requiresPoNumber",
  "costCenterState",
  "costCenterRequired",
  "requiresCostCenter",
]);

export type PartnerApprovalPresence = "present" | "missing";

/**
 * Canonical, immutable selectors captured with an approval request. Database
 * rules may use the documented singular and legacy `*Cents` aliases, but the
 * request snapshot always uses this normalized shape.
 */
export type PartnerApprovalRuleConditionsSnapshot = {
  serviceKeys?: string[];
  locationIds?: string[];
  minimumAmountMinor?: number;
  maximumAmountMinor?: number;
  requesterRoleKeys?: string[];
  poNumberState?: PartnerApprovalPresence;
  costCenterState?: PartnerApprovalPresence;
};

export type ApprovalRuleSnapshot = {
  id: string;
  name: string;
  version: number;
  requiredApproverCapabilities: string[];
  /** Legacy display/migration projection; never used as authority. */
  requiredApproverRoleKeys: string[];
  requiredDecisionCount: number;
  conditions?: PartnerApprovalRuleConditionsSnapshot;
};

export type ApprovalDecisionSnapshot = {
  membershipId: string;
  roleKey: string;
  capabilities?: string[];
  decision: "approved" | "declined";
};

export type ApprovalRulesEvaluation =
  | { ok: false; reason: "invalid_rules" }
  | {
      ok: true;
      actorEligible: boolean;
      approved: boolean;
      declined: boolean;
      approvedDecisionCount: number;
      eligibleRuleIds: string[];
      rules: Array<{
        id: string;
        approvedDecisionCount: number;
        requiredDecisionCount: number;
        satisfied: boolean;
      }>;
    };

function firstDefined(
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  return keys.map((key) => record[key]).find((value) => value !== undefined);
}

function safeText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const safe = [...normalized]
    .filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 32 && point !== 127;
    })
    .join("");
  return safe.slice(0, maximum) || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseAliasedStringList(input: {
  record: Record<string, unknown>;
  singularKey: string;
  pluralKey: string;
  pattern: RegExp;
  maximumItems: number;
}): { ok: true; value: string[] | undefined } | { ok: false } {
  const hasSingular = input.record[input.singularKey] !== undefined;
  const hasPlural = input.record[input.pluralKey] !== undefined;
  if (hasSingular && hasPlural) return { ok: false };
  if (!hasSingular && !hasPlural) return { ok: true, value: undefined };
  const raw = hasSingular
    ? [input.record[input.singularKey]]
    : input.record[input.pluralKey];
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > input.maximumItems ||
    raw.some((value) => typeof value !== "string" || !input.pattern.test(value))
  ) {
    return { ok: false };
  }
  const values = raw as string[];
  if (new Set(values).size !== values.length) return { ok: false };
  return { ok: true, value: [...values] };
}

function parseAliasedNonNegativeInteger(input: {
  record: Record<string, unknown>;
  keys: readonly string[];
}): { ok: true; value: number | undefined } | { ok: false } {
  const defined = input.keys.filter((key) => input.record[key] !== undefined);
  if (defined.length > 1) return { ok: false };
  if (defined.length === 0) return { ok: true, value: undefined };
  const value = input.record[defined[0]!];
  if (!Number.isSafeInteger(value) || Number(value) < 0) return { ok: false };
  return { ok: true, value: Number(value) };
}

function parsePresenceCondition(input: {
  record: Record<string, unknown>;
  stateKey: string;
  booleanKeys: readonly string[];
}): { ok: true; value: PartnerApprovalPresence | undefined } | { ok: false } {
  const defined = [input.stateKey, ...input.booleanKeys].filter(
    (key) => input.record[key] !== undefined,
  );
  if (defined.length > 1) return { ok: false };
  if (defined.length === 0) return { ok: true, value: undefined };
  const key = defined[0]!;
  const value = input.record[key];
  if (key === input.stateKey) {
    return value === "present" || value === "missing"
      ? { ok: true, value }
      : { ok: false };
  }
  return typeof value === "boolean"
    ? { ok: true, value: value ? "present" : "missing" }
    : { ok: false };
}

/**
 * Parses an approval-rule condition using strict all-known-key semantics.
 * Returning null is a fail-closed signal: callers must not silently skip the
 * malformed active rule.
 */
export function parsePartnerApprovalRuleConditions(
  value: unknown,
): PartnerApprovalRuleConditionsSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    Object.keys(value).some((key) => !APPROVAL_RULE_CONDITION_KEYS.has(key))
  ) {
    return null;
  }
  const services = parseAliasedStringList({
    record: value,
    singularKey: "serviceKey",
    pluralKey: "serviceKeys",
    pattern: SERVICE_KEY_PATTERN,
    maximumItems: 50,
  });
  const locations = parseAliasedStringList({
    record: value,
    singularKey: "locationId",
    pluralKey: "locationIds",
    pattern:
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    maximumItems: 100,
  });
  const requesterRoles = parseAliasedStringList({
    record: value,
    singularKey: "requesterRoleKey",
    pluralKey: "requesterRoleKeys",
    pattern: ROLE_KEY_PATTERN,
    maximumItems: 20,
  });
  const minimumAmount = parseAliasedNonNegativeInteger({
    record: value,
    keys: ["minimumAmountMinor", "minimumAmountCents"],
  });
  const maximumAmount = parseAliasedNonNegativeInteger({
    record: value,
    keys: ["maximumAmountMinor", "maximumAmountCents"],
  });
  const poNumberState = parsePresenceCondition({
    record: value,
    stateKey: "poNumberState",
    booleanKeys: ["poNumberRequired", "poRequired", "requiresPoNumber"],
  });
  const costCenterState = parsePresenceCondition({
    record: value,
    stateKey: "costCenterState",
    booleanKeys: ["costCenterRequired", "requiresCostCenter"],
  });
  if (
    !services.ok ||
    !locations.ok ||
    !requesterRoles.ok ||
    !minimumAmount.ok ||
    !maximumAmount.ok ||
    !poNumberState.ok ||
    !costCenterState.ok ||
    (minimumAmount.value !== undefined &&
      maximumAmount.value !== undefined &&
      maximumAmount.value < minimumAmount.value)
  ) {
    return null;
  }
  const result: PartnerApprovalRuleConditionsSnapshot = {};
  if (services.value) result.serviceKeys = [...services.value];
  if (locations.value) result.locationIds = [...locations.value];
  if (minimumAmount.value !== undefined)
    result.minimumAmountMinor = minimumAmount.value;
  if (maximumAmount.value !== undefined)
    result.maximumAmountMinor = maximumAmount.value;
  if (requesterRoles.value)
    result.requesterRoleKeys = [...requesterRoles.value];
  if (poNumberState.value) result.poNumberState = poNumberState.value;
  if (costCenterState.value) result.costCenterState = costCenterState.value;
  return result;
}

export function parseApprovalRuleSnapshots(
  value: unknown,
): ApprovalRuleSnapshot[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    return null;
  }
  const rules: ApprovalRuleSnapshot[] = [];
  for (const [index, candidate] of value.entries()) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const record = candidate as Record<string, unknown>;
    const rawId = firstDefined(record, ["id", "ruleId", "rule_id"]);
    const id =
      typeof rawId === "string" &&
      (isPortalV2Uuid(rawId) || /^[a-z][a-z0-9_.:-]{1,127}$/u.test(rawId))
        ? rawId
        : `snapshot-rule-${index + 1}`;
    const name = safeText(record["name"], 160) ?? `Approval rule ${index + 1}`;
    const rawVersion = record["version"];
    const version =
      Number.isSafeInteger(rawVersion) && Number(rawVersion) > 0
        ? Number(rawVersion)
        : 1;
    const rawRoles = firstDefined(record, [
      "requiredApproverRoleKeys",
      "required_approver_role_keys",
      "approverRoleKeys",
    ]);
    if (
      rawRoles !== undefined &&
      (!Array.isArray(rawRoles) ||
        rawRoles.some(
          (role) => typeof role !== "string" || !ROLE_KEY_PATTERN.test(role),
        ))
    ) {
      return null;
    }
    const roles = [...new Set((rawRoles ?? []) as string[])];
    const rawCapabilities = firstDefined(record, [
      "requiredApproverCapabilities",
      "required_approver_capabilities",
    ]);
    if (
      rawCapabilities !== undefined &&
      (!Array.isArray(rawCapabilities) ||
        rawCapabilities.some(
          (capability) =>
            typeof capability !== "string" ||
            !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(capability),
        ))
    ) {
      return null;
    }
    // Legacy snapshots carried role names. They are accepted only as a
    // migration shape and are converted to the stable approval capability.
    const capabilities = [
      ...new Set(
        (rawCapabilities as string[] | undefined) ??
          (roles.length ? ["approvals.decide"] : []),
      ),
    ];
    const rawCount = firstDefined(record, [
      "requiredDecisionCount",
      "required_decision_count",
    ]);
    const requiredDecisionCount = Number(rawCount);
    if (
      capabilities.length < 1 ||
      capabilities.length > 20 ||
      roles.length > 20 ||
      !Number.isSafeInteger(requiredDecisionCount) ||
      requiredDecisionCount < 1 ||
      requiredDecisionCount > 20
    ) {
      return null;
    }
    const rawConditions = record["conditions"];
    const conditions =
      rawConditions === undefined
        ? undefined
        : parsePartnerApprovalRuleConditions(rawConditions);
    if (rawConditions !== undefined && !conditions) return null;
    rules.push({
      id,
      name,
      version,
      requiredApproverCapabilities: capabilities,
      requiredApproverRoleKeys: roles,
      requiredDecisionCount,
      ...(conditions ? { conditions } : {}),
    });
  }
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) return null;
  return rules;
}

/**
 * Every rule captured in the request snapshot is a matching rule and must be
 * satisfied independently. A single immutable approval may satisfy multiple
 * rules when its snapshotted role is eligible for each rule.
 */
export function evaluateAllMatchingApprovalRules(input: {
  ruleSnapshot: unknown;
  requiredDecisionCount: number;
  decisions: readonly ApprovalDecisionSnapshot[];
  actorCapabilities?: readonly string[];
  /** Migration-only compatibility input; live authorization passes capabilities. */
  actorRoleKey?: string;
}): ApprovalRulesEvaluation {
  const rules = parseApprovalRuleSnapshots(input.ruleSnapshot);
  if (
    !rules ||
    !Number.isSafeInteger(input.requiredDecisionCount) ||
    input.requiredDecisionCount < 1 ||
    input.requiredDecisionCount > 20
  ) {
    return { ok: false, reason: "invalid_rules" };
  }
  const decisionsByMembership = new Map<string, ApprovalDecisionSnapshot>();
  for (const decision of input.decisions) {
    if (
      !isPortalV2Uuid(decision.membershipId) ||
      !ROLE_KEY_PATTERN.test(decision.roleKey) ||
      (decision.capabilities !== undefined &&
        (!Array.isArray(decision.capabilities) ||
          decision.capabilities.some(
            (capability) =>
              typeof capability !== "string" ||
              !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(capability),
          ))) ||
      !["approved", "declined"].includes(decision.decision) ||
      decisionsByMembership.has(decision.membershipId)
    ) {
      return { ok: false, reason: "invalid_rules" };
    }
    decisionsByMembership.set(decision.membershipId, decision);
  }
  const decisions = [...decisionsByMembership.values()];
  const approvedDecisions = decisions.filter(
    (decision) => decision.decision === "approved",
  );
  const declined = decisions.some(
    (decision) => decision.decision === "declined",
  );
  const ruleResults = rules.map((rule) => {
    const approvedDecisionCount = approvedDecisions.filter((decision) =>
      rule.requiredApproverCapabilities.every((capability) =>
        (decision.capabilities ?? ["approvals.decide"]).includes(capability),
      ),
    ).length;
    return {
      id: rule.id,
      approvedDecisionCount,
      requiredDecisionCount: rule.requiredDecisionCount,
      satisfied: approvedDecisionCount >= rule.requiredDecisionCount,
    };
  });
  const actorCapabilities =
    input.actorCapabilities ?? (input.actorRoleKey ? ["approvals.decide"] : []);
  const eligibleRuleIds = actorCapabilities.length
    ? rules
        .filter((rule) =>
          rule.requiredApproverCapabilities.every((capability) =>
            actorCapabilities.includes(capability),
          ),
        )
        .map((rule) => rule.id)
    : [];
  return {
    ok: true,
    actorEligible: eligibleRuleIds.length > 0,
    approved:
      !declined &&
      approvedDecisions.length >= input.requiredDecisionCount &&
      ruleResults.every((rule) => rule.satisfied),
    declined,
    approvedDecisionCount: approvedDecisions.length,
    eligibleRuleIds,
    rules: ruleResults,
  };
}

export type PartnerApprovalTransaction = Parameters<
  DatabaseClient["transaction"]
>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;

export type PartnerApprovalRuleCandidate = Readonly<
  Omit<
    Pick<
      typeof partnerApprovalRules.$inferSelect,
      | "id"
      | "partnerAccountId"
      | "name"
      | "conditions"
      | "requiredApproverCapabilities"
      | "requiredApproverRoleKeys"
      | "requiredDecisionCount"
      | "active"
      | "version"
    >,
    "requiredApproverCapabilities"
  > & {
    requiredApproverCapabilities?: string[];
  }
>;

export type PartnerApprovalRuleMatchContext = Readonly<{
  partnerAccountId: string;
  requestedByMembershipId: string;
  requesterRoleKey: string;
  serviceKey: string;
  locationId: string;
  amountMinor: number | null;
  currency: string;
  poNumber: string | null;
  costCenter: string | null;
}>;

type PartnerApprovalResolutionBase = Readonly<{
  context: PartnerApprovalRuleMatchContext;
}>;

export type PartnerApprovalRequirementResolution =
  | (PartnerApprovalResolutionBase &
      Readonly<{
        required: false;
        requiredDecisionCount: 0;
        matchedRules: readonly [];
      }>)
  | (PartnerApprovalResolutionBase &
      Readonly<{
        required: true;
        requiredDecisionCount: number;
        matchedRules: readonly Readonly<ApprovalRuleSnapshot>[];
      }>);

export type PartnerApprovalRuleResolutionErrorCode =
  | "invalid_context"
  | "requester_not_found"
  | "malformed_active_rule"
  | "too_many_active_rules"
  | "approval_not_required"
  | "invalid_target"
  | "invalid_approval_hold"
  | "invalid_request_snapshot";

/** An internal, fail-closed error; routes must map it to a safe public error. */
export class PartnerApprovalRuleResolutionError extends Error {
  readonly code: PartnerApprovalRuleResolutionErrorCode;
  readonly ruleId: string | null;

  constructor(
    code: PartnerApprovalRuleResolutionErrorCode,
    options: { ruleId?: string | null } = {},
  ) {
    super(
      code === "malformed_active_rule"
        ? "An active partner approval rule is invalid."
        : "The partner approval request could not be constructed safely.",
    );
    this.name = "PartnerApprovalRuleResolutionError";
    this.code = code;
    this.ruleId = options.ruleId ?? null;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function normalizedBoundedText(
  value: unknown,
  maximum: number,
  options: { optional: boolean },
): string | null {
  if (value === null || value === undefined || value === "") {
    if (options.optional) return null;
    throw new PartnerApprovalRuleResolutionError("invalid_context");
  }
  if (typeof value !== "string") {
    throw new PartnerApprovalRuleResolutionError("invalid_context");
  }
  const normalized = value.normalize("NFKC").trim();
  const invalidControl = [...normalized].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point === 127 || (point < 32 && ![9, 10, 13].includes(point));
  });
  if (!normalized || normalized.length > maximum || invalidControl) {
    throw new PartnerApprovalRuleResolutionError("invalid_context");
  }
  return normalized;
}

function normalizePartnerApprovalContext(
  input: PartnerApprovalRuleMatchContext,
): PartnerApprovalRuleMatchContext {
  if (
    !isPortalV2Uuid(input.partnerAccountId) ||
    !isPortalV2Uuid(input.requestedByMembershipId) ||
    !isPortalV2Uuid(input.locationId) ||
    (input.amountMinor !== null &&
      (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0))
  ) {
    throw new PartnerApprovalRuleResolutionError("invalid_context");
  }
  const requesterRoleKey = normalizedBoundedText(input.requesterRoleKey, 64, {
    optional: false,
  });
  const serviceKey = normalizedBoundedText(input.serviceKey, 80, {
    optional: false,
  });
  const currency = normalizedBoundedText(input.currency, 3, {
    optional: false,
  });
  if (
    !requesterRoleKey ||
    !ROLE_KEY_PATTERN.test(requesterRoleKey) ||
    !serviceKey ||
    !SERVICE_KEY_PATTERN.test(serviceKey) ||
    !currency ||
    !/^[A-Z]{3}$/u.test(currency)
  ) {
    throw new PartnerApprovalRuleResolutionError("invalid_context");
  }
  return deepFreeze({
    partnerAccountId: input.partnerAccountId.toLowerCase(),
    requestedByMembershipId: input.requestedByMembershipId.toLowerCase(),
    requesterRoleKey,
    serviceKey,
    locationId: input.locationId.toLowerCase(),
    amountMinor: input.amountMinor,
    currency,
    poNumber: normalizedBoundedText(input.poNumber, 500, { optional: true }),
    costCenter: normalizedBoundedText(input.costCenter, 500, {
      optional: true,
    }),
  });
}

function activeApprovalRuleSnapshot(
  row: PartnerApprovalRuleCandidate,
  accountId: string,
): Readonly<ApprovalRuleSnapshot> {
  const ruleId = isPortalV2Uuid(row.id) ? row.id : null;
  const name = safeText(row.name, 10_000);
  const capabilities = row.requiredApproverCapabilities ?? ["approvals.decide"];
  const roles = row.requiredApproverRoleKeys;
  const conditions = parsePartnerApprovalRuleConditions(row.conditions);
  if (
    !ruleId ||
    row.partnerAccountId !== accountId ||
    row.active !== true ||
    !name ||
    name.length > 160 ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    !Array.isArray(capabilities) ||
    capabilities.length < 1 ||
    capabilities.length > 20 ||
    capabilities.some(
      (capability) =>
        typeof capability !== "string" ||
        !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(capability),
    ) ||
    new Set(capabilities).size !== capabilities.length ||
    !Array.isArray(roles) ||
    roles.length > 20 ||
    roles.some(
      (role) => typeof role !== "string" || !ROLE_KEY_PATTERN.test(role),
    ) ||
    new Set(roles).size !== roles.length ||
    !Number.isSafeInteger(row.requiredDecisionCount) ||
    row.requiredDecisionCount < 1 ||
    row.requiredDecisionCount > 20 ||
    !conditions
  ) {
    throw new PartnerApprovalRuleResolutionError("malformed_active_rule", {
      ruleId,
    });
  }
  return deepFreeze({
    id: ruleId,
    name,
    version: row.version,
    requiredApproverCapabilities: [...capabilities],
    requiredApproverRoleKeys: [...roles],
    requiredDecisionCount: row.requiredDecisionCount,
    conditions: {
      ...(conditions.serviceKeys
        ? { serviceKeys: [...conditions.serviceKeys] }
        : {}),
      ...(conditions.locationIds
        ? { locationIds: [...conditions.locationIds] }
        : {}),
      ...(conditions.minimumAmountMinor !== undefined
        ? { minimumAmountMinor: conditions.minimumAmountMinor }
        : {}),
      ...(conditions.maximumAmountMinor !== undefined
        ? { maximumAmountMinor: conditions.maximumAmountMinor }
        : {}),
      ...(conditions.requesterRoleKeys
        ? { requesterRoleKeys: [...conditions.requesterRoleKeys] }
        : {}),
      ...(conditions.poNumberState
        ? { poNumberState: conditions.poNumberState }
        : {}),
      ...(conditions.costCenterState
        ? { costCenterState: conditions.costCenterState }
        : {}),
    },
  });
}

function approvalRuleMatches(
  rule: Readonly<ApprovalRuleSnapshot>,
  context: PartnerApprovalRuleMatchContext,
): boolean {
  const conditions = rule.conditions ?? {};
  return (
    (!conditions.serviceKeys ||
      conditions.serviceKeys.includes(context.serviceKey)) &&
    (!conditions.locationIds ||
      conditions.locationIds.includes(context.locationId)) &&
    (conditions.minimumAmountMinor === undefined ||
      context.amountMinor === null ||
      context.amountMinor >= conditions.minimumAmountMinor) &&
    (conditions.maximumAmountMinor === undefined ||
      context.amountMinor === null ||
      context.amountMinor <= conditions.maximumAmountMinor) &&
    (!conditions.requesterRoleKeys ||
      conditions.requesterRoleKeys.includes(context.requesterRoleKey)) &&
    (!conditions.poNumberState ||
      conditions.poNumberState ===
        (context.poNumber ? "present" : "missing")) &&
    (!conditions.costCenterState ||
      conditions.costCenterState ===
        (context.costCenter ? "present" : "missing"))
  );
}

/**
 * Pure rule resolution used by tests and by the transaction-bound loader.
 * Every active rule is validated before any matching result is returned.
 */
export function resolvePartnerApprovalRequirementFromRules(input: {
  context: PartnerApprovalRuleMatchContext;
  rules: readonly PartnerApprovalRuleCandidate[];
}): PartnerApprovalRequirementResolution {
  const context = normalizePartnerApprovalContext(input.context);
  const activeRules = input.rules.filter((rule) => rule.active);
  if (activeRules.length > MAX_ACTIVE_APPROVAL_RULES) {
    throw new PartnerApprovalRuleResolutionError("too_many_active_rules");
  }
  const seenRuleIds = new Set<string>();
  const snapshots = activeRules
    .map((row) => activeApprovalRuleSnapshot(row, context.partnerAccountId))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
  for (const snapshot of snapshots) {
    if (seenRuleIds.has(snapshot.id)) {
      throw new PartnerApprovalRuleResolutionError("malformed_active_rule", {
        ruleId: snapshot.id,
      });
    }
    seenRuleIds.add(snapshot.id);
  }
  const matchedRules = deepFreeze(
    snapshots.filter((rule) => approvalRuleMatches(rule, context)),
  );
  if (matchedRules.length === 0) {
    return deepFreeze({
      context,
      required: false as const,
      requiredDecisionCount: 0 as const,
      matchedRules: [] as const,
    });
  }
  return deepFreeze({
    context,
    required: true as const,
    // A single immutable decision may satisfy multiple rules; the evaluator
    // still requires every matching rule independently, so max is the correct
    // distinct request-wide threshold rather than a double-counting sum.
    requiredDecisionCount: Math.max(
      ...matchedRules.map((rule) => rule.requiredDecisionCount),
    ),
    matchedRules,
  });
}

/**
 * Loads the canonical requester role and every active account rule using the
 * caller's transaction. This function deliberately never opens a transaction.
 */
export async function resolvePartnerApprovalRequirement(input: {
  tx: PartnerApprovalTransaction;
  partnerAccountId: string;
  requestedByMembershipId: string;
  serviceKey: string;
  locationId: string;
  amountMinor: number | null;
  currency: string;
  poNumber: string | null;
  costCenter: string | null;
}): Promise<PartnerApprovalRequirementResolution> {
  if (
    !isPortalV2Uuid(input.partnerAccountId) ||
    !isPortalV2Uuid(input.requestedByMembershipId)
  ) {
    throw new PartnerApprovalRuleResolutionError("invalid_context");
  }
  const [requester] = await input.tx
    .select({ roleKey: partnerAccountMemberships.roleKey })
    .from(partnerAccountMemberships)
    .where(
      and(
        eq(partnerAccountMemberships.id, input.requestedByMembershipId),
        eq(partnerAccountMemberships.partnerAccountId, input.partnerAccountId),
        eq(partnerAccountMemberships.status, "active"),
      ),
    )
    .limit(1);
  if (!requester) {
    throw new PartnerApprovalRuleResolutionError("requester_not_found");
  }
  const [location] = await input.tx
    .select({ id: partnerAccountLocations.id })
    .from(partnerAccountLocations)
    .where(
      and(
        eq(partnerAccountLocations.id, input.locationId),
        eq(partnerAccountLocations.partnerAccountId, input.partnerAccountId),
      ),
    )
    .limit(1);
  if (!location) {
    throw new PartnerApprovalRuleResolutionError("invalid_context");
  }
  const rules = await input.tx
    .select({
      id: partnerApprovalRules.id,
      partnerAccountId: partnerApprovalRules.partnerAccountId,
      name: partnerApprovalRules.name,
      conditions: partnerApprovalRules.conditions,
      requiredApproverCapabilities:
        partnerApprovalRules.requiredApproverCapabilities,
      requiredApproverRoleKeys: partnerApprovalRules.requiredApproverRoleKeys,
      requiredDecisionCount: partnerApprovalRules.requiredDecisionCount,
      active: partnerApprovalRules.active,
      version: partnerApprovalRules.version,
    })
    .from(partnerApprovalRules)
    .where(
      and(
        eq(partnerApprovalRules.partnerAccountId, input.partnerAccountId),
        eq(partnerApprovalRules.active, true),
      ),
    )
    .orderBy(asc(partnerApprovalRules.name), asc(partnerApprovalRules.id))
    .limit(MAX_ACTIVE_APPROVAL_RULES + 1);
  return resolvePartnerApprovalRequirementFromRules({
    context: {
      partnerAccountId: input.partnerAccountId,
      requestedByMembershipId: input.requestedByMembershipId,
      requesterRoleKey: requester.roleKey,
      serviceKey: input.serviceKey,
      locationId: input.locationId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      poNumber: input.poNumber,
      costCenter: input.costCenter,
    },
    rules,
  });
}

export type PartnerApprovalRequestTarget =
  | Readonly<{
      kind: "booking";
      id: string;
      partnerAccountId: string;
    }>
  | Readonly<{
      kind: "booking_draft";
      id: string;
      partnerAccountId: string;
    }>;

export type PartnerApprovalRequestSnapshotDetails = Readonly<{
  description?: string | null;
  notes?: string | null;
  arrivalWindow?: Readonly<{ startAt: Date; endAt: Date }> | null;
  address?: Readonly<{
    line1: string;
    line2?: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  }> | null;
}>;

export type PartnerApprovalHoldReference = Readonly<{
  id: string;
  partnerAccountId: string;
  expiresAt: Date;
}>;

export type PartnerApprovalRequestInsert = Readonly<
  typeof partnerApprovalRequests.$inferInsert
>;

function requestSnapshotText(
  value: unknown,
  maximum: number,
  required = false,
): string | null {
  try {
    return normalizedBoundedText(value, maximum, { optional: !required });
  } catch {
    throw new PartnerApprovalRuleResolutionError("invalid_request_snapshot");
  }
}

/**
 * Creates exact account-scoped insertion data after the caller has created the
 * booking/draft target. Pass only partner-visible notes and address fields;
 * access secrets, internal starts, appointment IDs, and staff notes are not
 * accepted or serialized.
 */
export function buildPartnerApprovalRequestInsert(input: {
  resolution: Extract<PartnerApprovalRequirementResolution, { required: true }>;
  target: PartnerApprovalRequestTarget;
  request?: PartnerApprovalRequestSnapshotDetails;
  approvalHold?: PartnerApprovalHoldReference | null;
  now?: Date;
}): PartnerApprovalRequestInsert {
  if (!input.resolution.required) {
    throw new PartnerApprovalRuleResolutionError("approval_not_required");
  }
  if (
    !isPortalV2Uuid(input.target.id) ||
    !isPortalV2Uuid(input.target.partnerAccountId) ||
    input.target.partnerAccountId.toLowerCase() !==
      input.resolution.context.partnerAccountId
  ) {
    throw new PartnerApprovalRuleResolutionError("invalid_target");
  }
  const now = new Date((input.now ?? new Date()).getTime());
  if (!Number.isFinite(now.getTime())) {
    throw new PartnerApprovalRuleResolutionError("invalid_request_snapshot");
  }
  let approvalHoldId: string | null = null;
  let expiresAt: Date | null = null;
  if (input.approvalHold) {
    if (
      !isPortalV2Uuid(input.approvalHold.id) ||
      !isPortalV2Uuid(input.approvalHold.partnerAccountId) ||
      input.approvalHold.partnerAccountId.toLowerCase() !==
        input.resolution.context.partnerAccountId ||
      !Number.isFinite(input.approvalHold.expiresAt.getTime()) ||
      input.approvalHold.expiresAt <= now
    ) {
      throw new PartnerApprovalRuleResolutionError("invalid_approval_hold");
    }
    approvalHoldId = input.approvalHold.id.toLowerCase();
    expiresAt = new Date(input.approvalHold.expiresAt.getTime());
  }

  const request = input.request ?? {};
  const requestSnapshot: Record<string, unknown> = {
    serviceKey: input.resolution.context.serviceKey,
    locationId: input.resolution.context.locationId,
    amountMinor: input.resolution.context.amountMinor,
    currency: input.resolution.context.currency,
    requesterRoleKey: input.resolution.context.requesterRoleKey,
  };
  if (input.resolution.context.poNumber)
    requestSnapshot["poNumber"] = input.resolution.context.poNumber;
  if (input.resolution.context.costCenter)
    requestSnapshot["costCenter"] = input.resolution.context.costCenter;
  const description = requestSnapshotText(request.description, 4_000);
  const notes = requestSnapshotText(request.notes, 4_000);
  if (description) requestSnapshot["description"] = description;
  if (notes) requestSnapshot["notes"] = notes;
  if (request.arrivalWindow) {
    const startAt = new Date(request.arrivalWindow.startAt.getTime());
    const endAt = new Date(request.arrivalWindow.endAt.getTime());
    if (
      !Number.isFinite(startAt.getTime()) ||
      !Number.isFinite(endAt.getTime()) ||
      endAt <= startAt
    ) {
      throw new PartnerApprovalRuleResolutionError("invalid_request_snapshot");
    }
    requestSnapshot["scheduledStartAt"] = startAt.toISOString();
    requestSnapshot["scheduledEndAt"] = endAt.toISOString();
  }
  if (request.address) {
    const allowedAddressKeys = new Set([
      "line1",
      "line2",
      "city",
      "state",
      "postalCode",
      "country",
    ]);
    if (
      Object.keys(request.address).some((key) => !allowedAddressKeys.has(key))
    ) {
      throw new PartnerApprovalRuleResolutionError("invalid_request_snapshot");
    }
    const line1 = requestSnapshotText(request.address.line1, 200, true);
    const line2 = requestSnapshotText(request.address.line2, 200);
    const city = requestSnapshotText(request.address.city, 160, true);
    const state = requestSnapshotText(request.address.state, 160, true);
    const postalCode = requestSnapshotText(
      request.address.postalCode,
      32,
      true,
    );
    const country = requestSnapshotText(request.address.country, 80, true);
    requestSnapshot["address"] = {
      line1,
      ...(line2 ? { line2 } : {}),
      city,
      state,
      postalCode,
      country,
    };
  }

  const ruleSnapshot = input.resolution.matchedRules.map(
    (rule): Record<string, unknown> => ({
      id: rule.id,
      name: rule.name,
      version: rule.version,
      requiredApproverCapabilities: [...rule.requiredApproverCapabilities],
      requiredApproverRoleKeys: [...rule.requiredApproverRoleKeys],
      requiredDecisionCount: rule.requiredDecisionCount,
      conditions: {
        ...(rule.conditions?.serviceKeys
          ? { serviceKeys: [...rule.conditions.serviceKeys] }
          : {}),
        ...(rule.conditions?.locationIds
          ? { locationIds: [...rule.conditions.locationIds] }
          : {}),
        ...(rule.conditions?.minimumAmountMinor !== undefined
          ? { minimumAmountMinor: rule.conditions.minimumAmountMinor }
          : {}),
        ...(rule.conditions?.maximumAmountMinor !== undefined
          ? { maximumAmountMinor: rule.conditions.maximumAmountMinor }
          : {}),
        ...(rule.conditions?.requesterRoleKeys
          ? { requesterRoleKeys: [...rule.conditions.requesterRoleKeys] }
          : {}),
        ...(rule.conditions?.poNumberState
          ? { poNumberState: rule.conditions.poNumberState }
          : {}),
        ...(rule.conditions?.costCenterState
          ? { costCenterState: rule.conditions.costCenterState }
          : {}),
      },
    }),
  );
  const insert: typeof partnerApprovalRequests.$inferInsert = {
    id: randomUUID(),
    partnerAccountId: input.resolution.context.partnerAccountId,
    partnerBookingId:
      input.target.kind === "booking" ? input.target.id.toLowerCase() : null,
    bookingDraftId:
      input.target.kind === "booking_draft"
        ? input.target.id.toLowerCase()
        : null,
    requestedByMembershipId: input.resolution.context.requestedByMembershipId,
    state: "pending",
    ruleSnapshot,
    requestSnapshot,
    requiredDecisionCount: input.resolution.requiredDecisionCount,
    approvalHoldId,
    expiresAt,
    resolvedAt: null,
    revision: 1,
    createdAt: new Date(now.getTime()),
    updatedAt: new Date(now.getTime()),
  };
  return deepFreeze(insert);
}

type ApprovalCursor = {
  accountId: string;
  state: string | null;
  asOf: string;
  lastAt: string;
  lastId: string;
};

function isApprovalCursor(
  value: unknown,
  accountId: string,
  state: string | null,
): value is ApprovalCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const parsedAt =
    typeof record["lastAt"] === "string"
      ? parsePortalV2Rfc3339(record["lastAt"])
      : null;
  const parsedAsOf =
    typeof record["asOf"] === "string"
      ? parsePortalV2Rfc3339(record["asOf"])
      : null;
  return (
    Object.keys(record).sort().join(",") ===
      "accountId,asOf,lastAt,lastId,state" &&
    record["accountId"] === accountId &&
    record["state"] === state &&
    parsedAsOf !== null &&
    parsedAsOf.toISOString() === record["asOf"] &&
    parsedAt !== null &&
    parsedAt.toISOString() === record["lastAt"] &&
    isPortalV2Uuid(record["lastId"])
  );
}

function effectiveApprovalState(input: { state: string }): string {
  // Hold expiry affects whether approval can confirm a schedule, not whether
  // the account may finish its immutable approval decision.
  return input.state;
}

function approvalRevision(row: {
  id: string;
  revision: number;
  updatedAt: Date;
}): string {
  return `${row.id}:${row.revision}:${row.updatedAt.toISOString()}`;
}

function summarizedRequestSnapshot(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const shortTextKeys = [
    "serviceKey",
    "serviceType",
    "poNumber",
    "costCenter",
    "scheduledStartAt",
    "scheduledEndAt",
  ] as const;
  for (const key of shortTextKeys) {
    const text = safeText(source[key], 160);
    if (text) result[key] = text;
  }
  for (const key of ["description", "notes"] as const) {
    const text = safeText(source[key], 2_000);
    if (text) result[key] = text;
  }
  const amountMinor = firstDefined(source, ["amountMinor", "totalCents"]);
  const currency = safeText(source["currency"], 3);
  if (
    Number.isSafeInteger(amountMinor) &&
    Number(amountMinor) >= 0 &&
    currency &&
    /^[A-Z]{3}$/u.test(currency)
  ) {
    result["amount"] = {
      amountMinor: Number(amountMinor),
      currency,
      minorUnit: 2,
    };
  }
  const address = source["address"];
  if (address && typeof address === "object" && !Array.isArray(address)) {
    const addressSource = address as Record<string, unknown>;
    const safeAddress: Record<string, string> = {};
    for (const key of [
      "line1",
      "line2",
      "city",
      "state",
      "postalCode",
      "country",
    ]) {
      const text = safeText(addressSource[key], 160);
      if (text) safeAddress[key] = text;
    }
    if (Object.keys(safeAddress).length) result["address"] = safeAddress;
  }
  return result;
}

type ApprovalRequestRow = typeof partnerApprovalRequests.$inferSelect;
type ApprovalDecisionRow = {
  id: string;
  approvalRequestId: string;
  decidedByMembershipId: string;
  decision: string;
  reason: string | null;
  decisionSnapshot: Record<string, unknown>;
  createdAt: Date;
  currentRoleKey: string | null;
};
type ApprovalRequesterRow = {
  membershipId: string;
  displayName: string;
  roleKey: string;
};

function decisionRole(row: ApprovalDecisionRow): string | null {
  const snapshotted = safeText(row.decisionSnapshot["roleKey"], 64);
  if (snapshotted && ROLE_KEY_PATTERN.test(snapshotted)) return snapshotted;
  return row.currentRoleKey && ROLE_KEY_PATTERN.test(row.currentRoleKey)
    ? row.currentRoleKey
    : null;
}

function decisionCapabilities(row: ApprovalDecisionRow): string[] {
  const snapshot = row.decisionSnapshot["capabilities"];
  if (
    Array.isArray(snapshot) &&
    snapshot.length > 0 &&
    snapshot.length <= 20 &&
    snapshot.every(
      (capability) =>
        typeof capability === "string" &&
        /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(capability),
    )
  ) {
    return [...new Set(snapshot as string[])];
  }
  // Legacy decisions already passed the then-current authorization check.
  // Preserve that immutable evidence without consulting today's role name.
  return ["approvals.decide"];
}

function approvalRequestDto(input: {
  row: ApprovalRequestRow;
  decisions: readonly ApprovalDecisionRow[];
  requester: ApprovalRequesterRow | null;
  membershipId: string;
  now: Date;
  detail: boolean;
}): Record<string, unknown> {
  const parsedRules = parseApprovalRuleSnapshots(input.row.ruleSnapshot);
  const approvals = input.decisions.filter(
    (decision) => decision.decision === "approved",
  ).length;
  const declines = input.decisions.filter(
    (decision) => decision.decision === "declined",
  ).length;
  const base: Record<string, unknown> = {
    id: input.row.id,
    state: effectiveApprovalState(input.row),
    target: input.row.partnerBookingId
      ? { kind: "booking", id: input.row.partnerBookingId }
      : { kind: "booking_draft", id: input.row.bookingDraftId },
    requestedByCurrentMember:
      input.row.requestedByMembershipId === input.membershipId,
    requester: {
      displayName:
        safeText(input.requester?.displayName, 160) ?? "Account member",
      roleKey:
        input.requester?.roleKey &&
        ROLE_KEY_PATTERN.test(input.requester.roleKey)
          ? input.requester.roleKey
          : null,
      byCurrentMember: input.row.requestedByMembershipId === input.membershipId,
    },
    requiredDecisionCount: input.row.requiredDecisionCount,
    decisionCounts: { approved: approvals, declined: declines },
    currentMemberDecision:
      input.decisions.find(
        (decision) => decision.decidedByMembershipId === input.membershipId,
      )?.decision ?? null,
    expiresAt: input.row.expiresAt?.toISOString() ?? null,
    resolvedAt: input.row.resolvedAt?.toISOString() ?? null,
    revision: input.row.revision,
    createdAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
    etag: createPortalV2StrongEtag(approvalRevision(input.row)),
  };
  if (!input.detail) return base;
  return {
    ...base,
    rulesValid: Boolean(parsedRules),
    rules:
      parsedRules?.map((rule) => ({
        id: rule.id,
        name: rule.name,
        version: rule.version,
        requiredApproverCapabilities: rule.requiredApproverCapabilities,
        requiredApproverRoleKeys: rule.requiredApproverRoleKeys,
        requiredDecisionCount: rule.requiredDecisionCount,
      })) ?? [],
    request: summarizedRequestSnapshot(input.row.requestSnapshot),
    decisions: input.decisions.map((decision) => ({
      id: decision.id,
      decision: decision.decision,
      reason: safeText(decision.reason, 1_000),
      roleKey: decisionRole(decision),
      byCurrentMember: decision.decidedByMembershipId === input.membershipId,
      createdAt: decision.createdAt.toISOString(),
    })),
  };
}

async function loadApprovalDecisions(
  requestIds: readonly string[],
  accountId: string,
): Promise<ApprovalDecisionRow[]> {
  if (!requestIds.length) return [];
  return getDb()
    .select({
      id: partnerApprovalDecisions.id,
      approvalRequestId: partnerApprovalDecisions.approvalRequestId,
      decidedByMembershipId: partnerApprovalDecisions.decidedByMembershipId,
      decision: partnerApprovalDecisions.decision,
      reason: partnerApprovalDecisions.reason,
      decisionSnapshot: partnerApprovalDecisions.decisionSnapshot,
      createdAt: partnerApprovalDecisions.createdAt,
      currentRoleKey: partnerAccountMemberships.roleKey,
    })
    .from(partnerApprovalDecisions)
    .leftJoin(
      partnerAccountMemberships,
      eq(
        partnerApprovalDecisions.decidedByMembershipId,
        partnerAccountMemberships.id,
      ),
    )
    .where(
      and(
        inArray(partnerApprovalDecisions.approvalRequestId, [...requestIds]),
        eq(partnerApprovalDecisions.partnerAccountId, accountId),
      ),
    )
    .orderBy(partnerApprovalDecisions.createdAt, partnerApprovalDecisions.id);
}

async function loadApprovalRequesters(
  membershipIds: readonly string[],
  accountId: string,
): Promise<ApprovalRequesterRow[]> {
  if (!membershipIds.length) return [];
  return getDb()
    .select({
      membershipId: partnerAccountMemberships.id,
      displayName: partnerUsers.name,
      roleKey: partnerAccountMemberships.roleKey,
    })
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerUsers,
      eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
    )
    .where(
      and(
        eq(partnerAccountMemberships.partnerAccountId, accountId),
        inArray(partnerAccountMemberships.id, [...new Set(membershipIds)]),
      ),
    );
}

export type PartnerApprovalReadResult =
  | {
      ok: true;
      approvalRequests: Array<Record<string, unknown>>;
      limit: number;
      nextCursor: string | null;
    }
  | {
      ok: false;
      error: "invalid_cursor" | "invalid_fields" | "not_found";
      status: 404 | 422;
      fieldErrors?: Record<string, string>;
    };

export async function listPartnerApprovalRequests(input: {
  accountId: string;
  membershipId: string;
  params: URLSearchParams;
  now?: Date;
}): Promise<PartnerApprovalReadResult> {
  const stateValues = input.params.getAll("state");
  const state = stateValues[0]?.trim() || null;
  if (stateValues.length > 1 || (state && !APPROVAL_STATES.has(state))) {
    return {
      ok: false,
      error: "invalid_fields",
      status: 422,
      fieldErrors: { state: "Use one supported approval state." },
    };
  }
  const pagination = parsePortalV2Pagination(input.params, {
    cursorKind: "commercial.approvals",
    validateCursorPayload: (value): value is ApprovalCursor =>
      isApprovalCursor(value, input.accountId, state),
    allowedQueryKeys: new Set(["state"]),
  });
  if (!pagination.ok) {
    return {
      ok: false,
      error: pagination.fieldErrors["cursor"]
        ? "invalid_cursor"
        : "invalid_fields",
      status: 422,
      fieldErrors: { ...pagination.fieldErrors },
    };
  }
  const cursor = pagination.cursor?.payload;
  const cursorAt = cursor ? new Date(cursor.lastAt) : null;
  const now = cursor ? new Date(cursor.asOf) : (input.now ?? new Date());
  const stateCondition = state
    ? eq(partnerApprovalRequests.state, state)
    : undefined;
  const rows = await getDb()
    .select()
    .from(partnerApprovalRequests)
    .where(
      and(
        eq(partnerApprovalRequests.partnerAccountId, input.accountId),
        stateCondition,
        cursor && cursorAt
          ? or(
              lt(partnerApprovalRequests.createdAt, cursorAt),
              and(
                eq(partnerApprovalRequests.createdAt, cursorAt),
                lt(partnerApprovalRequests.id, cursor.lastId),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(partnerApprovalRequests.createdAt),
      desc(partnerApprovalRequests.id),
    )
    .limit(pagination.limit + 1);
  const page = rows.slice(0, pagination.limit);
  const [decisions, requesters] = await Promise.all([
    loadApprovalDecisions(
      page.map((row) => row.id),
      input.accountId,
    ),
    loadApprovalRequesters(
      page.map((row) => row.requestedByMembershipId),
      input.accountId,
    ),
  ]);
  const last = page.at(-1);
  return {
    ok: true,
    approvalRequests: page.map((row) =>
      approvalRequestDto({
        row,
        decisions: decisions.filter(
          (decision) => decision.approvalRequestId === row.id,
        ),
        requester:
          requesters.find(
            (requester) =>
              requester.membershipId === row.requestedByMembershipId,
          ) ?? null,
        membershipId: input.membershipId,
        now,
        detail: false,
      }),
    ),
    limit: pagination.limit,
    nextCursor:
      rows.length > pagination.limit && last
        ? encodePortalV2Cursor({
            kind: "commercial.approvals",
            limit: pagination.limit,
            payload: {
              accountId: input.accountId,
              state,
              asOf: now.toISOString(),
              lastAt: last.createdAt.toISOString(),
              lastId: last.id,
            } satisfies ApprovalCursor,
          })
        : null,
  };
}

export async function getPartnerApprovalRequest(input: {
  accountId: string;
  membershipId: string;
  requestId: string;
  now?: Date;
}): Promise<
  | { ok: true; approvalRequest: Record<string, unknown>; etag: string }
  | { ok: false; error: "not_found"; status: 404 }
> {
  const [row] = await getDb()
    .select()
    .from(partnerApprovalRequests)
    .where(
      and(
        eq(partnerApprovalRequests.partnerAccountId, input.accountId),
        eq(partnerApprovalRequests.id, input.requestId),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, error: "not_found", status: 404 };
  const [decisions, requesters] = await Promise.all([
    loadApprovalDecisions([row.id], input.accountId),
    loadApprovalRequesters([row.requestedByMembershipId], input.accountId),
  ]);
  return {
    ok: true,
    approvalRequest: approvalRequestDto({
      row,
      decisions,
      requester: requesters[0] ?? null,
      membershipId: input.membershipId,
      now: input.now ?? new Date(),
      detail: true,
    }),
    etag: createPortalV2StrongEtag(approvalRevision(row)),
  };
}

type ApprovalDecisionInput = {
  accountId: string;
  membershipId: string;
  partnerUserId: string;
  email: string;
  roleKey: string;
  sessionId: string;
  correlationId: string;
  idempotencyKeyHash: string;
  requestId: string;
  ifMatch: string | null;
  decision: "approved" | "declined";
  reason: string | null;
  now?: Date;
};

function storedDescriptor(input: {
  status: number;
  body: Readonly<Record<string, unknown>>;
  headers?: Readonly<Record<string, string>>;
}): PortalV2StoredResult {
  return {
    status: input.status,
    body: { ...input.body },
    ...(input.headers ? { headers: { ...input.headers } } : {}),
  };
}

export type PartnerApprovalLifecycleTarget = Readonly<{
  bookingId: string;
  bookingAccountId: string | null;
  bookingDraftId: string | null;
  bookingRequestedByMembershipId: string | null;
  bookingPropertyId: string | null;
  bookingVersion: number;
  bookingPublicStatus: string;
  bookingConfirmationMode: string;
  bookingArrivalWindowStartAt: Date | null;
  bookingArrivalWindowEndAt: Date | null;
  appointmentId: string;
  appointmentAccountId: string | null;
  appointmentStatus: string;
  appointmentStartAt: Date | null;
  appointmentPromisedArrivalStartAt: Date | null;
  appointmentPromisedArrivalEndAt: Date | null;
  appointmentSchedulePolicyRevision: string | null;
  appointmentCalendarEventId: string | null;
}>;

export type PartnerApprovalLifecycleHold = Readonly<{
  id: string;
  partnerAccountId: string | null;
  partnerBookingDraftId: string | null;
  requestedByMembershipId: string | null;
  propertyId: string | null;
  startAt: Date;
  durationMinutes: number;
  travelBufferMinutes: number;
  capacityPoolKey: string;
  capacityUnits: number;
  arrivalWindowStartAt: Date | null;
  arrivalWindowEndAt: Date | null;
  policyRevision: string | null;
  serviceProfileRevision: number | null;
  status: string;
  expiresAt: Date;
}>;

export type PartnerApprovalLifecyclePlan =
  | Readonly<{
      kind: "pending";
      approvalState: "pending";
      releaseApprovalHold: false;
    }>
  | Readonly<{
      kind: "confirm";
      approvalState: "approved";
      releaseApprovalHold: false;
    }>
  | Readonly<{
      kind: "approved_needs_reschedule";
      approvalState: "approved_needs_reschedule";
      releaseApprovalHold: false;
    }>
  | Readonly<{
      kind: "decline";
      approvalState: "declined";
      releaseApprovalHold: boolean;
    }>
  | Readonly<{
      kind: "conflict";
      approvalState: "pending";
      releaseApprovalHold: false;
    }>;

function validApprovalLifecycleDate(value: Date | null): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function sameApprovalLifecycleDate(
  left: Date | null,
  right: Date | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    validApprovalLifecycleDate(left) &&
    validApprovalLifecycleDate(right) &&
    left.getTime() === right.getTime()
  );
}

/**
 * Pure lifecycle planning keeps final-decision behavior testable. Unknown,
 * expired, released, or mismatched holds never become schedule promises.
 */
export function planPartnerApprovalLifecycle(input: {
  accountId: string;
  requestedByMembershipId: string;
  partnerBookingId: string | null;
  bookingDraftId: string | null;
  approvalHoldId: string | null;
  approved: boolean;
  declined: boolean;
  target: PartnerApprovalLifecycleTarget | null;
  hold: PartnerApprovalLifecycleHold | null;
  now: Date;
}): PartnerApprovalLifecyclePlan {
  if (!input.approved && !input.declined) {
    return Object.freeze({
      kind: "pending" as const,
      approvalState: "pending" as const,
      releaseApprovalHold: false as const,
    });
  }
  const expectedDraftId = input.partnerBookingId
    ? (input.target?.bookingDraftId ?? null)
    : input.bookingDraftId;
  const targetMatches = input.partnerBookingId
    ? Boolean(
        input.target &&
          input.target.bookingId === input.partnerBookingId &&
          input.target.bookingAccountId === input.accountId &&
          input.target.bookingRequestedByMembershipId ===
            input.requestedByMembershipId &&
          input.target.appointmentAccountId === input.accountId &&
          input.target.bookingPublicStatus === "approval_needed" &&
          input.target.bookingConfirmationMode === "approval" &&
          input.target.appointmentStatus === "requested",
      )
    : input.target === null;
  if (!targetMatches) {
    return Object.freeze({
      kind: "conflict" as const,
      approvalState: "pending" as const,
      releaseApprovalHold: false as const,
    });
  }
  const holdMatchesRequest = Boolean(
    input.approvalHoldId &&
      input.hold &&
      input.hold.id === input.approvalHoldId &&
      input.hold.partnerAccountId === input.accountId &&
      expectedDraftId &&
      input.hold.partnerBookingDraftId === expectedDraftId &&
      input.hold.requestedByMembershipId === input.requestedByMembershipId &&
      (!input.target ||
        !input.target.bookingPropertyId ||
        input.hold.propertyId === input.target.bookingPropertyId),
  );
  if (input.declined) {
    return Object.freeze({
      kind: "decline" as const,
      approvalState: "declined" as const,
      releaseApprovalHold:
        holdMatchesRequest && input.hold?.status === "active",
    });
  }
  if (!input.partnerBookingId || !input.target) {
    return Object.freeze({
      kind: "approved_needs_reschedule" as const,
      approvalState: "approved_needs_reschedule" as const,
      releaseApprovalHold: false as const,
    });
  }
  const targetHasNoSchedulePromise =
    input.target.appointmentStartAt === null &&
    input.target.appointmentPromisedArrivalStartAt === null &&
    input.target.appointmentPromisedArrivalEndAt === null &&
    input.target.appointmentSchedulePolicyRevision === null;
  if (!targetHasNoSchedulePromise) {
    return Object.freeze({
      kind: "conflict" as const,
      approvalState: "pending" as const,
      releaseApprovalHold: false as const,
    });
  }
  const activeSchedulableHold = Boolean(
    holdMatchesRequest &&
      input.hold &&
      input.hold.status === "active" &&
      validApprovalLifecycleDate(input.hold.expiresAt) &&
      input.hold.expiresAt > input.now &&
      validApprovalLifecycleDate(input.hold.startAt) &&
      input.hold.startAt > input.now &&
      Number.isSafeInteger(input.hold.durationMinutes) &&
      input.hold.durationMinutes >= 15 &&
      input.hold.durationMinutes <= 1_440 &&
      Number.isSafeInteger(input.hold.travelBufferMinutes) &&
      input.hold.travelBufferMinutes >= 0 &&
      input.hold.travelBufferMinutes <= 1_440 &&
      /^[a-z][a-z0-9_-]{0,63}$/u.test(input.hold.capacityPoolKey) &&
      Number.isSafeInteger(input.hold.capacityUnits) &&
      input.hold.capacityUnits >= 1 &&
      input.hold.capacityUnits <= 100 &&
      sameApprovalLifecycleDate(
        input.target.bookingArrivalWindowStartAt,
        input.hold.arrivalWindowStartAt,
      ) &&
      sameApprovalLifecycleDate(
        input.target.bookingArrivalWindowEndAt,
        input.hold.arrivalWindowEndAt,
      ) &&
      input.hold.arrivalWindowStartAt! < input.hold.arrivalWindowEndAt! &&
      input.hold.arrivalWindowEndAt!.getTime() -
        input.hold.arrivalWindowStartAt!.getTime() ===
        2 * 60 * 60 * 1_000 &&
      input.hold.startAt >= input.hold.arrivalWindowStartAt! &&
      input.hold.startAt < input.hold.arrivalWindowEndAt! &&
      Boolean(input.hold.policyRevision?.trim()) &&
      Number.isSafeInteger(input.hold.serviceProfileRevision) &&
      Number(input.hold.serviceProfileRevision) > 0,
  );
  return activeSchedulableHold
    ? Object.freeze({
        kind: "confirm" as const,
        approvalState: "approved" as const,
        releaseApprovalHold: false as const,
      })
    : Object.freeze({
        kind: "approved_needs_reschedule" as const,
        approvalState: "approved_needs_reschedule" as const,
        releaseApprovalHold: false as const,
      });
}

async function loadPartnerApprovalLifecycleContext(input: {
  tx: PartnerApprovalTransaction;
  request: ApprovalRequestRow;
  accountId: string;
  approved: boolean;
  declined: boolean;
  now: Date;
}): Promise<{
  plan: PartnerApprovalLifecyclePlan;
  target: PartnerApprovalLifecycleTarget | null;
  hold: PartnerApprovalLifecycleHold | null;
}> {
  if (!input.approved && !input.declined) {
    return {
      plan: planPartnerApprovalLifecycle({
        accountId: input.accountId,
        requestedByMembershipId: input.request.requestedByMembershipId,
        partnerBookingId: input.request.partnerBookingId,
        bookingDraftId: input.request.bookingDraftId,
        approvalHoldId: input.request.approvalHoldId,
        approved: false,
        declined: false,
        target: null,
        hold: null,
        now: input.now,
      }),
      target: null,
      hold: null,
    };
  }
  const target = input.request.partnerBookingId
    ? ((
        await input.tx
          .select({
            bookingId: partnerBookings.id,
            bookingAccountId: partnerBookings.partnerAccountId,
            bookingDraftId: partnerBookings.bookingDraftId,
            bookingRequestedByMembershipId:
              partnerBookings.requestedByMembershipId,
            bookingPropertyId: partnerBookings.propertyId,
            bookingVersion: partnerBookings.version,
            bookingPublicStatus: partnerBookings.publicStatus,
            bookingConfirmationMode: partnerBookings.confirmationMode,
            bookingArrivalWindowStartAt: partnerBookings.arrivalWindowStartAt,
            bookingArrivalWindowEndAt: partnerBookings.arrivalWindowEndAt,
            appointmentId: appointments.id,
            appointmentAccountId: appointments.partnerAccountId,
            appointmentStatus: appointments.status,
            appointmentStartAt: appointments.startAt,
            appointmentPromisedArrivalStartAt:
              appointments.promisedArrivalStartAt,
            appointmentPromisedArrivalEndAt: appointments.promisedArrivalEndAt,
            appointmentSchedulePolicyRevision:
              appointments.schedulePolicyRevision,
            appointmentCalendarEventId: appointments.calendarEventId,
          })
          .from(partnerBookings)
          .innerJoin(
            appointments,
            eq(partnerBookings.appointmentId, appointments.id),
          )
          .where(
            and(
              eq(partnerBookings.id, input.request.partnerBookingId),
              eq(partnerBookings.partnerAccountId, input.accountId),
              eq(appointments.partnerAccountId, input.accountId),
            ),
          )
          .for("update")
          .limit(1)
      )[0] ?? null)
    : null;
  const hold = input.request.approvalHoldId
    ? ((
        await input.tx
          .select({
            id: appointmentHolds.id,
            partnerAccountId: appointmentHolds.partnerAccountId,
            partnerBookingDraftId: appointmentHolds.partnerBookingDraftId,
            requestedByMembershipId: appointmentHolds.requestedByMembershipId,
            propertyId: appointmentHolds.propertyId,
            startAt: appointmentHolds.startAt,
            durationMinutes: appointmentHolds.durationMinutes,
            travelBufferMinutes: appointmentHolds.travelBufferMinutes,
            capacityPoolKey: appointmentHolds.capacityPoolKey,
            capacityUnits: appointmentHolds.capacityUnits,
            arrivalWindowStartAt: appointmentHolds.arrivalWindowStartAt,
            arrivalWindowEndAt: appointmentHolds.arrivalWindowEndAt,
            policyRevision: appointmentHolds.policyRevision,
            serviceProfileRevision: appointmentHolds.serviceProfileRevision,
            status: appointmentHolds.status,
            expiresAt: appointmentHolds.expiresAt,
          })
          .from(appointmentHolds)
          .where(
            and(
              eq(appointmentHolds.id, input.request.approvalHoldId),
              eq(appointmentHolds.partnerAccountId, input.accountId),
            ),
          )
          .for("update")
          .limit(1)
      )[0] ?? null)
    : null;
  return {
    plan: planPartnerApprovalLifecycle({
      accountId: input.accountId,
      requestedByMembershipId: input.request.requestedByMembershipId,
      partnerBookingId: input.request.partnerBookingId,
      bookingDraftId: input.request.bookingDraftId,
      approvalHoldId: input.request.approvalHoldId,
      approved: input.approved,
      declined: input.declined,
      target,
      hold,
      now: input.now,
    }),
    target,
    hold,
  };
}

async function applyPartnerApprovalLifecycle(input: {
  tx: PartnerApprovalTransaction;
  request: ApprovalRequestRow;
  accountId: string;
  actorMembershipId: string;
  correlationId: string;
  plan: PartnerApprovalLifecyclePlan;
  target: PartnerApprovalLifecycleTarget | null;
  hold: PartnerApprovalLifecycleHold | null;
  now: Date;
}): Promise<void> {
  if (input.plan.kind === "pending") return;
  if (input.plan.kind === "conflict") {
    throw new Error("partner_approval_lifecycle_conflict");
  }
  const expectedDraftId = input.request.partnerBookingId
    ? (input.target?.bookingDraftId ?? null)
    : input.request.bookingDraftId;
  if (
    input.plan.kind === "decline" &&
    input.plan.releaseApprovalHold &&
    input.hold &&
    expectedDraftId
  ) {
    const [released] = await input.tx
      .update(appointmentHolds)
      .set({ status: "released", consumedAt: null, updatedAt: input.now })
      .where(
        and(
          eq(appointmentHolds.id, input.hold.id),
          eq(appointmentHolds.partnerAccountId, input.accountId),
          eq(appointmentHolds.partnerBookingDraftId, expectedDraftId),
          eq(
            appointmentHolds.requestedByMembershipId,
            input.request.requestedByMembershipId,
          ),
          eq(appointmentHolds.status, "active"),
        ),
      )
      .returning({ id: appointmentHolds.id });
    if (!released) throw new Error("partner_approval_hold_release_race");
  }
  if (input.plan.kind === "decline") {
    if (!input.target) return;
    const [canceledAppointment] = await input.tx
      .update(appointments)
      .set({
        status: "canceled",
        startAt: null,
        promisedArrivalStartAt: null,
        promisedArrivalEndAt: null,
        schedulePolicyRevision: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(appointments.id, input.target.appointmentId),
          eq(appointments.partnerAccountId, input.accountId),
          eq(appointments.status, "requested"),
        ),
      )
      .returning({ id: appointments.id });
    if (!canceledAppointment) {
      throw new Error("partner_approval_appointment_cancel_race");
    }
    const [declinedBooking] = await input.tx
      .update(partnerBookings)
      .set({
        publicStatus: "declined",
        version: input.target.bookingVersion + 1,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(partnerBookings.id, input.target.bookingId),
          eq(partnerBookings.partnerAccountId, input.accountId),
          eq(partnerBookings.version, input.target.bookingVersion),
          eq(partnerBookings.publicStatus, "approval_needed"),
          eq(partnerBookings.confirmationMode, "approval"),
        ),
      )
      .returning({ id: partnerBookings.id });
    if (!declinedBooking) {
      throw new Error("partner_approval_booking_decline_race");
    }
    return;
  }
  if (input.plan.kind === "approved_needs_reschedule") return;
  if (!input.target || !input.hold || !expectedDraftId) {
    throw new Error("partner_approval_confirmation_context_missing");
  }
  const [consumedHold] = await input.tx
    .update(appointmentHolds)
    .set({ status: "consumed", consumedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(appointmentHolds.id, input.hold.id),
        eq(appointmentHolds.partnerAccountId, input.accountId),
        eq(appointmentHolds.partnerBookingDraftId, expectedDraftId),
        eq(
          appointmentHolds.requestedByMembershipId,
          input.request.requestedByMembershipId,
        ),
        eq(appointmentHolds.status, "active"),
        gt(appointmentHolds.expiresAt, input.now),
      ),
    )
    .returning({ id: appointmentHolds.id });
  if (!consumedHold) throw new Error("partner_approval_hold_consume_race");

  const [confirmedAppointment] = await input.tx
    .update(appointments)
    .set({
      startAt: input.hold.startAt,
      durationMinutes: input.hold.durationMinutes,
      travelBufferMinutes: input.hold.travelBufferMinutes,
      capacityPoolKey: input.hold.capacityPoolKey,
      capacityUnits: input.hold.capacityUnits,
      promisedArrivalStartAt: input.hold.arrivalWindowStartAt,
      promisedArrivalEndAt: input.hold.arrivalWindowEndAt,
      schedulePolicyRevision: input.hold.policyRevision,
      status: "confirmed",
      updatedAt: input.now,
    })
    .where(
      and(
        eq(appointments.id, input.target.appointmentId),
        eq(appointments.partnerAccountId, input.accountId),
        eq(appointments.status, "requested"),
        isNull(appointments.startAt),
        isNull(appointments.promisedArrivalStartAt),
        isNull(appointments.promisedArrivalEndAt),
        isNull(appointments.schedulePolicyRevision),
      ),
    )
    .returning({
      id: appointments.id,
      updatedAt: appointments.updatedAt,
      calendarEventId: appointments.calendarEventId,
    });
  if (!confirmedAppointment) {
    throw new Error("partner_approval_appointment_confirm_race");
  }
  const [confirmedBooking] = await input.tx
    .update(partnerBookings)
    .set({
      publicStatus: "confirmed",
      confirmationMode: "approval",
      arrivalWindowStartAt: input.hold.arrivalWindowStartAt,
      arrivalWindowEndAt: input.hold.arrivalWindowEndAt,
      requestedReviewReasons: [],
      version: input.target.bookingVersion + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(partnerBookings.id, input.target.bookingId),
        eq(partnerBookings.partnerAccountId, input.accountId),
        eq(partnerBookings.version, input.target.bookingVersion),
        eq(partnerBookings.publicStatus, "approval_needed"),
        eq(partnerBookings.confirmationMode, "approval"),
      ),
    )
    .returning({ id: partnerBookings.id });
  if (!confirmedBooking) {
    throw new Error("partner_approval_booking_confirm_race");
  }
  const [jobEvent] = await input.tx
    .insert(partnerJobEvents)
    .values({
      partnerAccountId: input.accountId,
      partnerBookingId: input.target.bookingId,
      eventType: "job.approval_confirmed",
      publicLabel: "Approved and confirmed",
      publicDetail:
        "Account approval is complete. Your two-hour arrival window is confirmed.",
      effectiveAt: input.now,
      actorType: "partner",
      actorMembershipId: input.actorMembershipId,
      metadata: { approvalRequestId: input.request.id },
      createdAt: input.now,
    })
    .returning({ id: partnerJobEvents.id });
  if (!jobEvent) throw new Error("partner_approval_job_event_missing");
  const [calendarOutbox] = await input.tx
    .insert(outboxEvents)
    .values({
      type: "appointment.calendar_sync_requested",
      payload: {
        appointmentId: input.target.appointmentId,
        version: confirmedAppointment.updatedAt.toISOString(),
        reason: "partner.portal.v2.booking.approval_confirmed",
        requestedCalendarEventId: confirmedAppointment.calendarEventId,
        correlationId: input.correlationId,
      },
      createdAt: input.now,
    })
    .returning({ id: outboxEvents.id });
  if (!calendarOutbox) {
    throw new Error("partner_approval_calendar_outbox_missing");
  }
}

export async function decidePartnerApprovalRequest(
  input: ApprovalDecisionInput,
): Promise<PortalV2StoredResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await acquireScheduleConflictLock(tx);
    const [requestRow] = await tx
      .select()
      .from(partnerApprovalRequests)
      .where(
        and(
          eq(partnerApprovalRequests.id, input.requestId),
          eq(partnerApprovalRequests.partnerAccountId, input.accountId),
        ),
      )
      .for("update")
      .limit(1);
    if (!requestRow) {
      return { status: 404, body: { ok: false, error: "not_found" } };
    }
    const precondition = evaluatePortalV2RevisionPrecondition({
      ifMatch: input.ifMatch,
      currentRevision: approvalRevision(requestRow),
      correlationId: input.correlationId,
    });
    if (!precondition.ok) return storedDescriptor(precondition.response);

    const now = input.now ?? new Date();
    if (requestRow.state !== "pending") {
      return {
        status: 409,
        body: { ok: false, error: "conflict" },
        headers: { ETag: precondition.currentEtag },
      };
    }
    if (requestRow.requestedByMembershipId === input.membershipId) {
      return { status: 403, body: { ok: false, error: "forbidden" } };
    }

    const [membership] = await tx
      .select({
        id: partnerAccountMemberships.id,
        roleKey: partnerAccountMemberships.roleKey,
        accessLevel: partnerAccountMemberships.accessLevel,
        status: partnerAccountMemberships.status,
        roleTemplateId: partnerAccountMemberships.roleTemplateId,
        capabilityGrants: partnerAccountMemberships.capabilityGrants,
        capabilityDenies: partnerAccountMemberships.capabilityDenies,
        roleCapabilities: partnerRoleTemplates.capabilities,
        roleActive: partnerRoleTemplates.active,
      })
      .from(partnerAccountMemberships)
      .leftJoin(
        partnerRoleTemplates,
        and(
          eq(partnerAccountMemberships.roleTemplateId, partnerRoleTemplates.id),
          or(
            isNull(partnerRoleTemplates.partnerAccountId),
            eq(partnerRoleTemplates.partnerAccountId, input.accountId),
          ),
        ),
      )
      .where(
        and(
          eq(partnerAccountMemberships.id, input.membershipId),
          eq(partnerAccountMemberships.partnerAccountId, input.accountId),
          eq(partnerAccountMemberships.partnerUserId, input.partnerUserId),
          eq(partnerAccountMemberships.status, "active"),
        ),
      )
      .limit(1);
    if (!membership || membership.accessLevel !== "account") {
      return { status: 403, body: { ok: false, error: "forbidden" } };
    }
    const capabilities = computePartnerCapabilities({
      roleCapabilities:
        membership.roleTemplateId && membership.roleActive
          ? (membership.roleCapabilities ?? [])
          : [],
      grants: membership.capabilityGrants,
      denies: membership.capabilityDenies,
    });
    if (!capabilities.includes("approvals.decide")) {
      return { status: 403, body: { ok: false, error: "forbidden" } };
    }

    const rows = await tx
      .select({
        id: partnerApprovalDecisions.id,
        approvalRequestId: partnerApprovalDecisions.approvalRequestId,
        decidedByMembershipId: partnerApprovalDecisions.decidedByMembershipId,
        decision: partnerApprovalDecisions.decision,
        reason: partnerApprovalDecisions.reason,
        decisionSnapshot: partnerApprovalDecisions.decisionSnapshot,
        createdAt: partnerApprovalDecisions.createdAt,
        currentRoleKey: partnerAccountMemberships.roleKey,
      })
      .from(partnerApprovalDecisions)
      .leftJoin(
        partnerAccountMemberships,
        eq(
          partnerApprovalDecisions.decidedByMembershipId,
          partnerAccountMemberships.id,
        ),
      )
      .where(
        and(
          eq(partnerApprovalDecisions.approvalRequestId, requestRow.id),
          eq(partnerApprovalDecisions.partnerAccountId, input.accountId),
        ),
      )
      .orderBy(partnerApprovalDecisions.createdAt, partnerApprovalDecisions.id);
    if (
      rows.some(
        (decision) => decision.decidedByMembershipId === input.membershipId,
      )
    ) {
      return {
        status: 409,
        body: { ok: false, error: "conflict" },
        headers: { ETag: precondition.currentEtag },
      };
    }
    const immutableDecisions: ApprovalDecisionSnapshot[] = [];
    for (const decision of rows) {
      const roleKey = decisionRole(decision);
      if (
        !roleKey ||
        (decision.decision !== "approved" && decision.decision !== "declined")
      ) {
        return {
          status: 409,
          body: { ok: false, error: "conflict" },
          headers: { ETag: precondition.currentEtag },
        };
      }
      immutableDecisions.push({
        membershipId: decision.decidedByMembershipId,
        roleKey,
        capabilities: decisionCapabilities(decision),
        decision: decision.decision,
      });
    }
    const eligibility = evaluateAllMatchingApprovalRules({
      ruleSnapshot: requestRow.ruleSnapshot,
      requiredDecisionCount: requestRow.requiredDecisionCount,
      decisions: immutableDecisions,
      actorCapabilities: capabilities,
    });
    if (!eligibility.ok) {
      return {
        status: 409,
        body: { ok: false, error: "conflict" },
        headers: { ETag: precondition.currentEtag },
      };
    }
    if (!eligibility.actorEligible) {
      return { status: 403, body: { ok: false, error: "forbidden" } };
    }

    const afterDecision = evaluateAllMatchingApprovalRules({
      ruleSnapshot: requestRow.ruleSnapshot,
      requiredDecisionCount: requestRow.requiredDecisionCount,
      decisions: [
        ...immutableDecisions,
        {
          membershipId: input.membershipId,
          roleKey: membership.roleKey,
          capabilities: ["approvals.decide"],
          decision: input.decision,
        },
      ],
    });
    if (!afterDecision.ok) throw new Error("approval_rule_snapshot_invalid");
    const lifecycle = await loadPartnerApprovalLifecycleContext({
      tx,
      request: requestRow,
      accountId: input.accountId,
      approved: afterDecision.approved,
      declined: afterDecision.declined,
      now,
    });
    if (lifecycle.plan.kind === "conflict") {
      return {
        status: 409,
        body: { ok: false, error: "conflict" },
        headers: { ETag: precondition.currentEtag },
      };
    }

    const [insertedDecision] = await tx
      .insert(partnerApprovalDecisions)
      .values({
        approvalRequestId: requestRow.id,
        partnerAccountId: input.accountId,
        decidedByMembershipId: input.membershipId,
        decision: input.decision,
        reason: input.reason,
        decisionSnapshot: {
          roleKey: membership.roleKey,
          capabilities: ["approvals.decide"],
          eligibleRuleIds: eligibility.eligibleRuleIds,
          requestRevision: requestRow.revision,
          assuranceLevel: "aal1",
          lifecycle: lifecycle.plan.kind,
        },
        createdAt: now,
      })
      .returning({ id: partnerApprovalDecisions.id });
    if (!insertedDecision) throw new Error("approval_decision_insert_failed");

    await applyPartnerApprovalLifecycle({
      tx,
      request: requestRow,
      accountId: input.accountId,
      actorMembershipId: input.membershipId,
      correlationId: input.correlationId,
      plan: lifecycle.plan,
      target: lifecycle.target,
      hold: lifecycle.hold,
      now,
    });
    const nextState = lifecycle.plan.approvalState;
    const [updated] = await tx
      .update(partnerApprovalRequests)
      .set({
        state: nextState,
        resolvedAt: nextState === "pending" ? null : now,
        revision: requestRow.revision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerApprovalRequests.id, requestRow.id),
          eq(partnerApprovalRequests.revision, requestRow.revision),
        ),
      )
      .returning({
        id: partnerApprovalRequests.id,
        revision: partnerApprovalRequests.revision,
        updatedAt: partnerApprovalRequests.updatedAt,
      });
    if (!updated) throw new Error("approval_request_revision_race");

    const auditId = randomUUID();
    await tx.insert(auditLogs).values({
      id: auditId,
      actorType: "human",
      actorId: input.partnerUserId,
      actorLabel: input.email,
      actorRole: membership.roleKey,
      sessionId: input.sessionId,
      authMethod: "partner_session",
      correlationId: input.correlationId,
      requiredPermissions: ["approvals.decide"],
      outcome: "succeeded",
      surface: "/partners/approvals",
      idempotencyKeyHash: input.idempotencyKeyHash,
      action: "partner.approval.decided",
      entityType: "partner_approval_request",
      entityId: requestRow.id,
      meta: sanitizeAuditMetadata({
        eventId: auditId,
        correlationId: input.correlationId,
        partnerAccountId: input.accountId,
        partnerMembershipId: input.membershipId,
        decision: input.decision,
        lifecycle: lifecycle.plan.kind,
        before: { state: requestRow.state, revision: requestRow.revision },
        after: { state: nextState, revision: updated.revision },
        eligibleRuleIds: eligibility.eligibleRuleIds,
      }),
    });
    const etag = createPortalV2StrongEtag(approvalRevision(updated));
    return {
      status: 200,
      body: {
        ok: true,
        approvalRequest: {
          id: requestRow.id,
          state: nextState,
          revision: updated.revision,
          etag,
        },
        decision: {
          id: insertedDecision.id,
          decision: input.decision,
          reason: input.reason,
          createdAt: now.toISOString(),
        },
      },
      headers: { ETag: etag },
    };
  });
}

export type ApprovalDecisionPrincipal = Pick<
  PartnerPrincipal,
  | "accountId"
  | "membershipId"
  | "partnerUserId"
  | "email"
  | "roleKey"
  | "accessLevel"
  | "session"
>;

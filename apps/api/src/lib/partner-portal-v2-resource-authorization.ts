import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  getDb,
  partnerAccountLocations,
  partnerBookingDrafts,
  partnerBookings,
  partnerNotifications,
} from "@/db";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAXIMUM_SCOPE_IDS_PER_KIND = 1_000;

export type PartnerJobAuthorizationPrincipal = Pick<
  PartnerPrincipal,
  "accountId" | "accessLevel" | "accessScope"
>;

export type PartnerJobAuthorizationResource = Readonly<{
  partnerAccountId: string;
  propertyId: string | null;
  locationId: string | null;
}>;

export type PartnerDraftAuthorizationPrincipal = Pick<
  PartnerPrincipal,
  "accountId" | "membershipId" | "accessLevel" | "accessScope"
>;

export type PartnerDraftAuthorizationResource = Readonly<{
  partnerAccountId: string;
  createdByMembershipId: string;
  locationId: string | null;
  propertyId: string | null;
  locationActive: boolean;
}>;

function normalizeScopeIds(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > MAXIMUM_SCOPE_IDS_PER_KIND) {
    return [];
  }
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toLowerCase())
        .filter((value) => UUID_PATTERN.test(value)),
    ),
  ].sort();
}

export function normalizePartnerJobAccessScope(
  principal: PartnerJobAuthorizationPrincipal,
): Readonly<{
  locationIds: readonly string[];
  propertyIds: readonly string[];
}> {
  const rawScope: unknown = principal.accessScope;
  const scope =
    rawScope && typeof rawScope === "object" && !Array.isArray(rawScope)
      ? (rawScope as Record<string, unknown>)
      : {};
  return Object.freeze({
    locationIds: Object.freeze(normalizeScopeIds(scope["locationIds"])),
    propertyIds: Object.freeze(normalizeScopeIds(scope["propertyIds"])),
  });
}

/**
 * Stable authorization discriminator for cursors and caches. Scope IDs are
 * hashed so an opaque cursor never reveals internal property identifiers.
 */
export function partnerJobAccessScopeKey(
  principal: PartnerJobAuthorizationPrincipal,
): string {
  if (principal.accessLevel === "account") return "account";
  const scope = normalizePartnerJobAccessScope(principal);
  return `scoped:${createHash("sha256")
    .update(
      JSON.stringify({
        locationIds: scope.locationIds,
        propertyIds: scope.propertyIds,
      }),
      "utf8",
    )
    .digest("base64url")}`;
}

export function canAccessPartnerJobResource(
  principal: PartnerJobAuthorizationPrincipal,
  resource: PartnerJobAuthorizationResource,
): boolean {
  if (
    !principal.accountId ||
    resource.partnerAccountId !== principal.accountId
  ) {
    return false;
  }
  if (principal.accessLevel === "account") return true;

  const scope = normalizePartnerJobAccessScope(principal);
  return Boolean(
    (resource.locationId && scope.locationIds.includes(resource.locationId)) ||
      (resource.propertyId && scope.propertyIds.includes(resource.propertyId)),
  );
}

/**
 * Drafts without a location are private to their creator for scoped members.
 * Once a location is selected, the current location/property grants are the
 * sole scoped-access authority. Account-wide members retain account access.
 */
export function canAccessPartnerDraftResource(
  principal: PartnerDraftAuthorizationPrincipal,
  resource: PartnerDraftAuthorizationResource,
): boolean {
  if (
    !principal.accountId ||
    !principal.membershipId ||
    resource.partnerAccountId !== principal.accountId
  ) {
    return false;
  }
  if (principal.accessLevel === "account") return true;
  if (!resource.locationId) {
    return resource.createdByMembershipId === principal.membershipId;
  }
  if (!resource.locationActive) return false;

  const scope = normalizePartnerJobAccessScope(principal);
  return Boolean(
    scope.locationIds.includes(resource.locationId) ||
      (resource.propertyId && scope.propertyIds.includes(resource.propertyId)),
  );
}

/** Account-bound join used when evaluating a draft's current property grant. */
export function createPartnerDraftLocationJoinCondition(): SQL {
  return and(
    eq(
      partnerAccountLocations.partnerAccountId,
      partnerBookingDrafts.partnerAccountId,
    ),
    eq(partnerAccountLocations.id, partnerBookingDrafts.locationId),
  )!;
}

/**
 * Fail-closed SQL form of canAccessPartnerDraftResource. Callers must left
 * join partner_account_locations with createPartnerDraftLocationJoinCondition.
 */
export function createPartnerDraftAccessCondition(
  principal: PartnerDraftAuthorizationPrincipal,
  draftId?: string,
): SQL {
  if (
    !principal.accountId ||
    !principal.membershipId ||
    (draftId && !UUID_PATTERN.test(draftId))
  ) {
    return sql`false`;
  }
  const accountConditions: SQL[] = [
    eq(partnerBookingDrafts.partnerAccountId, principal.accountId),
  ];
  if (draftId) accountConditions.push(eq(partnerBookingDrafts.id, draftId));
  if (principal.accessLevel === "account") {
    return and(...accountConditions) ?? sql`false`;
  }

  const scope = normalizePartnerJobAccessScope(principal);
  const locatedGrants: SQL[] = [];
  if (scope.locationIds.length > 0) {
    locatedGrants.push(
      inArray(partnerAccountLocations.id, [...scope.locationIds]),
    );
  }
  if (scope.propertyIds.length > 0) {
    locatedGrants.push(
      inArray(partnerAccountLocations.propertyId, [...scope.propertyIds]),
    );
  }
  const creatorGrant = and(
    isNull(partnerBookingDrafts.locationId),
    eq(partnerBookingDrafts.createdByMembershipId, principal.membershipId),
  );
  const locatedGrant =
    locatedGrants.length > 0
      ? and(eq(partnerAccountLocations.active, true), or(...locatedGrants))
      : undefined;
  return (
    and(...accountConditions, or(creatorGrant, locatedGrant) ?? sql`false`) ??
    sql`false`
  );
}

/**
 * Canonical account-bound location join for legacy jobs whose location is
 * represented by partner_bookings.property_id.
 */
export function createPartnerJobLocationJoinCondition(): SQL {
  return and(
    eq(
      partnerAccountLocations.partnerAccountId,
      partnerBookings.partnerAccountId,
    ),
    eq(partnerAccountLocations.propertyId, partnerBookings.propertyId),
  )!;
}

/**
 * Builds a fail-closed SQL predicate. Callers must join
 * partner_account_locations using createPartnerJobLocationJoinCondition()
 * before applying it so location-scoped memberships are evaluated in SQL.
 */
export function createPartnerJobAccessCondition(
  principal: PartnerJobAuthorizationPrincipal,
  jobId?: string,
): SQL {
  if (!principal.accountId || (jobId && !UUID_PATTERN.test(jobId))) {
    return sql`false`;
  }

  const accountConditions: SQL[] = [
    eq(partnerBookings.partnerAccountId, principal.accountId),
  ];
  if (jobId) accountConditions.push(eq(partnerBookings.id, jobId));
  if (principal.accessLevel === "account") {
    return and(...accountConditions) ?? sql`false`;
  }

  const scope = normalizePartnerJobAccessScope(principal);
  const grants: SQL[] = [];
  if (scope.locationIds.length > 0) {
    grants.push(
      and(
        eq(partnerAccountLocations.partnerAccountId, principal.accountId),
        inArray(partnerAccountLocations.id, [...scope.locationIds]),
      )!,
    );
  }
  if (scope.propertyIds.length > 0) {
    grants.push(inArray(partnerBookings.propertyId, [...scope.propertyIds]));
  }

  return and(...accountConditions, or(...grants) ?? sql`false`) ?? sql`false`;
}

/**
 * Notification visibility follows the member's current job scope. Account-only
 * notifications remain visible, while a dangling or newly out-of-scope job
 * reference fails closed. Callers must join partner_bookings and
 * partner_account_locations with createPartnerJobLocationJoinCondition().
 */
export function createPartnerNotificationAccessCondition(
  principal: PartnerJobAuthorizationPrincipal,
): SQL {
  if (!principal.accountId) return sql`false`;
  return (
    and(
      eq(partnerNotifications.partnerAccountId, principal.accountId),
      or(
        isNull(partnerNotifications.partnerBookingId),
        createPartnerJobAccessCondition(principal),
      ),
    ) ?? sql`false`
  );
}

/**
 * Account-bound location predicate for list/detail/mutation routes. Scoped
 * memberships may see a location granted either directly or through its
 * canonical property; an empty or malformed scope always matches nothing.
 */
export function createPartnerLocationAccessCondition(
  principal: PartnerJobAuthorizationPrincipal,
  locationId?: string,
): SQL {
  if (!principal.accountId || (locationId && !UUID_PATTERN.test(locationId))) {
    return sql`false`;
  }
  const accountConditions: SQL[] = [
    eq(partnerAccountLocations.partnerAccountId, principal.accountId),
  ];
  if (locationId) {
    accountConditions.push(eq(partnerAccountLocations.id, locationId));
  }
  if (principal.accessLevel === "account") {
    return and(...accountConditions) ?? sql`false`;
  }
  const scope = normalizePartnerJobAccessScope(principal);
  const grants: SQL[] = [];
  if (scope.locationIds.length > 0) {
    grants.push(inArray(partnerAccountLocations.id, [...scope.locationIds]));
  }
  if (scope.propertyIds.length > 0) {
    grants.push(
      inArray(partnerAccountLocations.propertyId, [...scope.propertyIds]),
    );
  }
  return and(...accountConditions, or(...grants) ?? sql`false`) ?? sql`false`;
}

export async function hasPartnerLocationAccess(
  principal: PartnerJobAuthorizationPrincipal,
  locationId: string,
): Promise<boolean> {
  const [location] = await getDb()
    .select({ id: partnerAccountLocations.id })
    .from(partnerAccountLocations)
    .where(createPartnerLocationAccessCondition(principal, locationId))
    .limit(1);
  return Boolean(location);
}

/** Tenant-safe existence check for every booking-draft child route. */
export async function hasPartnerDraftAccess(
  principal: PartnerDraftAuthorizationPrincipal,
  draftId: string,
): Promise<boolean> {
  const [draft] = await getDb()
    .select({ id: partnerBookingDrafts.id })
    .from(partnerBookingDrafts)
    .leftJoin(
      partnerAccountLocations,
      createPartnerDraftLocationJoinCondition(),
    )
    .where(createPartnerDraftAccessCondition(principal, draftId))
    .limit(1);
  return Boolean(draft);
}

/**
 * Tenant-safe existence check for media/proof routes whose storage service owns
 * its own transaction. A false result must always be exposed as HTTP 404.
 */
export async function hasPartnerJobAccess(
  principal: PartnerJobAuthorizationPrincipal,
  jobId: string,
): Promise<boolean> {
  const db = getDb();
  const [job] = await db
    .select({ id: partnerBookings.id })
    .from(partnerBookings)
    .leftJoin(partnerAccountLocations, createPartnerJobLocationJoinCondition())
    .where(createPartnerJobAccessCondition(principal, jobId))
    .limit(1);
  return Boolean(job);
}

import { and, eq } from "drizzle-orm";
import { getDb, partnerAccountMemberships, partnerUsers } from "@/db";
import { loadActiveMembershipAccesses } from "@/lib/partner-account-authorization";
import type { PartnerSchedulingActor } from "@/lib/partner-portal-v2-scheduling";

/** Delayed work revalidates identity, current role, and relational scopes. */
export async function loadPartnerBackgroundSchedulingActor(
  accountId: string,
  membershipId: string,
): Promise<PartnerSchedulingActor | null> {
  const [identity] = await getDb()
    .select({ id: partnerUsers.id, email: partnerUsers.email })
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerUsers,
      eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
    )
    .where(
      and(
        eq(partnerAccountMemberships.id, membershipId),
        eq(partnerAccountMemberships.partnerAccountId, accountId),
        eq(partnerAccountMemberships.status, "active"),
        eq(partnerUsers.active, true),
        eq(partnerUsers.identityStatus, "active"),
      ),
    )
    .limit(1);
  if (!identity) return null;
  const access = (await loadActiveMembershipAccesses(identity.id)).find(
    (item) =>
      item.accountId === accountId && item.membershipId === membershipId,
  );
  if (!access?.capabilities.includes("bookings.create")) return null;
  return {
    accountId,
    membershipId,
    partnerUserId: identity.id,
    email: identity.email,
    sessionId: null,
    accessLevel: access.accessLevel,
    canReadRates: access.capabilities.includes("bookings.pricing.read"),
    locationIds: [...(access.accessScope.locationIds ?? [])],
    propertyIds: [...(access.accessScope.propertyIds ?? [])],
  };
}

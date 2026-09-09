import { and, asc, eq, ilike, or } from "drizzle-orm";
import {
  getDb,
  partnerAccountCostCenters,
  partnerAccountLocations,
} from "@/db";

export async function listPartnerInvitationScopeOptions(
  accountId: string,
  query = "",
) {
  const db = getDb();
  const search = "%" + query.replace(/[\\%_]/gu, (value) => "\\" + value) + "%";
  const [locations, costCenters] = await Promise.all([
    db
      .select({
        id: partnerAccountLocations.id,
        label: partnerAccountLocations.siteName,
      })
      .from(partnerAccountLocations)
      .where(
        and(
          eq(partnerAccountLocations.partnerAccountId, accountId),
          eq(partnerAccountLocations.active, true),
          query ? ilike(partnerAccountLocations.siteName, search) : undefined,
        ),
      )
      .orderBy(
        asc(partnerAccountLocations.siteName),
        asc(partnerAccountLocations.id),
      )
      .limit(101),
    db
      .select({
        id: partnerAccountCostCenters.id,
        label: partnerAccountCostCenters.name,
      })
      .from(partnerAccountCostCenters)
      .where(
        and(
          eq(partnerAccountCostCenters.partnerAccountId, accountId),
          eq(partnerAccountCostCenters.active, true),
          query
            ? or(
                ilike(partnerAccountCostCenters.name, search),
                ilike(partnerAccountCostCenters.code, search),
              )
            : undefined,
        ),
      )
      .orderBy(
        asc(partnerAccountCostCenters.name),
        asc(partnerAccountCostCenters.id),
      )
      .limit(101),
  ]);
  return {
    locations: locations.slice(0, 100),
    costCenters: costCenters.slice(0, 100),
    moreResults: locations.length > 100 || costCenters.length > 100,
  };
}

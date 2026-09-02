import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  partnerAccountLocations,
  partnerBookingDrafts,
  partnerQuotes,
  type DatabaseClient,
} from "@/db";

type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

/**
 * Resolves whether a Partner Quote V2 projection still targets an active
 * account location. Booking-bound quotes are intentionally exempt because the
 * booking itself is the durable operational target; direct-location and draft
 * bindings must remain active before any new commercial action is allowed.
 */
export function partnerQuoteTargetLocationActiveExpression(): SQL<boolean> {
  return sql<boolean>`case
    when ${partnerQuotes.partnerAccountLocationId} is not null then exists (
      select 1
      from partner_account_locations target_location
      where target_location.id = ${partnerQuotes.partnerAccountLocationId}
        and target_location.partner_account_id = ${partnerQuotes.partnerAccountId}
        and target_location.active is true
    )
    when ${partnerQuotes.bookingDraftId} is not null then exists (
      select 1
      from partner_booking_drafts target_draft
      join partner_account_locations target_location
        on target_location.id = target_draft.location_id
       and target_location.partner_account_id = target_draft.partner_account_id
      where target_draft.id = ${partnerQuotes.bookingDraftId}
        and target_draft.partner_account_id = ${partnerQuotes.partnerAccountId}
        and target_location.active is true
    )
    else true
  end`;
}

/** Account-safe canonical binding predicate used by archive impact checks. */
export function partnerQuoteBoundToLocationExpression(input: {
  locationId: string;
  propertyId: string | null;
}): SQL<boolean> {
  const bookingBinding = input.propertyId
    ? sql`exists (
        select 1
        from partner_bookings bound_job
        where bound_job.id = ${partnerQuotes.partnerBookingId}
          and bound_job.partner_account_id = ${partnerQuotes.partnerAccountId}
          and bound_job.property_id = ${input.propertyId}
      )`
    : sql`false`;
  return sql<boolean>`(
    ${partnerQuotes.partnerAccountLocationId} = ${input.locationId}
    or exists (
      select 1
      from partner_booking_drafts bound_draft
      where bound_draft.id = ${partnerQuotes.bookingDraftId}
        and bound_draft.partner_account_id = ${partnerQuotes.partnerAccountId}
        and bound_draft.location_id = ${input.locationId}
    )
    or (${bookingBinding})
  )`;
}

/**
 * Locks the direct/draft location target while a new quote action commits.
 * This makes quote issue/response race safely with location archival.
 */
export async function lockPartnerQuoteLocationForCommercialAction(
  tx: Pick<Transaction, "select">,
  input: { quoteId: string; accountId: string },
): Promise<boolean> {
  const [binding] = await tx
    .select({
      directLocationId: partnerQuotes.partnerAccountLocationId,
      bookingDraftId: partnerQuotes.bookingDraftId,
      bookingId: partnerQuotes.partnerBookingId,
    })
    .from(partnerQuotes)
    .where(
      and(
        eq(partnerQuotes.quoteId, input.quoteId),
        eq(partnerQuotes.partnerAccountId, input.accountId),
        eq(partnerQuotes.authority, "quote_v2"),
      ),
    )
    .limit(1);
  if (!binding) return true;
  if (binding.bookingId) return true;

  let locationId = binding.directLocationId;
  if (!locationId && binding.bookingDraftId) {
    const [draft] = await tx
      .select({ locationId: partnerBookingDrafts.locationId })
      .from(partnerBookingDrafts)
      .where(
        and(
          eq(partnerBookingDrafts.id, binding.bookingDraftId),
          eq(partnerBookingDrafts.partnerAccountId, input.accountId),
        ),
      )
      .limit(1);
    locationId = draft?.locationId ?? null;
  }
  if (!locationId) return false;

  const [location] = await tx
    .select({ active: partnerAccountLocations.active })
    .from(partnerAccountLocations)
    .where(
      and(
        eq(partnerAccountLocations.id, locationId),
        eq(partnerAccountLocations.partnerAccountId, input.accountId),
      ),
    )
    .for("share")
    .limit(1);
  return location?.active === true;
}

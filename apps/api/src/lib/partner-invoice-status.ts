import { sql, type SQL } from "drizzle-orm";
import { partnerInvoices } from "@/db";

/** Presentation/filter state is derived at read time, not a financial mutation.
 * A due date includes the entire New York calendar day, including DST days.
 * Passing the report snapshot instant makes every page/export consistent. */
export function effectivePartnerInvoiceStatusSql(
  asOf?: string | Date,
): SQL<string> {
  const clock =
    asOf === undefined
      ? sql`current_timestamp`
      : sql`${asOf instanceof Date ? asOf.toISOString() : asOf}::timestamptz`;
  return sql<string>`case
    when ${partnerInvoices.status} not in ('issued', 'partially_paid', 'paid', 'overdue') then ${partnerInvoices.status}
    when ${partnerInvoices.balanceCents} = 0 then 'paid'
    when ${partnerInvoices.dueDate} < (${clock} at time zone 'America/New_York')::date then 'overdue'
    when ${partnerInvoices.paidCents} > 0 then 'partially_paid'
    else 'issued'
  end`;
}

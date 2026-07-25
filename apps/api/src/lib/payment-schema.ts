import { sql } from "drizzle-orm";
import { getDb, type DatabaseClient } from "@/db";

export type PaymentSchemaProbeDatabase = Pick<DatabaseClient, "execute">;

function availabilityValue(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    value === "t" ||
    value === "true"
  );
}

/**
 * Release A intentionally runs before the provider-neutral payment migration.
 * Probe for the last payment table plus a sentinel column added by 0059 so
 * callers can avoid issuing queries against a partially or not-yet-migrated
 * ledger.
 */
export async function isPaymentLedgerSchemaAvailable(
  database?: PaymentSchemaProbeDatabase,
): Promise<boolean> {
  try {
    const rows = await (database ?? getDb()).execute(sql`
      select (
        to_regclass('public.payment_attempts') is not null
        and to_regclass('public.payment_refunds') is not null
        and to_regclass('public.payment_provider_events') is not null
        and exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'payments'
            and column_name = 'provider'
        )
      ) as available
    `);
    const row =
      Array.isArray(rows) && rows.length > 0
        ? (rows[0] as Record<string, unknown>)
        : null;
    return availabilityValue(row?.["available"]);
  } catch {
    return false;
  }
}

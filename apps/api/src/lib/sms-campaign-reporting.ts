import { sql } from "drizzle-orm";
import type { getDb } from "@/db";

/** Attribution uses the frozen offer ID, never a customer's last message time. */
export async function readCampaignOutcomes(
  db: ReturnType<typeof getDb>,
  campaignId: string,
) {
  const [row] = await db.execute<{
    quoted: number;
    quotedMinCents: number;
    quotedMaxCents: number;
    booked: number;
    bookedCents: number;
    collectedCents: number;
  }>(sql`
    with sale_versions as (
      select id, quote_id from quote_versions
      where document_snapshot #>> '{pricing,winterSale,campaignId}' = ${campaignId}
    ), issued as (
      select v.* from quotes q join quote_versions v on v.id = q.published_version_id
      where v.id in (select id from sale_versions) and v.issued_at is not null
        and v.state not in ('voided','superseded')
    ), jobs as (
      select a.* from appointments a where a.quote_version_id in (select id from sale_versions)
        or exists (
          select 1 from leads l join instant_quotes iq on iq.id = l.instant_quote_id
          where l.id = a.lead_id and iq.ai_result #>> '{winterSale,campaignId}' = ${campaignId}
        )
    ), collected as (
      select p.id, greatest(0, coalesce(p.total_amount_cents,p.amount) - greatest(
        p.refunded_amount_cents,
        coalesce((select sum(r.amount_cents) from payment_refunds r where r.payment_id=p.id and r.canonical_status='completed'),0)
      )) as cents
      from payments p where
        (p.quote_version_id in (select id from sale_versions) or p.appointment_id in (select id from jobs))
        and coalesce(p.canonical_status, case when p.status='succeeded' then 'completed' else p.status end)
          in ('completed','partially_refunded','refunded')
    ) select
      (select count(*)::int from issued) as quoted,
      (select coalesce(sum(total_min_cents),0)::bigint from issued) as "quotedMinCents",
      (select coalesce(sum(total_max_cents),0)::bigint from issued) as "quotedMaxCents",
      (select count(*)::int from jobs where status <> 'canceled') as booked,
      (select coalesce(sum(quoted_total_cents),0)::bigint from jobs where status <> 'canceled') as "bookedCents",
      (select coalesce(sum(cents),0)::bigint from collected) as "collectedCents"
  `);
  return {
    quoted: Number(row?.quoted ?? 0),
    quotedMinCents: Number(row?.quotedMinCents ?? 0),
    quotedMaxCents: Number(row?.quotedMaxCents ?? 0),
    booked: Number(row?.booked ?? 0),
    bookedCents: Number(row?.bookedCents ?? 0),
    collectedCents: Number(row?.collectedCents ?? 0),
  };
}

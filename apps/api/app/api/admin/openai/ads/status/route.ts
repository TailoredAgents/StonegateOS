import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { getDb, outboxEvents } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { getOutboxDispatchBlock } from "@/lib/outbox-dispatch-policy";
import {
  inspectOpenAiAdsConfiguration,
  OPENAI_ADS_OUTBOX_EVENT,
} from "@/lib/openai-ads";
import {
  buildWebsiteAnalyticsWindow,
  parseWebsiteAnalyticsRangeDays,
} from "@/lib/web-analytics-reporting";

export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requirePermission(request, "marketing.read");
  if (denied) return denied;

  const rangeDays = parseWebsiteAnalyticsRangeDays(
    new URL(request.url).searchParams.get("rangeDays"),
  );
  if (rangeDays === null)
    return NextResponse.json(
      { ok: false, error: "invalid_range_days" },
      { status: 400 },
    );
  const { startAt: since, timeframe } = buildWebsiteAnalyticsWindow(rangeDays);
  const db = getDb();
  const conversion = sql<string>`case
    when ${outboxEvents.payload}->'event'->>'type' = 'appointment_scheduled' then 'booking'
    when ${outboxEvents.payload}->'event'->>'type' = 'lead_created'
      and ${outboxEvents.payload}->'event'->>'action_source' = 'phone_call' then 'phone_inquiry'
    else 'other' end`;
  const scope = and(
    eq(outboxEvents.type, OPENAI_ADS_OUTBOX_EVENT),
    gte(outboxEvents.createdAt, since),
  );
  const [conversions, failures] = await Promise.all([
    db
      .select({
        type: conversion,
        queued:
          sql<number>`count(*) filter (where ${outboxEvents.processedAt} is null and ${outboxEvents.quarantinedAt} is null)`.mapWith(
            Number,
          ),
        delivered:
          sql<number>`count(*) filter (where ${outboxEvents.processedAt} is not null and ${outboxEvents.lastError} is null)`.mapWith(
            Number,
          ),
        quarantined:
          sql<number>`count(*) filter (where ${outboxEvents.quarantinedAt} is not null and ${outboxEvents.quarantineReason} is distinct from 'openai_ads_consent_revoked')`.mapWith(
            Number,
          ),
        suppressed:
          sql<number>`count(*) filter (where ${outboxEvents.quarantineReason} = 'openai_ads_consent_revoked')`.mapWith(
            Number,
          ),
        retrying:
          sql<number>`count(*) filter (where ${outboxEvents.processedAt} is null and ${outboxEvents.quarantinedAt} is null and ${outboxEvents.lastError} is not null)`.mapWith(
            Number,
          ),
        lastAcceptedAt: sql<
          string | null
        >`max(${outboxEvents.processedAt}) filter (where ${outboxEvents.lastError} is null)`,
      })
      .from(outboxEvents)
      .where(scope)
      .groupBy(conversion),
    db
      .select({
        code: outboxEvents.lastError,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(outboxEvents)
      .where(
        and(
          scope,
          isNotNull(outboxEvents.lastError),
          ne(outboxEvents.lastError, "openai_ads_consent_revoked"),
        ),
      )
      .groupBy(outboxEvents.lastError)
      .limit(30),
  ]);
  const safeCode = (value: string | null) =>
    value && /^[a-z_]+(?:_\d{3})?$/u.test(value)
      ? value
      : value
        ? "outbox_processing_error"
        : null;
  return NextResponse.json(
    {
      ok: true,
      configuration: inspectOpenAiAdsConfiguration(),
      dispatchBlocked:
        getOutboxDispatchBlock(OPENAI_ADS_OUTBOX_EVENT)?.reason ?? null,
      periodStart: since.toISOString(),
      timeframe,
      totals: conversions.reduce(
        (totals, row) => ({
          queued: totals.queued + row.queued,
          delivered: totals.delivered + row.delivered,
          quarantined: totals.quarantined + row.quarantined,
          retrying: totals.retrying + row.retrying,
          suppressed: totals.suppressed + row.suppressed,
        }),
        { queued: 0, delivered: 0, quarantined: 0, retrying: 0, suppressed: 0 },
      ),
      events: conversions.map(
        ({ lastAcceptedAt: _lastAcceptedAt, ...counts }) => counts,
      ),
      latestDeliveryAt: conversions.reduce<string | null>(
        (latest, row) =>
          row.lastAcceptedAt &&
          (!latest || new Date(row.lastAcceptedAt) > new Date(latest))
            ? row.lastAcceptedAt
            : latest,
        null,
      ),
      errors: failures.map((failure) => ({
        ...failure,
        code: safeCode(failure.code),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

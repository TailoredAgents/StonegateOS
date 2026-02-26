import { and, desc, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb, messageDeliveryEvents, outboxEvents, providerHealth, webEventCountsDaily } from "../db";

function safeDiv(num: number, den: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return num / den;
}

function toPercent(n: number): string {
  if (!Number.isFinite(n)) return "0%";
  return `${Math.round(n * 100)}%`;
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

function fmtAgeMinutes(from: Date | null | undefined, now: Date) {
  if (!from) return "unknown";
  const ms = now.getTime() - new Date(from as any).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hours}h${String(rem).padStart(2, "0")}m`;
}

export async function buildOpsDiagnosticsMarkdown(input: {
  tz: string;
  lookbackHours?: number;
  outboxStaleMinutes?: number;
  smsLookbackMinutes?: number;
}): Promise<string> {
  const tz = (input.tz || "America/New_York").trim() || "America/New_York";
  const lookbackHours = clampInt(input.lookbackHours ?? 6, 1, 48);
  const outboxStaleMinutes = clampInt(input.outboxStaleMinutes ?? 10, 3, 180);
  const smsLookbackMinutes = clampInt(input.smsLookbackMinutes ?? 120, 15, 1440);

  const nowLuxon = DateTime.now().setZone(tz);
  const now = nowLuxon.toJSDate();
  const sinceFailure = nowLuxon.minus({ hours: lookbackHours }).toJSDate();
  const smsSince = nowLuxon.minus({ minutes: smsLookbackMinutes }).toJSDate();
  const outboxStaleBefore = nowLuxon.minus({ minutes: outboxStaleMinutes }).toJSDate();
  const todayDate = nowLuxon.toISODate() ?? DateTime.now().toISODate() ?? "";

  const db = getDb();

  const [providers, outboxSummary, outboxTopTypes, smsFailures, smsRecent, todayWeb] = await Promise.all([
    db
      .select()
      .from(providerHealth)
      .where(
        and(
          isNotNull(providerHealth.lastFailureAt),
          gte(providerHealth.lastFailureAt, sinceFailure),
          or(sql`${providerHealth.lastSuccessAt} is null`, sql`${providerHealth.lastFailureAt} > ${providerHealth.lastSuccessAt}`)
        )
      )
      .orderBy(desc(providerHealth.lastFailureAt))
      .limit(20),
    db
      .select({
        backlog: sql<number>`coalesce(count(*) filter (where ${outboxEvents.processedAt} is null and ${outboxEvents.createdAt} < ${outboxStaleBefore}), 0)`.mapWith(Number),
        retrying: sql<number>`coalesce(count(*) filter (where ${outboxEvents.processedAt} is null and ${outboxEvents.attempts} >= 1), 0)`.mapWith(Number),
        highAttempts: sql<number>`coalesce(count(*) filter (where ${outboxEvents.processedAt} is null and ${outboxEvents.attempts} >= 3), 0)`.mapWith(Number),
        oldest: sql<Date | null>`min(${outboxEvents.createdAt}) filter (where ${outboxEvents.processedAt} is null)`.mapWith(
          (v) => (v ? new Date(v as any) : null)
        )
      })
      .from(outboxEvents)
      .then((rows) => rows[0] ?? null),
    db.execute(
      sql`
        select ${outboxEvents.type} as type, count(*)::int as count
        from ${outboxEvents}
        where ${outboxEvents.processedAt} is null
        group by ${outboxEvents.type}
        order by count desc
        limit 6
      `
    ) as Promise<Array<{ type?: string | null; count?: number | null }>>,
    db
      .select({
        failed: sql<number>`coalesce(count(*),0)`.mapWith(Number)
      })
      .from(messageDeliveryEvents)
      .where(and(eq(messageDeliveryEvents.status, "failed" as any), gte(messageDeliveryEvents.occurredAt, smsSince)))
      .then((rows) => rows[0] ?? null),
    db
      .select({
        occurredAt: messageDeliveryEvents.occurredAt,
        detail: messageDeliveryEvents.detail,
        provider: messageDeliveryEvents.provider
      })
      .from(messageDeliveryEvents)
      .where(and(eq(messageDeliveryEvents.status, "failed" as any), gte(messageDeliveryEvents.occurredAt, smsSince)))
      .orderBy(desc(messageDeliveryEvents.occurredAt))
      .limit(5),
    db
      .select({
        bookStep1Views: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='book_step_view' and ${webEventCountsDaily.key}='1' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(Number),
        bookStep1Submits: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='book_step1_submit' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(Number),
        bookQuoteSuccess: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='book_quote_success' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(Number),
        bookBookingSuccess: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='book_booking_success' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(Number)
      })
      .from(webEventCountsDaily)
      .where(eq(webEventCountsDaily.dateStart, todayDate))
      .then((rows) => rows[0] ?? null)
  ]);

  const lines: string[] = [];
  const stamp = nowLuxon.isValid ? nowLuxon.toFormat("ccc, LLL d h:mma") : "";
  lines.push(`**Ops Diagnostic Snapshot${stamp ? ` - ${stamp} (${tz})` : ""}**`);
  lines.push("");

  // Funnel
  const views = todayWeb?.bookStep1Views ?? 0;
  const submits = todayWeb?.bookStep1Submits ?? 0;
  const quotes = todayWeb?.bookQuoteSuccess ?? 0;
  const bookings = todayWeb?.bookBookingSuccess ?? 0;
  const submitRate = safeDiv(submits, views);
  const quoteRate = safeDiv(quotes, submits);
  const bookRate = safeDiv(bookings, quotes);
  lines.push("**/book funnel (today)**");
  lines.push(`- Step1 views: ${views} | Submits: ${submits} (${toPercent(submitRate)})`);
  lines.push(`- Quotes shown: ${quotes} (${toPercent(quoteRate)} of submits) | Self-serve bookings: ${bookings} (${toPercent(bookRate)} of quotes)`);
  lines.push("");

  // Provider health
  lines.push(`**Provider health (last ${lookbackHours}h)**`);
  if (!providers.length) {
    lines.push("- No failing providers recorded recently.");
  } else {
    for (const row of providers.slice(0, 6) as any[]) {
      const provider = String(row.provider ?? "unknown");
      const at = row.lastFailureAt ? fmtAgeMinutes(row.lastFailureAt, now) : "unknown";
      const detail = String(row.lastFailureDetail ?? "").trim();
      lines.push(`- ${provider}: failing (${at} ago)${detail ? ` — ${detail.slice(0, 160)}` : ""}`);
    }
  }
  lines.push("");

  // Outbox
  const backlog = outboxSummary?.backlog ?? 0;
  const retrying = outboxSummary?.retrying ?? 0;
  const highAttempts = outboxSummary?.highAttempts ?? 0;
  const oldestAge = fmtAgeMinutes(outboxSummary?.oldest ?? null, now);
  const typeLines = Array.isArray(outboxTopTypes)
    ? outboxTopTypes
        .map((r) => (r && typeof r.type === "string" ? `${r.type}: ${Number(r.count) || 0}` : null))
        .filter(Boolean)
        .slice(0, 6)
    : [];

  lines.push(`**Outbox queue**`);
  lines.push(`- Backlog (stale>${outboxStaleMinutes}m): ${backlog} | Retrying: ${retrying} | High attempts (>=3): ${highAttempts} | Oldest: ${oldestAge}`);
  if (typeLines.length) lines.push(`- Top types: ${typeLines.join(", ")}`);
  lines.push("");

  // SMS failures
  const smsFailed = smsFailures?.failed ?? 0;
  lines.push(`**SMS delivery (last ${smsLookbackMinutes}m)**`);
  lines.push(`- Failed delivery events: ${smsFailed}`);
  const recent = Array.isArray(smsRecent) ? smsRecent : [];
  for (const row of recent as any[]) {
    const at = row.occurredAt ? fmtAgeMinutes(row.occurredAt, now) : "unknown";
    const provider = typeof row.provider === "string" ? row.provider : "";
    const detail = typeof row.detail === "string" ? row.detail.trim().slice(0, 140) : "";
    lines.push(`- ${at} ago${provider ? ` (${provider})` : ""}${detail ? ` — ${detail}` : ""}`);
  }

  return lines.join("\n").trim();
}

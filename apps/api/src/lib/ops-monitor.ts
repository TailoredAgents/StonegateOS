import { and, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb, messageDeliveryEvents, outboxEvents, providerHealth, webEventCountsDaily } from "../db";

type Severity = "info" | "warn" | "critical";

export type OpsAlert = {
  key: string;
  severity: Severity;
  title: string;
  detail?: string;
  recommendation?: string;
};

function toPercent(n: number): string {
  if (!Number.isFinite(n)) return "0%";
  return `${Math.round(n * 100)}%`;
}

function safeDiv(num: number, den: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return num / den;
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

export async function computeOpsMonitorAlerts(input: {
  tz: string;
  lookbackHours?: number;
  outboxStaleMinutes?: number;
  smsLookbackMinutes?: number;
}): Promise<OpsAlert[]> {
  const tz = (input.tz || "America/New_York").trim() || "America/New_York";
  const lookbackHours = clampInt(input.lookbackHours ?? 6, 1, 48);
  const outboxStaleMinutes = clampInt(input.outboxStaleMinutes ?? 10, 3, 180);
  const smsLookbackMinutes = clampInt(input.smsLookbackMinutes ?? 120, 15, 1440);

  const now = DateTime.now().setZone(tz);
  const sinceFailure = now.minus({ hours: lookbackHours }).toJSDate();
  const outboxStaleBefore = now.minus({ minutes: outboxStaleMinutes }).toJSDate();
  const smsSince = now.minus({ minutes: smsLookbackMinutes }).toJSDate();
  const todayDate = now.toISODate() ?? DateTime.now().toISODate() ?? "";

  const db = getDb();

  const [providers, outboxCounts, smsFailures, todayWeb] = await Promise.all([
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
      .limit(50),
    db
      .select({
        backlog: sql<number>`coalesce(count(*) filter (where ${outboxEvents.processedAt} is null and ${outboxEvents.createdAt} < ${outboxStaleBefore}), 0)`.mapWith(Number),
        retrying: sql<number>`coalesce(count(*) filter (where ${outboxEvents.processedAt} is null and ${outboxEvents.attempts} >= 1), 0)`.mapWith(Number),
        highAttempts: sql<number>`coalesce(count(*) filter (where ${outboxEvents.processedAt} is null and ${outboxEvents.attempts} >= 3), 0)`.mapWith(Number)
      })
      .from(outboxEvents)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        failed: sql<number>`coalesce(count(*),0)`.mapWith(Number)
      })
      .from(messageDeliveryEvents)
      .where(and(eq(messageDeliveryEvents.status, "failed" as any), gte(messageDeliveryEvents.occurredAt, smsSince)))
      .then((rows) => rows[0] ?? null),
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

  const alerts: OpsAlert[] = [];

  for (const row of providers) {
    const provider = String((row as any).provider ?? "").trim() || "unknown";
    const detail = String((row as any).lastFailureDetail ?? "").trim();
    alerts.push({
      key: `provider:${provider}`,
      severity: provider === "sms" ? "critical" : "warn",
      title: `Provider failing: ${provider}`,
      detail: detail ? detail.slice(0, 280) : undefined,
      recommendation: "Check logs + credentials, then retry."
    });
  }

  const backlog = outboxCounts?.backlog ?? 0;
  const retrying = outboxCounts?.retrying ?? 0;
  const highAttempts = outboxCounts?.highAttempts ?? 0;
  if (backlog >= 10 || highAttempts >= 3) {
    alerts.push({
      key: "outbox:backlog",
      severity: "critical",
      title: "Outbox backlog looks stuck",
      detail: `Backlog: ${backlog}, retrying: ${retrying}, high-attempts: ${highAttempts}`,
      recommendation: "Check the outbox worker + provider credentials."
    });
  } else if (backlog >= 5) {
    alerts.push({
      key: "outbox:backlog",
      severity: "warn",
      title: "Outbox backlog is growing",
      detail: `Backlog: ${backlog}, retrying: ${retrying}`,
      recommendation: "Check worker health and recent failures."
    });
  }

  const smsFailed = smsFailures?.failed ?? 0;
  if (smsFailed >= 3) {
    alerts.push({
      key: "sms:failed",
      severity: "warn",
      title: "SMS failures detected",
      detail: `${smsFailed} failed delivery event(s) in the last ${smsLookbackMinutes} minutes.`,
      recommendation: "Check Twilio logs + destination numbers."
    });
  }

  const views = todayWeb?.bookStep1Views ?? 0;
  const submits = todayWeb?.bookStep1Submits ?? 0;
  const quotes = todayWeb?.bookQuoteSuccess ?? 0;
  const bookings = todayWeb?.bookBookingSuccess ?? 0;
  const quoteRate = safeDiv(quotes, submits);
  const bookRate = safeDiv(bookings, quotes);

  if (submits >= 5 && quoteRate < 0.85) {
    alerts.push({
      key: "funnel:submit_quote",
      severity: "warn",
      title: "Submit → Quote shown looks low today",
      detail: `Submits: ${submits}, quotes shown: ${quotes} (${toPercent(quoteRate)}).`,
      recommendation: "Check /book step 2 + quote calculation logs for errors."
    });
  }
  if (quotes >= 5 && bookRate < 0.08) {
    alerts.push({
      key: "funnel:quote_book",
      severity: "info",
      title: "Quote → Self-serve booking looks low today",
      detail: `Quotes shown: ${quotes}, self-serve bookings: ${bookings} (${toPercent(bookRate)}).`,
      recommendation: "Consider follow-up speed + messaging clarity."
    });
  }

  return alerts;
}

export function formatOpsMonitorAlertsMarkdown(input: { alerts: OpsAlert[]; tz: string }): string | null {
  const alerts = input.alerts ?? [];
  if (!alerts.length) return null;

  const tz = (input.tz || "America/New_York").trim() || "America/New_York";
  const now = DateTime.now().setZone(tz);
  const stamp = now.isValid ? now.toFormat("ccc, LLL d") : "";

  const severityOrder: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };
  const sorted = [...alerts].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const lines: string[] = [];
  lines.push(`**Ops Monitor Alerts${stamp ? ` — ${stamp} (${tz})` : ""}**`);
  for (const a of sorted.slice(0, 8)) {
    const prefix = a.severity === "critical" ? "[CRITICAL]" : a.severity === "warn" ? "[WARN]" : "[INFO]";
    const parts: string[] = [];
    parts.push(`${prefix} **${a.title}**`);
    if (a.detail) parts.push(`  - ${a.detail}`);
    if (a.recommendation) parts.push(`  - Next: ${a.recommendation}`);
    lines.push(parts.join("\n"));
  }

  return lines.join("\n");
}

export async function buildOpsMonitorAlertsMarkdown(input: { tz: string }) {
  const alerts = await computeOpsMonitorAlerts({ tz: input.tz });
  return formatOpsMonitorAlertsMarkdown({ alerts, tz: input.tz });
}

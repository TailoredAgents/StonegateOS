import { execSync } from "node:child_process";
import dotenv from "dotenv";
import postgres from "postgres";

dotenv.config();
dotenv.config({ path: "apps/api/.env.local", override: true });

type CheckStatus = "pass" | "warn" | "fail";

type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
};

type PolicyRow = {
  key: string;
  value: Record<string, unknown>;
  updated_at: Date;
};

type AutomationRow = {
  channel: string;
  mode: string;
  updated_at: Date;
};

type ProviderRow = {
  provider: string;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_failure_detail: string | null;
  updated_at: Date;
};

type OutboxSummaryRow = {
  type: string;
  total: string | number;
  pending: string | number;
  failed_or_retrying: string | number;
  oldest_pending_at: Date | null;
};

type StuckOutboxRow = {
  id: string;
  type: string;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  next_attempt_at: Date | null;
};

type ActionSummaryRow = {
  proposed_action: string;
  executed_action: string | null;
  autonomy_mode: string;
  stage: string;
  error: string | null;
  count: string | number;
  latest_at: Date;
};

type AuditBookingRow = {
  count: string | number;
  latest_at: Date | null;
};

function asCount(value: string | number | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function getGitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function envPresent(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function hasStringArray(value: unknown, required: string[]): boolean {
  if (!Array.isArray(value)) return false;
  const values = new Set(value.filter((entry): entry is string => typeof entry === "string"));
  return required.every((entry) => values.has(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addCheck(checks: Check[], name: string, passed: boolean, detail: string, warnInstead = false) {
  checks.push({ name, status: passed ? "pass" : warnInstead ? "warn" : "fail", detail });
}

function scoreFromChecks(base: number, checks: Check[], names: string[]): number {
  let score = base;
  for (const name of names) {
    const check = checks.find((entry) => entry.name === name);
    if (!check) continue;
    if (check.status === "pass") score += 3;
    if (check.status === "warn") score -= 3;
    if (check.status === "fail") score -= 8;
  }
  return Math.max(0, Math.min(100, score));
}

async function tableExists(sql: postgres.Sql, tableName: string): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = ${tableName}
    ) as exists
  `;
  return Boolean(rows[0]?.exists);
}

async function main() {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required. The audit is read-only but needs a database connection.");
  }

  const shouldUseSsl =
    process.env["DATABASE_SSL"] === "true" ||
    /render\.com/.test(databaseUrl) ||
    /sslmode=require/.test(databaseUrl);
  const sql = postgres(databaseUrl, {
    prepare: false,
    max: 1,
    ...(shouldUseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  try {
    const checks: Check[] = [];
    const commit = getGitCommit();
    const dbInfo = await sql<{ database: string; checked_at: Date }[]>`
      select current_database() as database, now() as checked_at
    `;

    const policyRows = await sql<PolicyRow[]>`
      select key, value, updated_at
      from policy_settings
      where key in ('business_hours', 'sales_autopilot')
      order by key
    `;
    const policies = new Map(policyRows.map((row) => [row.key, row]));
    const businessHours = policies.get("business_hours")?.value ?? null;
    const salesAutopilot = policies.get("sales_autopilot")?.value ?? null;

    const automationRows = await sql<AutomationRow[]>`
      select channel, mode, updated_at
      from automation_settings
      where channel in ('sms', 'dm', 'email')
      order by channel
    `;
    const automation = new Map(automationRows.map((row) => [row.channel, row]));

    const providerRows = await sql<ProviderRow[]>`
      select provider, last_success_at, last_failure_at, last_failure_detail, updated_at
      from provider_health
      where provider in ('sms', 'calendar', 'email')
      order by provider
    `;
    const providers = new Map(providerRows.map((row) => [row.provider, row]));

    const outboxSummary = await sql<OutboxSummaryRow[]>`
      select
        type,
        count(*) as total,
        count(*) filter (where processed_at is null) as pending,
        count(*) filter (where processed_at is null and (attempts > 0 or last_error is not null)) as failed_or_retrying,
        min(created_at) filter (where processed_at is null) as oldest_pending_at
      from outbox_events
      where type in ('message.received', 'facebook.sales.evaluate', 'message.send', 'sales.autopilot.draft')
        and created_at > now() - interval '7 days'
      group by type
      order by type
    `;
    const stuckOutbox = await sql<StuckOutboxRow[]>`
      select id, type, attempts, last_error, created_at, next_attempt_at
      from outbox_events
      where processed_at is null
        and type in ('message.received', 'facebook.sales.evaluate', 'message.send', 'sales.autopilot.draft')
        and created_at < now() - interval '10 minutes'
      order by created_at asc
      limit 20
    `;

    const hasActionTable = await tableExists(sql, "facebook_sales_autopilot_actions");
    const actionSummary = hasActionTable
      ? await sql<ActionSummaryRow[]>`
          select
            proposed_action,
            executed_action,
            autonomy_mode,
            stage,
            nullif(error, '') as error,
            count(*) as count,
            max(created_at) as latest_at
          from facebook_sales_autopilot_actions
          where created_at > now() - interval '7 days'
          group by proposed_action, executed_action, autonomy_mode, stage, nullif(error, '')
          order by latest_at desc
          limit 25
        `
      : [];

    const bookingAudit = await sql<AuditBookingRow[]>`
      select count(*) as count, max(created_at) as latest_at
      from audit_logs
      where action = 'appointment.booked'
        and meta->>'source' = 'sales_autopilot'
        and created_at > now() - interval '7 days'
    `;

    const businessWeekly = isRecord(businessHours?.["weekly"]) ? businessHours["weekly"] as Record<string, unknown> : {};
    addCheck(
      checks,
      "business_hours_policy",
      businessHours?.["timezone"] === "America/New_York" &&
        Array.isArray(businessWeekly["monday"]) &&
        Array.isArray(businessWeekly["saturday"]) &&
        Array.isArray(businessWeekly["sunday"]) &&
        (businessWeekly["sunday"] as unknown[]).length === 0,
      "Expected America/New_York, weekday hours, Saturday hours, and Sunday closed.",
    );

    const channelModes = isRecord(salesAutopilot?.["channelModes"]) ? salesAutopilot["channelModes"] as Record<string, unknown> : {};
    addCheck(
      checks,
      "sales_autopilot_policy",
      salesAutopilot?.["enabled"] === true &&
        salesAutopilot?.["mode"] === "full" &&
        channelModes["sms"] === "full" &&
        channelModes["dm"] === "full" &&
        hasStringArray(salesAutopilot?.["liveReplyAutonomyChannels"], ["sms", "dm"]),
      "Expected full enabled policy with SMS and DM live reply autonomy.",
    );

    const closer = isRecord(salesAutopilot?.["facebookCloser"]) ? salesAutopilot["facebookCloser"] as Record<string, unknown> : {};
    addCheck(
      checks,
      "closer_auto_enabled",
      closer["mode"] === "auto" && closer["emergencyStop"] === false,
      "Expected Facebook/SMS closer mode auto and emergency stop off.",
    );

    addCheck(
      checks,
      "automation_modes",
      automation.get("sms")?.mode === "auto" && automation.get("dm")?.mode === "auto",
      `Current modes: ${automationRows.map((row) => `${row.channel}=${row.mode}`).join(", ") || "none"}.`,
    );

    addCheck(
      checks,
      "required_environment",
      envPresent("API_BASE_URL") &&
        envPresent("ADMIN_API_KEY") &&
        envPresent("OPENAI_API_KEY") &&
        (envPresent("FB_PAGE_ACCESS_TOKEN") || envPresent("FB_MESSENGER_ACCESS_TOKEN")) &&
        (envPresent("GOOGLE_CALENDAR_ID") || envPresent("GOOGLE_CALENDAR_IDS")),
      "Checks local/runtime env visibility for booking, AI, Messenger, and calendar variables.",
      true,
    );

    const sms = providers.get("sms");
    const calendar = providers.get("calendar");
    addCheck(
      checks,
      "sms_provider_health",
      Boolean(sms?.last_success_at && (!sms.last_failure_at || sms.last_success_at >= sms.last_failure_at)),
      sms ? `lastSuccess=${iso(sms.last_success_at)}, lastFailure=${iso(sms.last_failure_at)}` : "No sms provider_health row.",
      true,
    );
    addCheck(
      checks,
      "calendar_provider_health",
      Boolean(calendar?.last_success_at && (!calendar.last_failure_at || calendar.last_success_at >= calendar.last_failure_at)),
      calendar ? `lastSuccess=${iso(calendar.last_success_at)}, lastFailure=${iso(calendar.last_failure_at)}` : "No calendar provider_health row.",
      true,
    );

    addCheck(
      checks,
      "outbox_not_stuck",
      stuckOutbox.length === 0,
      stuckOutbox.length === 0 ? "No target outbox events older than 10 minutes." : `${stuckOutbox.length} target events are pending >10 minutes.`,
    );

    const actionErrors = actionSummary.reduce((sum, row) => sum + (row.error ? asCount(row.count) : 0), 0);
    addCheck(
      checks,
      "recent_autopilot_actions",
      actionSummary.length > 0,
      actionSummary.length > 0 ? `${actionSummary.length} action groups observed in the last 7 days.` : "No Facebook/SMS closer actions observed in the last 7 days.",
      true,
    );
    addCheck(
      checks,
      "recent_autopilot_errors",
      actionErrors === 0,
      actionErrors === 0 ? "No recent autopilot action errors." : `${actionErrors} recent autopilot actions have errors.`,
    );

    const recentBookings = asCount(bookingAudit[0]?.count);
    addCheck(
      checks,
      "recent_autopilot_bookings",
      recentBookings > 0,
      recentBookings > 0
        ? `${recentBookings} sales_autopilot appointment booking audit rows in the last 7 days.`
        : "No sales_autopilot appointment bookings observed in the last 7 days.",
      true,
    );

    const functionality = scoreFromChecks(72, checks, [
      "business_hours_policy",
      "sales_autopilot_policy",
      "automation_modes",
      "required_environment",
      "outbox_not_stuck",
      "recent_autopilot_actions",
      "recent_autopilot_errors",
    ]);
    const conversation = scoreFromChecks(60, checks, [
      "sales_autopilot_policy",
      "closer_auto_enabled",
      "recent_autopilot_actions",
      "recent_autopilot_errors",
      "outbox_not_stuck",
    ]);
    const booking = scoreFromChecks(84, checks, [
      "business_hours_policy",
      "required_environment",
      "calendar_provider_health",
      "outbox_not_stuck",
      "recent_autopilot_bookings",
    ]);
    const safety = scoreFromChecks(78, checks, [
      "business_hours_policy",
      "closer_auto_enabled",
      "automation_modes",
      "recent_autopilot_errors",
      "outbox_not_stuck",
    ]);
    const overall = Math.round((functionality + conversation + booking + safety) / 4);

    const output = {
      checkedAt: iso(dbInfo[0]?.checked_at ?? new Date()),
      database: dbInfo[0]?.database ?? "unknown",
      commit,
      confidence: {
        overall,
        functionality,
        conversation,
        booking,
        safety,
      },
      checks,
      observations: {
        policies: policyRows.map((row) => ({ key: row.key, updatedAt: iso(row.updated_at) })),
        automation: automationRows.map((row) => ({ channel: row.channel, mode: row.mode, updatedAt: iso(row.updated_at) })),
        providerHealth: providerRows.map((row) => ({
          provider: row.provider,
          lastSuccessAt: iso(row.last_success_at),
          lastFailureAt: iso(row.last_failure_at),
          lastFailureDetail: row.last_failure_detail,
          updatedAt: iso(row.updated_at),
        })),
        outboxSummary: outboxSummary.map((row) => ({
          type: row.type,
          total: asCount(row.total),
          pending: asCount(row.pending),
          failedOrRetrying: asCount(row.failed_or_retrying),
          oldestPendingAt: iso(row.oldest_pending_at),
        })),
        stuckOutbox: stuckOutbox.map((row) => ({
          id: row.id,
          type: row.type,
          attempts: row.attempts,
          lastError: row.last_error,
          createdAt: iso(row.created_at),
          nextAttemptAt: iso(row.next_attempt_at),
        })),
        recentAutopilotActions: actionSummary.map((row) => ({
          proposedAction: row.proposed_action,
          executedAction: row.executed_action,
          autonomyMode: row.autonomy_mode,
          stage: row.stage,
          error: row.error,
          count: asCount(row.count),
          latestAt: iso(row.latest_at),
        })),
        recentAutopilotBookings: {
          count: recentBookings,
          latestAt: iso(bookingAudit[0]?.latest_at ?? null),
        },
      },
    };

    console.log(JSON.stringify(output, null, 2));
    const hasFail = checks.some((check) => check.status === "fail");
    if (hasFail) process.exitCode = 2;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  if (error instanceof Error) {
    console.error(error.message || error.stack || String(error));
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { getDb, providerHealth } from "@/db";
import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";
import { isAdminRequest } from "../../../web/admin";

const PROVIDERS = ["sms", "email", "calendar", "meta_ads", "google_ads"] as const;

type ProviderStatus = "healthy" | "degraded" | "unknown";

type HealthFinding = {
  id: string;
  severity: "blocker" | "warning";
  title: string;
  detail: string;
  fix: string[];
};

function resolveStatus(row?: {
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}): ProviderStatus {
  if (!row?.lastSuccessAt && !row?.lastFailureAt) return "unknown";
  if (row?.lastFailureAt && (!row.lastSuccessAt || row.lastFailureAt > row.lastSuccessAt)) {
    return "degraded";
  }
  return "healthy";
}

function readSiteUrlEnv(): string {
  return (process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "").trim();
}

function getPublicSiteUrlBlocker(): HealthFinding | null {
  const configured = resolvePublicSiteBaseUrl();
  if (configured) return null;

  const raw = readSiteUrlEnv();
  const hint = raw ? `Current value: ${raw}` : "No value set";
  return {
    id: "public_site_url",
    severity: "blocker",
    title: "Public website URL not configured",
    detail: `Customer-facing links (quotes, partner portal, reschedules) require a valid HTTPS site URL. ${hint}.`,
    fix: [
      "Set `SITE_URL=https://your-domain.com` (or `NEXT_PUBLIC_SITE_URL`) on Render for `stonegate-api` and `stonegate-outbox-worker`.",
      "Redeploy both services.",
      "Re-try the customer-facing action (send quote / invite partner)."
    ]
  };
}

function getTwilioBlocker(): HealthFinding | null {
  const required = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"] as const;
  const missing = required.filter((key) => !(process.env[key] ?? "").trim());
  if (missing.length === 0) return null;

  return {
    id: "twilio_not_configured",
    severity: "blocker",
    title: "Twilio not configured",
    detail: `Outbound calls/SMS are disabled because these env vars are missing: ${missing.join(", ")}.`,
    fix: [
      "Set the missing Twilio env vars on Render for `stonegate-api` and `stonegate-outbox-worker`.",
      "Redeploy both services.",
      "Re-try the call/SMS action."
    ]
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const blockers: HealthFinding[] = [];
  const warnings: HealthFinding[] = [];

  const siteUrlBlocker = getPublicSiteUrlBlocker();
  if (siteUrlBlocker) blockers.push(siteUrlBlocker);

  const twilioBlocker = getTwilioBlocker();
  if (twilioBlocker) blockers.push(twilioBlocker);

  const db = getDb();
  const rows = await db
    .select({
      provider: providerHealth.provider,
      lastSuccessAt: providerHealth.lastSuccessAt,
      lastFailureAt: providerHealth.lastFailureAt,
      lastFailureDetail: providerHealth.lastFailureDetail
    })
    .from(providerHealth)
    .where(inArray(providerHealth.provider, [...PROVIDERS]));

  const rowMap = new Map(rows.map((row) => [row.provider, row]));
  const providers = PROVIDERS.map((provider) => {
    const row = rowMap.get(provider);
    return {
      provider,
      status: resolveStatus(row),
      lastSuccessAt: row?.lastSuccessAt ? row.lastSuccessAt.toISOString() : null,
      lastFailureAt: row?.lastFailureAt ? row.lastFailureAt.toISOString() : null,
      lastFailureDetail: row?.lastFailureDetail ?? null
    };
  });

  for (const provider of providers) {
    if (provider.status !== "degraded") continue;
    warnings.push({
      id: `provider_${provider.provider}`,
      severity: "warning",
      title: `${provider.provider} provider issue`,
      detail: provider.lastFailureDetail ?? "Provider is degraded.",
      fix: ["Open `/team?tab=inbox` or `/team?tab=marketing` to review provider health details."]
    });
  }

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    blockers,
    warnings,
    providers,
    config: {
      publicSiteUrl: resolvePublicSiteBaseUrl(),
      twilioConfigured: !getTwilioBlocker()
    }
  });
}


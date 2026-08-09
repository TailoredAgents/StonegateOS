import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { getDb, providerHealth } from "@/db";
import { requirePermission } from "@/lib/permissions";

const PROVIDERS = [
  "sms",
  "email",
  "calendar",
  "meta_ads",
  "google_ads",
  "square",
  "object_storage",
] as const;

type ProviderStatus = "healthy" | "degraded" | "unknown";

function resolveStatus(row?: {
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}): ProviderStatus {
  if (!row?.lastSuccessAt && !row?.lastFailureAt) {
    return "unknown";
  }
  if (row?.lastFailureAt && (!row.lastSuccessAt || row.lastFailureAt > row.lastSuccessAt)) {
    return "degraded";
  }
  return "healthy";
}

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

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

  return NextResponse.json({ providers });
}

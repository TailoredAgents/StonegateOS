import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb, googleAdsInsightsDaily, providerHealth } from "@/db";
import {
  GoogleAdsApiError,
  getGoogleAdsAccessToken,
  getGoogleAdsConfiguredIds,
  listGoogleAdsAccessibleCustomers,
} from "@/lib/google-ads-insights";
import {
  getTeamOperationKillSwitch,
  requirePermission,
} from "@/lib/permissions";

function isConfigured(): boolean {
  const developerToken = process.env["GOOGLE_ADS_DEVELOPER_TOKEN"] ?? "";
  const clientId = process.env["GOOGLE_ADS_CLIENT_ID"] ?? "";
  const clientSecret = process.env["GOOGLE_ADS_CLIENT_SECRET"] ?? "";
  const refreshToken = process.env["GOOGLE_ADS_REFRESH_TOKEN"] ?? "";
  const customerId = process.env["GOOGLE_ADS_CUSTOMER_ID"] ?? "";
  return Boolean(
    developerToken && clientId && clientSecret && refreshToken && customerId,
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requirePermission(request, "marketing.read");
  if (denied) return denied;

  const configured = isConfigured();
  let authOk: boolean | null = null;
  let authError: {
    status?: number;
    error?: string;
    description?: string;
  } | null = null;
  let accessibleCustomers: string[] | null = null;
  const ids = getGoogleAdsConfiguredIds();

  if (configured) {
    try {
      const token = (await Promise.race([
        getGoogleAdsAccessToken(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("google_ads_auth_timeout")), 8000),
        ),
      ])) as string;
      authOk = true;

      const url = new URL(request.url);
      const debug = url.searchParams.get("debug");
      if (debug === "1") {
        accessibleCustomers = await listGoogleAdsAccessibleCustomers({
          accessToken: token,
        });
      }
    } catch (error) {
      authOk = false;
      if (error instanceof GoogleAdsApiError) {
        authError = {
          status: error.status,
          error: error.failureCode,
        };
      } else {
        authError = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const db = getDb();
  const [healthRow, latestRow] = await Promise.all([
    db
      .select({
        lastSuccessAt: providerHealth.lastSuccessAt,
        lastFailureAt: providerHealth.lastFailureAt,
        lastFailureDetail: providerHealth.lastFailureDetail,
      })
      .from(providerHealth)
      .where(eq(providerHealth.provider, "google_ads"))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        fetchedAt: googleAdsInsightsDaily.fetchedAt,
        dateStart: googleAdsInsightsDaily.dateStart,
      })
      .from(googleAdsInsightsDaily)
      .orderBy(desc(googleAdsInsightsDaily.fetchedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  return NextResponse.json({
    ok: true,
    configured,
    advertisingChangesDisabled:
      getTeamOperationKillSwitch(["marketing.apply"]) === "advertising_changes",
    authOk,
    authError,
    customerId: ids.customerId,
    loginCustomerId: ids.loginCustomerId,
    apiVersion: ids.apiVersion,
    accessibleCustomers,
    lastSuccessAt: healthRow?.lastSuccessAt
      ? healthRow.lastSuccessAt.toISOString()
      : null,
    lastFailureAt: healthRow?.lastFailureAt
      ? healthRow.lastFailureAt.toISOString()
      : null,
    lastFailureDetail: healthRow?.lastFailureDetail ?? null,
    lastFetchedAt: latestRow?.fetchedAt
      ? latestRow.fetchedAt.toISOString()
      : null,
    lastFetchedDate: latestRow?.dateStart ?? null,
  });
}

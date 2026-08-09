import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const API_BASE_URL =
  process.env["API_BASE_URL"] ?? process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "";

function siteConfigurationReady(): boolean {
  return [
    API_BASE_URL,
    process.env["ADMIN_API_KEY"],
    process.env["ADMIN_SESSION_SECRET"],
    process.env["NEXT_PUBLIC_SITE_URL"],
  ].every((value) => Boolean(value?.trim()));
}

export async function GET(): Promise<Response> {
  const configurationReady = siteConfigurationReady();
  let apiReady = false;
  let apiStatus: number | null = null;
  if (API_BASE_URL.trim()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(
        `${API_BASE_URL.replace(/\/$/u, "")}/api/readyz`,
        {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        },
      );
      apiStatus = response.status;
      apiReady = response.ok;
    } catch {
      apiReady = false;
    } finally {
      clearTimeout(timeout);
    }
  }

  const ok = configurationReady && apiReady;
  return NextResponse.json(
    {
      ok,
      checkedAt: new Date().toISOString(),
      checks: {
        configuration: { state: configurationReady ? "ok" : "failed" },
        api: { state: apiReady ? "ok" : "failed", status: apiStatus },
      },
    },
    {
      status: ok ? 200 : 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

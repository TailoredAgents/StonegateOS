type Check = {
  name: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  expectStatus?: number;
};

function optEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

function reqEnv(name: string): string {
  const value = optEnv(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function resolveApiBaseUrl(): string {
  // Preferred explicit config for local/staging/prod parity.
  const explicit = optEnv("API_BASE_URL");
  if (explicit) return explicit;

  // Render automatically injects this into each service shell/runtime.
  const renderExternal = optEnv("RENDER_EXTERNAL_URL");
  if (renderExternal) return renderExternal;

  throw new Error("Missing API base URL. Set API_BASE_URL (recommended) or run inside Render where RENDER_EXTERNAL_URL is available.");
}

function resolveSiteUrl(): string | undefined {
  return (
    optEnv("NEXT_PUBLIC_SITE_URL") ??
    optEnv("SITE_URL") ??
    optEnv("RENDER_SITE_URL") ??
    undefined
  );
}

async function run(check: Check): Promise<{ ok: boolean; detail: string }> {
  const expectStatus = check.expectStatus ?? 200;
  const res = await fetch(check.url, {
    method: check.method ?? "GET",
    headers: check.headers
  }).catch((error) => {
    return { ok: false, status: 0, statusText: String(error) } as any;
  });

  if (!res || typeof (res as any).status !== "number") return { ok: false, detail: "request_failed" };
  const status = (res as Response).status;
  const ok = status === expectStatus;
  const body = ok ? "" : await (res as Response).text().catch(() => "");
  return { ok, detail: ok ? `${status}` : `${status} ${body.slice(0, 240)}` };
}

async function main() {
  const apiBaseUrl = resolveApiBaseUrl().replace(/\/$/, "");
  const siteUrl = resolveSiteUrl()?.replace(/\/$/, "");
  const adminApiKey = reqEnv("ADMIN_API_KEY");

  const checks: Check[] = [
    { name: "api.healthz", url: `${apiBaseUrl}/api/healthz` },
    { name: "api.db.status", url: `${apiBaseUrl}/api/admin/db/status`, headers: { "x-admin-api-key": adminApiKey } },
    { name: "api.providers.health", url: `${apiBaseUrl}/api/admin/providers/health`, headers: { "x-admin-api-key": adminApiKey } },
    { name: "api.google.ads.status", url: `${apiBaseUrl}/api/admin/google/ads/status`, headers: { "x-admin-api-key": adminApiKey }, expectStatus: 200 },
    { name: "api.seo.status", url: `${apiBaseUrl}/api/admin/seo/status`, headers: { "x-admin-api-key": adminApiKey }, expectStatus: 200 },
    { name: "api.inbox.failed-sends", url: `${apiBaseUrl}/api/admin/inbox/failed-sends?limit=1`, headers: { "x-admin-api-key": adminApiKey }, expectStatus: 200 }
  ];

  if (siteUrl) {
    checks.unshift({ name: "site.healthz", url: `${siteUrl}/api/healthz` });
  }

  const apiLabel = optEnv("API_BASE_URL") ? "API_BASE_URL" : optEnv("RENDER_EXTERNAL_URL") ? "RENDER_EXTERNAL_URL" : "API";
  console.log(`Smoke checks against ${apiLabel}=${apiBaseUrl}${siteUrl ? ` SITE_URL=${siteUrl}` : ""}`);

  let failed = 0;
  for (const check of checks) {
    const result = await run(check);
    const prefix = result.ok ? "OK " : "FAIL";
    console.log(`${prefix} ${check.name} -> ${result.detail}`);
    if (!result.ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`\nSmoke checks failed: ${failed}`);
    process.exitCode = 1;
  } else {
    console.log("\nSmoke checks passed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

type Check = {
  name: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  expectStatus?: number;
};

function reqEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optEnv(name: string): string | undefined {
  return process.env[name] || undefined;
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
  const apiBaseUrl = reqEnv("API_BASE_URL").replace(/\/$/, "");
  const siteUrl = optEnv("NEXT_PUBLIC_SITE_URL")?.replace(/\/$/, "") ?? optEnv("SITE_URL")?.replace(/\/$/, "");
  const adminApiKey = reqEnv("ADMIN_API_KEY");

  const checks: Check[] = [
    { name: "api.healthz", url: `${apiBaseUrl}/api/healthz` },
    { name: "api.db.status", url: `${apiBaseUrl}/api/admin/db/status`, headers: { "x-admin-api-key": adminApiKey } },
    { name: "api.providers.health", url: `${apiBaseUrl}/api/admin/providers/health`, headers: { "x-admin-api-key": adminApiKey } },
    { name: "api.google.ads.status", url: `${apiBaseUrl}/api/admin/google/ads/status`, headers: { "x-admin-api-key": adminApiKey }, expectStatus: 200 }
  ];

  if (siteUrl) {
    checks.unshift({ name: "site.healthz", url: `${siteUrl}/api/healthz` });
  }

  console.log(`Smoke checks against API_BASE_URL=${apiBaseUrl}${siteUrl ? ` SITE_URL=${siteUrl}` : ""}`);

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


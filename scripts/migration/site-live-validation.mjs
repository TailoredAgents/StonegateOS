// Read-only public checks. A rejected foreign-origin request has no session or
// booking/payment fields and must be refused before business processing.
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
const origin = "https://stonegatejunkremoval.com";
export async function verifyWebsite() {
  const checks = [];
  async function check(
    name,
    route,
    expected,
    init = {},
    predicate = () => true,
  ) {
    const start = performance.now();
    const r = await fetch(origin + route, {
      ...init,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    const bytes = (await r.arrayBuffer()).byteLength;
    const pass = r.status === expected && predicate(r, bytes);
    checks.push({
      name,
      status: r.status,
      bytes,
      ms: Math.round(performance.now() - start),
      pass,
    });
    if (!pass)
      throw Error("Live website check failed: " + name + " status=" + r.status);
  }
  for (const route of [
    "/",
    "/book",
    "/partners/login",
    "/team/login",
    "/mobile/login",
    "/api/healthz",
  ])
    await check(
      "cloudflare-page:" + route,
      route,
      200,
      {},
      (r, bytes) =>
        r.headers.get("x-stonegate-hosting") === "cloudflare" && bytes > 0,
    );
  await check("operator-control-private", "/__gateway/status", 401);
  await check(
    "team-auth-required",
    "/api/team/directory",
    401,
    {},
    (r) => r.headers.get("x-stonegate-hosting") === "cloudflare",
  );
  await check("foreign-origin-rejected", "/api/team/contacts", 403, {
    method: "POST",
    headers: {
      origin: "https://attacker.invalid",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "firstName=Unauthorized&lastName=MustNotWrite",
  });
  const www = await fetch(
    "https://www.stonegatejunkremoval.com/book?migration_read_only=1",
    {
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    },
  );
  await www.body?.cancel();
  const canonical =
    www.status === 301 &&
    www.headers.get("location") === origin + "/book?migration_read_only=1";
  checks.push({
    name: "canonical-redirect-path-and-query",
    status: www.status,
    pass: canonical,
  });
  if (!canonical) throw Error("Canonical redirect differs from source");
  return checks;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const directory = process.argv[2];
  if (!directory) throw Error("Private evidence directory required");
  let receipt;
  try {
    receipt = {
      at: new Date().toISOString(),
      ok: true,
      checks: await verifyWebsite(),
    };
  } catch (error) {
    receipt = { at: new Date().toISOString(), ok: false, error: error.message };
    process.exitCode = 1;
  }
  await writeFile(
    path.join(directory, "site-live-validation-" + Date.now() + ".json"),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(receipt));
}

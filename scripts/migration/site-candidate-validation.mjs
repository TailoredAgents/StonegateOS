import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const token = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const inventory = JSON.parse(
  await readFile(
    path.join(directory, "site-render-static-inventory.json"),
    "utf8",
  ),
);
const config = JSON.parse(
  await readFile(
    new URL(
      "../../infra/cloudflare/site-candidate/wrangler.jsonc",
      import.meta.url,
    ),
    "utf8",
  ),
);
const expectedImage = config.containers[0].images.base.image;
const base = "https://stonegate-site-candidate.jeffrey-78e.workers.dev";
const checks = [];
let cycle = 0;
function check(name, pass, extra = {}) {
  checks.push({ cycle, name, pass, ...extra });
  if (!pass) throw Error("Candidate check failed: " + name);
}
async function call(route, method = "GET", authorized = true) {
  const start = performance.now();
  const r = await fetch(base + route, {
    method,
    headers: authorized ? { authorization: `Bearer ${token}` } : {},
    redirect: "manual",
    signal: AbortSignal.timeout(150000),
  });
  return { r, ms: Math.round(performance.now() - start) };
}
try {
  for (cycle = 1; cycle <= 2; cycle++) {
    let { r } = await call("/", "GET", false);
    await r.body?.cancel();
    check("unauthenticated-rejected", r.status === 401);
    for (const [route, method] of [
      ["/book", "POST"],
      ["/api/team/directory", "GET"],
      ["/book?untrusted=1", "GET"],
    ]) {
      ({ r } = await call(route, method));
      await r.body?.cancel();
      check("blocked-route:" + method + ":" + route, r.status === 404);
    }
    ({ r } = await call("/__candidate/status"));
    let status = await r.json();
    check("starts-stopped", r.ok && status.running === false);
    const start = await call("/__candidate/start", "POST");
    status = await start.r.json();
    check(
      "real-entrypoint-ready",
      start.r.ok &&
        status.ready === true &&
        status.image?.image === expectedImage,
      { ms: start.ms },
    );
    const label = status.image.labels.started;
    // Independent public reads exercise concurrent proxy requests to one instance.
    const routes = [
      "/",
      "/book",
      "/partners/login",
      "/team/login",
      "/mobile/login",
      "/api/healthz",
    ];
    const responses = await Promise.all(
      routes.map(async (route) => {
        const { r, ms } = await call(route);
        const body = await r.text();
        return {
          route,
          status: r.status,
          bytes: Buffer.byteLength(body),
          ms,
          cache: r.headers.get("cache-control"),
          robots: r.headers.get("x-robots-tag"),
          type: r.headers.get("content-type"),
        };
      }),
    );
    for (const result of responses)
      check(
        "page:" + result.route,
        result.status === 200 &&
          result.bytes > 0 &&
          result.cache === "no-store" &&
          result.robots === "noindex, nofollow",
        result,
      );
    let verified = 0;
    for (let offset = 0; offset < inventory.length; offset += 4) {
      await Promise.all(
        inventory.slice(offset, offset + 4).map(async (asset) => {
          const { r } = await call("/_next/static/" + asset.key);
          const bytes = Buffer.from(await r.arrayBuffer());
          if (
            r.status !== 200 ||
            bytes.length !== asset.bytes ||
            createHash("sha256").update(bytes).digest("hex") !== asset.sha256
          )
            throw Error("Legacy asset mismatch");
          verified++;
        }),
      );
    }
    check("all-legacy-assets-identical", verified === 115, { verified });
    ({ r } = await call("/__candidate/status"));
    status = await r.json();
    check(
      "same-instance-healthy",
      r.ok &&
        status.healthy === true &&
        status.image?.image === expectedImage &&
        status.image?.labels.started === label,
    );
    ({ r } = await call("/__candidate/stop", "POST"));
    status = await r.json();
    check("stop-completes", r.ok && status.stopped === true);
    ({ r } = await call("/__candidate/status"));
    status = await r.json();
    check(
      "stopped-and-lease-cleared",
      r.ok && status.running === false && !status.lease,
    );
  }
} catch (error) {
  checks.push({
    cycle,
    name: "validation-error",
    pass: false,
    error: error.message,
  });
  process.exitCode = 1;
} finally {
  try {
    const { r } = await call("/__candidate/stop", "POST");
    await r.body?.cancel();
    if (!r.ok) throw Error("Cleanup failed");
  } catch (error) {
    checks.push({ name: "cleanup", pass: false, error: error.message });
    process.exitCode = 1;
  }
  await writeFile(
    path.join(directory, `site-candidate-validation-${Date.now()}.json`),
    JSON.stringify({ at: new Date().toISOString(), expectedImage, checks }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      checks: checks.length,
      failures: checks.filter((x) => !x.pass),
      starts: checks
        .filter((x) => x.name === "real-entrypoint-ready")
        .map((x) => x.ms),
    }),
  );
}

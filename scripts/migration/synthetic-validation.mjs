import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
const source = await readFile(
  new URL("../../infra/cloudflare/synthetic/check.ts", import.meta.url),
  "utf8",
);
const expectedProbeHash = createHash("sha256")
  .update(
    runInNewContext(
      source.slice(source.indexOf("String.raw`"), source.lastIndexOf(";")),
      {},
      { timeout: 1000 },
    ),
  )
  .digest("hex");
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const mode = process.argv[3] ?? "api";
if (
  !["api", "outbox", "booking", "delivery", "site", "webhooks"].includes(mode)
)
  throw Error("Select api, outbox, booking, delivery, site or webhooks");
const service =
  mode === "booking" || mode === "site" || mode === "webhooks"
    ? "api"
    : mode === "delivery"
      ? "outbox"
      : mode;
const route =
  mode === "webhooks"
    ? "/api/webhook-check"
    : mode === "site"
      ? "/api/site-check"
      : mode === "booking"
        ? "/api/booking-check"
        : mode === "delivery"
          ? "/outbox/delivery-check"
          : `/${service}/check`;
const token = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const origin = "https://stonegate-synthetic-validation.jeffrey-78e.workers.dev";
const checks = [];
const unauthorized = await fetch(origin + route, { method: "POST" });
checks.push({
  name: "reject-unauthenticated",
  pass: unauthorized.status === 401,
});
await unauthorized.body?.cancel();
try {
  for (let cycle = 0; cycle < 2; cycle++) {
    if (mode === "delivery") {
      try {
        const prep = await fetch(origin + "/api/booking-check", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(210000),
        });
        const result = await prep.json();
        const probeMatches =
          prep.headers.get("x-stonegate-probe-sha256") === expectedProbeHash;
        checks.push({
          name: "prepare-synthetic-booking",
          cycle,
          status: prep.status,
          ...result,
          probeMatches,
          pass: prep.ok && result.ok === true && probeMatches,
        });
        console.log(
          JSON.stringify({
            phase: "prepare-synthetic-booking",
            cycle,
            status: prep.status,
            ...result,
          }),
        );
        if (!prep.ok || !result.ok || !probeMatches)
          throw Error("Synthetic booking preparation failed or stale probe");
      } finally {
        const stop = await fetch(origin + "/api/stop", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
        });
        await stop.body?.cancel();
        if (!stop.ok) throw Error("Preparation cleanup failed");
      }
    }
    const start = performance.now();
    const response = await fetch(origin + route, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(210000),
    });
    const result = {
      service,
      mode,
      cycle,
      status: response.status,
      ms: Math.round(performance.now() - start),
      probeHash: response.headers.get("x-stonegate-probe-sha256"),
      ...(await response.json()),
    };
    checks.push({
      ...result,
      pass:
        response.ok &&
        result.ok === true &&
        result.probeHash === expectedProbeHash,
    });
    console.log(JSON.stringify(result));
    const stop = await fetch(origin + `/${service}/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    await stop.body?.cancel();
    if (!stop.ok) throw Error("Synthetic container stop failed");
    if (!response.ok) break;
  }
} finally {
  if (mode === "site") {
    const stopSite = await fetch(origin + "/site/stop", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    await stopSite.body?.cancel();
    if (!stopSite.ok)
      checks.push({
        name: "site-cleanup",
        pass: false,
        status: stopSite.status,
      });
  }
  const stop = await fetch(origin + `/${service}/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  await stop.body?.cancel();
  if (!stop.ok)
    checks.push({ name: "cleanup", pass: false, status: stop.status });
  await writeFile(
    path.join(directory, `synthetic-validation-${mode}-${Date.now()}.json`),
    JSON.stringify({ at: new Date().toISOString(), checks }),
    { mode: 0o600, flag: "wx" },
  );
}
console.log(
  JSON.stringify({
    checks: checks.length,
    failures: checks.filter((x) => !x.pass).length,
  }),
);
if (checks.some((x) => !x.pass)) process.exitCode = 1;

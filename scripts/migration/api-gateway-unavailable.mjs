// Run only after configuring the isolated gateway with a deliberately invalid
// probe password. Restore its valid secret afterward; no database role changes.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const token = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const base = "https://stonegate-api-gateway-validation.jeffrey-78e.workers.dev";
const checks = [];
const check = (name, pass) => {
  checks.push({ name, pass });
  if (!pass) throw Error("Readiness gate failed: " + name);
};
async function request(route, method = "POST", extra = {}) {
  const r = await fetch(base + route, {
    method,
    headers: { "x-migration-gateway-key": token, ...extra },
    signal: AbortSignal.timeout(160000),
  });
  return { status: r.status, body: await r.json() };
}
try {
  const before = await request("/__gateway/status", "GET");
  check(
    "starts-stopped",
    before.body.phase === "standby" && !before.body.running,
  );
  const warm = await request("/__gateway/warm");
  check(
    "invalid-database-cannot-pass-warm-readiness",
    warm.status === 503 && warm.body.error === "readiness_timeout",
  );
  const state = await request("/__gateway/status", "GET");
  check("unready-candidate-remains-failed", state.body.phase === "failed");
  const activate = await request("/__gateway/activate", "POST", {
    "x-stonegate-gateway-generation": state.body.generation,
  });
  check("even-current-generation-cannot-activate", activate.status === 409);
  const traffic = await request("/api/healthz", "GET");
  check("no-application-traffic-admitted", traffic.status === 503);
} catch {
  process.exitCode = 1;
} finally {
  const stop = await request("/__gateway/drain").catch(() => null);
  checks.push({
    name: "unready-container-stopped",
    pass: stop?.body.running === false && stop?.body.phase === "standby",
  });
  const receipt = {
    at: new Date().toISOString(),
    checks,
    failures: checks.filter((x) => !x.pass).length,
    productionTouched: false,
  };
  await writeFile(
    path.join(directory, `api-gateway-unavailable-${Date.now()}.json`),
    JSON.stringify(receipt),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(receipt));
  if (receipt.failures) process.exitCode = 1;
}

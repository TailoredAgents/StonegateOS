import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const token = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const config = JSON.parse(
  await readFile(
    new URL(
      "../../infra/cloudflare/http-gateway/wrangler.jsonc",
      import.meta.url,
    ),
    "utf8",
  ),
);
if (
  config.vars.SERVICE_KIND !== "fixture" ||
  config.vars.AUTO_RECOVER !== "true"
)
  throw Error("Recovery trial requires network-isolated fixture");
const base = "https://" + config.vars.GATEWAY_HOST;
const checks = [];
function check(name, pass, extra = {}) {
  checks.push({ name, pass, ...extra });
  if (!pass) throw Error("Recovery failed: " + name);
}
async function call(route, options = {}) {
  return fetch(base + route, {
    ...options,
    headers: { "x-migration-gateway-key": token, ...options.headers },
    signal: AbortSignal.timeout(150000),
  });
}
async function control(action, generation) {
  const r = await call("/__gateway/" + action, {
    method: action === "status" ? "GET" : "POST",
    headers: generation ? { "x-stonegate-gateway-generation": generation } : {},
  });
  return { status: r.status, body: await r.json() };
}
try {
  const before = await control("status");
  check(
    "starts-stopped",
    before.body.phase === "standby" && !before.body.running,
  );
  const ready = await control("warm");
  check("fixture-ready", ready.status === 200 && ready.body.phase === "ready");
  const active = await control("activate", ready.body.generation);
  check(
    "activated-before-fault",
    active.status === 200 && active.body.desiredActive === true,
  );
  const crash = await call("/crash", {
    method: "POST",
    body: "one deliberately interrupted request",
  });
  await crash.body?.cancel();
  check("lost-request-returned-without-retry", crash.status === 502);
  const start = performance.now();
  let state;
  for (let i = 0; i < 40; i++) {
    state = await control("status");
    if (
      state.body.phase === "active" &&
      state.body.running &&
      state.body.generation !== ready.body.generation
    )
      break;
    await wait(3000);
  }
  check(
    "scheduled-alarm-recovers-new-healthy-instance",
    state.body.phase === "active" &&
      state.body.running &&
      state.body.generation !== ready.body.generation,
    { ms: Math.round(performance.now() - start) },
  );
  check(
    "one-bounded-restart-recorded",
    state.body.restarts?.length === 1 && state.body.desiredActive === true,
  );
  const health = await call("/api/healthz");
  check(
    "future-requests-reach-recovered-instance",
    health.status === 200 && (await health.text()) === "ok",
  );
  const drain = await control("drain");
  check(
    "drain-disarms-recovery",
    drain.status === 200 &&
      !drain.body.running &&
      drain.body.phase === "standby",
  );
  // Longer than the health interval proves a deliberate stop is not restarted.
  await wait(65000);
  state = await control("status");
  check(
    "deliberately-stopped-instance-stays-stopped",
    state.body.phase === "standby" &&
      !state.body.running &&
      !state.body.desiredActive,
  );
} catch (error) {
  checks.push({
    name: "recovery-trial-failed",
    pass: false,
    error: error.message,
  });
  process.exitCode = 1;
} finally {
  const stopped = await control("drain").catch(() => null);
  checks.push({ name: "final-cleanup", pass: stopped?.body.running === false });
  const receipt = {
    at: new Date().toISOString(),
    checks,
    ok: checks.every((c) => c.pass),
    syntheticOnly: true,
  };
  await writeFile(
    path.join(directory, "gateway-recovery-validation-" + Date.now() + ".json"),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(receipt));
  if (!receipt.ok) process.exitCode = 1;
}

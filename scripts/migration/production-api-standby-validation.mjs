// Full source settings and application role, with unconditional gateway traffic
// denial and disabled activation. Only startup/readiness/catalog reads run.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const secrets = JSON.parse(
  await readFile(
    path.join(directory, "production-api-standby-secrets.json"),
    "utf8",
  ),
);
const envelope = JSON.parse(secrets.SOURCE_API_RUNTIME_CONFIG);
const generalToken = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
if (secrets.MIGRATION_PROBE_TOKEN === generalToken)
  throw Error("Standby requires a separate operator credential");
const config = JSON.parse(
  await readFile(
    new URL(
      "../../infra/cloudflare/http-gateway/wrangler.production-api.jsonc",
      import.meta.url,
    ),
    "utf8",
  ),
);
if (
  config.vars.SERVICE_KIND !== "source-api-standby" ||
  config.routes ||
  config.vars.OPERATION_MODE === "production"
)
  throw Error("Standby must not admit public traffic");
const source = await readFile(
  new URL(
    "../../infra/cloudflare/http-gateway/production-api-runtime.ts",
    import.meta.url,
  ),
  "utf8",
);
const runtime = runInNewContext(
  source.slice(source.indexOf("String.raw`"), source.lastIndexOf(";")),
  {},
  { timeout: 1000 },
);
const expectedRuntimeHash = createHash("sha256").update(runtime).digest("hex");
const origin = "https://" + config.vars.GATEWAY_HOST;
const checks = [];
let cycle = 0;
const check = (name, pass, extra = {}) => {
  checks.push({ cycle, name, pass, ...extra });
  if (!pass) throw Error("CHECK_FAILED:" + name);
};
async function call(route, init = {}, token = secrets.MIGRATION_PROBE_TOKEN) {
  const headers = new Headers(init.headers);
  if (token) headers.set("x-migration-gateway-key", token);
  const response = await fetch(origin + route, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(150000),
  });
  return { status: response.status, body: await response.json() };
}
async function control(action, generation) {
  return call("/__gateway/" + action, {
    method: ["status", "runtime-status"].includes(action) ? "GET" : "POST",
    headers: generation ? { "x-stonegate-gateway-generation": generation } : {},
  });
}
try {
  for (cycle = 1; cycle <= 2; cycle++) {
    check(
      "anonymous-control-denied",
      (await call("/__gateway/status", {}, null)).status === 401,
    );
    check(
      "general-rehearsal-credential-denied",
      (await call("/__gateway/status", {}, generalToken)).status === 401,
    );
    let state = await control("status");
    check(
      "standby-starts-stopped",
      state.body.phase === "standby" && !state.body.running,
    );
    let blocked = await call("/api/healthz");
    check(
      "app-traffic-denied-before-warm",
      blocked.status === 503 &&
        blocked.body.error === "standby_traffic_disabled",
    );
    const start = performance.now();
    state = await control("warm");
    check(
      "actual-production-settings-reach-full-api-readiness",
      state.status === 200 &&
        state.body.phase === "ready" &&
        state.body.image?.image === config.containers[0].images.base.image,
      {
        ms: Math.round(performance.now() - start),
        ...(state.status !== 200 ? { diagnostic: state.body } : {}),
      },
    );
    console.log(
      JSON.stringify({
        cycle,
        event: "standby-ready",
        ms: Math.round(performance.now() - start),
      }),
    );
    const generation = state.body.generation;
    state = await control("status");
    const readiness = state.body.readiness;
    check(
      "database-journal-configuration-and-existing-outbox-ready",
      readiness?.apiStatus === 200 &&
        readiness.apiChecks?.database === "ok" &&
        readiness.apiChecks?.migrations === "ok" &&
        readiness.apiChecks?.configuration === "ok" &&
        readiness.apiChecks?.outboxWorker === "ok" &&
        Object.values(readiness.apiChecks).every((value) =>
          ["ok", "skipped"].includes(value),
        ),
    );
    const runtimeState = await control("runtime-status");
    check(
      "exact-supervisor-and-source-settings-fingerprint",
      runtimeState.status === 200 &&
        runtimeState.body.runtimeSha256 === expectedRuntimeHash &&
        runtimeState.body.environmentSha256 === envelope.environmentSha256,
    );
    check(
      "actual-application-role-and-verified-source-scope",
      runtimeState.body.scopeVerified === true &&
        runtimeState.body.effectiveRole === "stonegate" &&
        runtimeState.body.loginRole === "stonegate_rot_20260921" &&
        runtimeState.body.existingOwnerCreatePermissions === true &&
        runtimeState.body.readOnly === false &&
        runtimeState.body.credentialExpiresAt === envelope.connection.expiresAt,
    );
    check(
      "api-and-relay-running-without-restart",
      runtimeState.body.apiRunning &&
        runtimeState.body.relayRunning &&
        runtimeState.body.relayRestarts === 0 &&
        !runtimeState.body.stopping,
    );
    blocked = await control("activate", generation);
    check(
      "even-correct-generation-cannot-promote-standby",
      blocked.status === 409 &&
        blocked.body.error === "standby_promotion_disabled",
    );
    blocked = await call("/api/admin/contacts", {
      method: "POST",
      body: "{}",
      headers: {
        "content-type": "application/json",
        "x-api-key": "deliberately-invalid-application-key",
      },
    });
    check(
      "mutation-never-reaches-application",
      blocked.status === 503 &&
        blocked.body.error === "standby_traffic_disabled",
    );
    blocked = await call("/api/readyz");
    check(
      "read-traffic-remains-denied-after-warm",
      blocked.status === 503 &&
        blocked.body.error === "standby_traffic_disabled",
    );
    check(
      "production-relay-fault-injection-unavailable",
      (await control("interrupt-relay")).status === 404,
    );
    state = await control("status");
    check(
      "no-admission-or-automatic-restart-armed",
      state.body.phase === "ready" &&
        state.body.inFlight === 0 &&
        state.body.desiredActive === false,
    );
    state = await control("drain");
    check(
      "standby-api-and-relay-stop-cleanly",
      state.status === 200 &&
        state.body.phase === "standby" &&
        !state.body.running &&
        state.body.drained === true,
    );
  }
} catch {
  if (!checks.some((check) => !check.pass))
    checks.push({ cycle, name: "validation-request-failed", pass: false });
  process.exitCode = 1;
} finally {
  try {
    const state = await control("drain");
    check(
      "final-container-stopped",
      state.status === 200 &&
        state.body.phase === "standby" &&
        !state.body.running,
    );
  } catch {
    checks.push({ cycle, name: "cleanup-failed", pass: false });
  }
  const receipt = {
    at: new Date().toISOString(),
    sourceRevision: envelope.sourceRevision,
    image: config.containers[0].images.base.image,
    environmentSha256: envelope.environmentSha256,
    runtimeSha256: expectedRuntimeHash,
    checks,
    failures: checks.filter((check) => !check.pass).length,
    productionSettingsConfigured: true,
    applicationRoleVerified: checks.some(
      (check) =>
        check.name === "actual-application-role-and-verified-source-scope" &&
        check.pass,
    ),
    applicationTrafficAdmitted: false,
    outboxConsumerStarted: false,
    providerSendInvoked: false,
    sourceSettingsChanged: false,
  };
  await writeFile(
    path.join(
      directory,
      "production-api-standby-validation-" + Date.now() + ".json",
    ),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.failures) process.exitCode = 1;
}

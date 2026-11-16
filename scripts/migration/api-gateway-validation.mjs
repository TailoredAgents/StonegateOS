import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const sourceRuntime = process.argv[3] === "source";
if (process.argv[3] && !sourceRuntime) throw Error("Unknown API gateway trial");
let expectedRuntimeHash;
if (sourceRuntime) {
  const source = await readFile(
    new URL(
      "../../infra/cloudflare/http-gateway/source-api-runtime.ts",
      import.meta.url,
    ),
    "utf8",
  );
  expectedRuntimeHash = createHash("sha256")
    .update(
      runInNewContext(
        source.slice(source.indexOf("String.raw`"), source.lastIndexOf(";")),
        {},
        { timeout: 1000 },
      ),
    )
    .digest("hex");
}
const token = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const config = JSON.parse(
  await readFile(
    new URL(
      sourceRuntime
        ? "../../infra/cloudflare/http-gateway/wrangler.source-api.jsonc"
        : "../../infra/cloudflare/http-gateway/wrangler.api.jsonc",
      import.meta.url,
    ),
    "utf8",
  ),
);
const base = "https://" + config.vars.GATEWAY_HOST;
const checks = [];
let cycle = 0;
const check = (name, pass, extra = {}) => {
  checks.push({ cycle, name, pass, ...extra });
  if (!pass) throw Error("CHECK_FAILED:" + name);
};
async function request(route, init = {}, authenticated = true) {
  const headers = new Headers(init.headers);
  if (authenticated) headers.set("x-migration-gateway-key", token);
  return fetch(base + route, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(150000),
  });
}
async function control(action, generation) {
  const r = await request("/__gateway/" + action, {
    method: ["status", "runtime-status"].includes(action) ? "GET" : "POST",
    headers: generation ? { "x-stonegate-gateway-generation": generation } : {},
  });
  return { status: r.status, body: await r.json() };
}
try {
  for (cycle = 1; cycle <= 2; cycle++) {
    let r = await request("/api/healthz", {}, false);
    await r.body?.cancel();
    check("anonymous-gateway-request-rejected", r.status === 401);
    let state = await control("status");
    check(
      "starts-stopped",
      state.body.phase === "standby" && !state.body.running,
    );
    r = await request("/api/healthz");
    await r.body?.cancel();
    check("standby-blocks-app-traffic", r.status === 503);
    const start = performance.now();
    state = await control("warm");
    check(
      "actual-api-warms-with-pinned-image",
      state.status === 200 &&
        state.body.phase === "ready" &&
        state.body.image?.image === config.containers[0].images.base.image,
      { ms: Math.round(performance.now() - start) },
    );
    const generation = state.body.generation;
    r = await request("/api/healthz");
    await r.body?.cancel();
    check("warming-does-not-activate-traffic", r.status === 503);
    state = await control("activate", "stale-generation");
    check("stale-activation-rejected", state.status === 409);
    state = await control("activate", generation);
    check(
      "explicit-ready-generation-activated",
      state.status === 200 && state.body.phase === "active",
    );
    r = await request("/api/healthz");
    check(
      "actual-api-health-through-gateway",
      r.status === 200 && (await r.text()) === "ok",
    );
    r = await request("/api/readyz");
    const ready = await r.json();
    check(
      "actual-database-and-journal-through-gateway",
      ready.checks?.database?.state === "ok" &&
        ready.checks?.migrations?.state === "ok",
    );
    if (sourceRuntime) {
      const before = await control("runtime-status");
      check(
        "source-runtime-verifies-read-only-tls-and-children",
        before.status === 200 &&
          before.body.runtimeSha256 === expectedRuntimeHash &&
          before.body.scopeVerified &&
          before.body.relayRunning &&
          before.body.apiRunning &&
          before.body.relayRestarts === 0,
      );
      const interrupted = await control("interrupt-relay");
      check(
        "isolated-relay-interruption-requested",
        interrupted.status === 200 &&
          interrupted.body.interruptionRequested &&
          interrupted.body.generation === before.body.generation,
      );
      let after;
      let recovered = false;
      const recoveryStarted = performance.now();
      for (let attempt = 0; attempt < 150; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        after = await control("runtime-status");
        if (after.body.relayRestarts !== 1 || !after.body.relayRunning)
          continue;
        const current = await request("/api/readyz");
        const body = await current.json();
        if (
          body.checks?.database?.state === "ok" &&
          body.checks?.migrations?.state === "ok"
        ) {
          recovered = true;
          break;
        }
      }
      check(
        "same-api-process-recovers-after-relay-restart",
        recovered &&
          after.body.generation === before.body.generation &&
          after.body.apiRunning &&
          !after.body.stopping,
        { ms: Math.round(performance.now() - recoveryStarted) },
      );
      const read = await request(
        "/api/admin/schedule/summary?range=this_week",
        {
          headers: {
            "x-api-key": "isolated-source-runtime-synthetic-key-only",
            "x-actor-type": "worker",
            "x-actor-label": "sales-draft-prep",
          },
        },
      );
      const summary = await read.json();
      check(
        "authenticated-source-business-read-after-recovery",
        read.status === 200 && summary.ok === true,
      );
    }
    r = await request("/api/admin/contacts");
    await r.body?.cancel();
    check("application-auth-still-required", r.status === 401);
    r = await request("/api/admin/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Unauthorized synthetic",
        lastName: "Must not write",
      }),
    });
    await r.body?.cancel();
    check("unauthenticated-mutation-rejected", r.status === 401);
    r = await request("/api/healthz", { method: "POST", body: "synthetic" });
    await r.body?.cancel();
    check("application-method-rejection-preserved", r.status === 405);
    state = await control("drain");
    check(
      "actual-api-drains-and-stops",
      state.status === 200 &&
        state.body.drained === true &&
        state.body.running === false,
    );
    r = await request("/api/healthz");
    await r.body?.cancel();
    check("drained-gateway-blocks-new-traffic", r.status === 503);
  }
} catch (e) {
  checks.push({
    cycle,
    name: e.message?.startsWith("CHECK_FAILED:")
      ? e.message.slice(13)
      : "validation-request-failed",
    pass: false,
  });
  process.exitCode = 1;
} finally {
  const state = await control("drain").catch(() => null);
  checks.push({
    cycle,
    name: "final-cleanup",
    pass: state?.body.running === false && state?.body.phase === "standby",
  });
  const receipt = {
    at: new Date().toISOString(),
    image: config.containers[0].images.base.image,
    checks,
    failures: checks.filter((x) => !x.pass).length,
    readOnlyTarget: !sourceRuntime,
    readOnlySource: sourceRuntime,
    productionWrites: false,
  };
  await writeFile(
    path.join(
      directory,
      `${sourceRuntime ? "source-" : ""}api-gateway-validation-${Date.now()}.json`,
    ),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(receipt));
  if (receipt.failures) process.exitCode = 1;
}

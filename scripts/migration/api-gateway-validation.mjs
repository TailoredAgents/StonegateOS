import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const token = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const config = JSON.parse(
  await readFile(
    new URL(
      "../../infra/cloudflare/http-gateway/wrangler.api.jsonc",
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
    method: action === "status" ? "GET" : "POST",
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
    readOnlyTarget: true,
    productionTouched: false,
  };
  await writeFile(
    path.join(directory, `api-gateway-validation-${Date.now()}.json`),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(receipt));
  if (receipt.failures) process.exitCode = 1;
}

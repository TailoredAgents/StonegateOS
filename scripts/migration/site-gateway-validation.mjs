import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const token = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const config = JSON.parse(
  await readFile(
    new URL(
      "../../infra/cloudflare/http-gateway/wrangler.site.jsonc",
      import.meta.url,
    ),
    "utf8",
  ),
);
const base = "https://" + config.vars.GATEWAY_HOST;
const file = (await readdir(directory))
  .filter((name) => /^site-static-preservation-\d+\.json$/.test(name))
  .sort()
  .at(-1);
if (!file) throw Error("Preserve all static files before gateway trial");
const preservation = JSON.parse(
  await readFile(path.join(directory, file), "utf8"),
);
if (!preservation.ok) throw Error("Static preservation did not pass");
const assets = preservation.verified;
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
      "actual-site-and-render-api-ready",
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
      {
        status: state.status,
        ...(state.status !== 200 ? { readiness: state.body.readiness } : {}),
      },
    );
    for (const route of [
      "/",
      "/book",
      "/partners/login",
      "/team/login",
      "/mobile/login",
      "/api/healthz",
    ]) {
      r = await request(route);
      const bytes = (await r.arrayBuffer()).byteLength;
      check("site-page:" + route, r.status === 200 && bytes > 0, { bytes });
    }
    r = await request("/api/team/directory");
    await r.body?.cancel();
    check("real-site-anonymous-team-auth-rejected", r.status === 401);
    r = await request("/api/team/contacts", {
      method: "POST",
      headers: {
        origin: "https://attacker.invalid",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "firstName=Unauthorized&lastName=MustNotWrite",
    });
    await r.body?.cancel();
    check("real-site-cross-origin-write-rejected", r.status === 403);
    r = await request("/", {
      headers: { "x-migration-preview-host": "attacker.invalid" },
    });
    await r.body?.cancel();
    check("arbitrary-preview-origin-rejected", r.status === 421);
    let files = 0;
    for (let offset = 0; offset < assets.length; offset += 4) {
      await Promise.all(
        assets.slice(offset, offset + 4).map(async (asset) => {
          const r = await request("/_next/static/" + asset.key);
          const bytes = Buffer.from(await r.arrayBuffer());
          if (
            !r.ok ||
            bytes.length !== asset.bytes ||
            createHash("sha256").update(bytes).digest("hex") !== asset.sha256
          )
            throw Error("Static asset mismatch");
          files++;
        }),
      );
    }
    check("gateway-serves-exact-old-and-new-assets", files === assets.length, {
      files,
    });
    state = await control("drain");
    check(
      "actual-site-drains-and-stops",
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
    productionReadsOnly: true,
    productionRoutesChanged: false,
  };
  await writeFile(
    path.join(directory, `site-gateway-validation-${Date.now()}.json`),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(receipt));
  if (receipt.failures) process.exitCode = 1;
}

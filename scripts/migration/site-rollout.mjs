// Explicit, receipt-gated website routing only. This never changes database
// credentials, provider configuration, background consumers or DNS records.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { verifyWebsite } from "./site-live-validation.mjs";
const [directory, action] = process.argv.slice(2);
if (
  !directory ||
  !["plan", "static", "site", "rollback", "status"].includes(action)
)
  throw Error(
    "Usage: site-rollout.mjs PRIVATE_DIRECTORY plan|static|site|rollback|status",
  );
const zone = "7eb7c6c85a93c7b0cae01de78028a40f";
const service = "srv-d43o7c0dl3ps73a4rb2g";
const workspace = "tea-cvl1h0odl3ps738ecuf0";
const revision = "5a90cf86608c76cd85773dbd2362b7fa07d5019c";
const host = "stonegatejunkremoval.com";
const definitions = [
  "stonegatejunkremoval.com",
  "www.stonegatejunkremoval.com",
].flatMap((host) => [
  {
    pattern: "https://" + host + "/_next/static/*",
    script: "stonegate-site-rollback-validation",
    kind: "static",
  },
  {
    pattern: "https://" + host + "/*",
    script: "stonegate-site-production",
    kind: "site",
  },
]);
const oauthFile = await readFile(
  path.join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
  "utf8",
);
const oauthMatch = oauthFile.match(/^oauth_token\s*=\s*(".*")\s*$/m);
if (!oauthMatch) throw Error("Wrangler OAuth unavailable");
const cloudflareToken = JSON.parse(oauthMatch[1]);
async function cf(suffix, method = "GET", body) {
  const r = await fetch(
    "https://api.cloudflare.com/client/v4/zones/" + zone + suffix,
    {
      method,
      headers: {
        authorization: "Bearer " + cloudflareToken,
        "content-type": "application/json",
        "cache-control": "no-cache",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    },
  );
  const result = await r.json();
  if (!r.ok || !result.success) {
    const error = Error("Cloudflare request failed: " + r.status);
    error.status = r.status;
    throw error;
  }
  return result.result;
}
async function latest(prefix, predicate) {
  const files = (await readdir(directory))
    .filter((x) => x.startsWith(prefix) && /\d+\.json$/.test(x))
    .sort();
  const file = files.at(-1);
  if (!file) throw Error("Required evidence missing: " + prefix);
  const data = JSON.parse(await readFile(path.join(directory, file), "utf8"));
  if (!predicate(data) || Date.now() - Date.parse(data.at) > 3 * 60 * 60 * 1000)
    throw Error("Failed or stale evidence: " + prefix);
  return { file, data };
}
async function privateJson(name, value) {
  await writeFile(path.join(directory, name), JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
}
const initial = await cf("/workers/routes");
for (const expected of definitions) {
  const existing = initial.find((r) => r.pattern === expected.pattern);
  if (existing && existing.script !== expected.script)
    throw Error("Conflicting existing route");
}
if (action === "status") {
  console.log(
    JSON.stringify({
      routes: initial.map((r) => ({
        id: r.id,
        pattern: r.pattern,
        script: r.script,
      })),
    }),
  );
  process.exit(0);
}
if (action === "rollback") {
  const removed = [];
  for (const route of initial.filter((r) =>
    definitions.some(
      (d) =>
        d.kind === "site" && d.pattern === r.pattern && d.script === r.script,
    ),
  )) {
    await cf("/workers/routes/" + route.id, "DELETE");
    removed.push(route.id);
  }
  const receipt = {
    at: new Date().toISOString(),
    action,
    removed,
    staticFilesRetained: true,
    renderAutodeployStillFrozen: true,
  };
  await privateJson("site-rollout-rollback-" + Date.now() + ".json", receipt);
  console.log(JSON.stringify(receipt));
  process.exit(0);
}
const evidence = await Promise.all([
  latest("site-production-preflight-", (d) => d.ok === true),
  latest("site-static-preservation-", (d) => d.ok === true),
  latest("site-rollback-validation-", (d) => d.ok === true),
  latest("site-gateway-validation-", (d) => d.failures === 0),
  latest("gateway-recovery-validation-", (d) => d.ok === true),
  latest("http-gateway-validation-", (d) => d.ok === true),
  latest(
    "site-route-canary-",
    (d) => d.ok === true && d.host === host && d.cleaned === true,
  ),
]);
const sourceConfig = await readFile(
  path.join(homedir(), ".render/cli.yaml"),
  "utf8",
);
const keyMatch = sourceConfig.match(/^\s+key:\s*(.+)$/m);
if (!keyMatch) throw Error("Render credential unavailable");
const encoded = keyMatch[1].trim();
const renderToken = encoded.startsWith('"')
  ? JSON.parse(encoded)
  : encoded.replace(/^'|'$/g, "");
async function render(suffix = "", method = "GET", body) {
  const r = await fetch(
    "https://api.render.com/v1/services/" + service + suffix,
    {
      method,
      headers: {
        authorization: "Bearer " + renderToken,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!r.ok) throw Error("Render service request failed: " + r.status);
  return r.json();
}
const source = await render();
const deploys = await render("/deploys?limit=5");
const deployment = deploys[0]?.deploy ?? deploys[0];
if (
  source.id !== service ||
  source.ownerId !== workspace ||
  source.branch !== "main" ||
  source.name !== "stonegate-site" ||
  source.suspended !== "not_suspended" ||
  deployment.status !== "live" ||
  deployment.commit?.id !== revision
)
  throw Error("Source website drifted; stop and reconcile");
let records;
let dnsEvidence = "live-cloudflare-api";
try {
  records = await cf("/dns_records?per_page=100");
} catch (error) {
  if (error.status !== 403) throw error;
  // Wrangler's OAuth does not include DNS read. A fresh authenticated
  // dashboard API export is acceptable; an old migration baseline is not.
  const dashboard = await latest(
    "site-dns-dashboard-",
    (d) =>
      d.source === "cloudflare-authenticated-dashboard" &&
      d.zone === zone &&
      d.status === 200 &&
      d.success === true &&
      d.records?.length === d.total &&
      Date.now() - Date.parse(d.at) < 30 * 60 * 1000,
  );
  records = dashboard.data.records;
  dnsEvidence = dashboard.file;
}
if (
  !records.some(
    (r) =>
      r.name === host &&
      r.type === "CNAME" &&
      r.content === "stonegate-site.onrender.com" &&
      r.proxied,
  ) ||
  !records.some(
    (r) =>
      r.name === "www." + host &&
      r.type === "CNAME" &&
      r.content === "stonegate-site.onrender.com" &&
      r.proxied,
  )
)
  throw Error("Expected proxied Render O2O CNAMEs missing");
const production = JSON.parse(
  await readFile(path.join(directory, "site-production-secrets.json"), "utf8"),
);
const statusResponse = await fetch(
  "https://stonegate-site-production.jeffrey-78e.workers.dev/__gateway/status",
  {
    headers: { "x-migration-gateway-key": production.MIGRATION_PROBE_TOKEN },
    signal: AbortSignal.timeout(20000),
  },
);
const state = await statusResponse.json();
if (
  !statusResponse.ok ||
  state.phase !== "active" ||
  !state.running ||
  !state.desiredActive ||
  state.lastHealth?.healthy !== true ||
  Date.now() - state.lastHealth.at > 150000
)
  throw Error("Production website not stably ready");
const expectedImage = JSON.parse(
  await readFile(
    new URL(
      "../../infra/cloudflare/http-gateway/wrangler.production-site.jsonc",
      import.meta.url,
    ),
    "utf8",
  ),
).containers[0].images.base.image;
if (state.image?.image !== expectedImage)
  throw Error("Production image differs from prepared configuration");
const plan = {
  at: new Date().toISOString(),
  source: {
    id: service,
    revision,
    autoDeployTrigger: source.autoDeployTrigger,
    liveDeploy: deployment.id,
  },
  target: {
    script: "stonegate-site-production",
    image: expectedImage,
    generation: state.generation,
  },
  evidence: evidence.map((e) => e.file),
  dnsEvidence,
  routes: definitions,
  dnsRecordsChanged: false,
};
if (action === "plan") {
  await privateJson("site-rollout-plan-" + Date.now() + ".json", plan);
  console.log(JSON.stringify(plan));
  process.exit(0);
}
const preservation = evidence[1].data;
async function verifyPublicStatic() {
  let count = 0;
  for (let i = 0; i < preservation.verified.length; i += 4)
    await Promise.all(
      preservation.verified.slice(i, i + 4).map(async (asset) => {
        let r;
        let bytes;
        for (let attempt = 0; attempt < 10; attempt++) {
          r = await fetch("https://" + host + "/_next/static/" + asset.key, {
            signal: AbortSignal.timeout(30000),
            cache: "no-store",
          });
          bytes = Buffer.from(await r.arrayBuffer());
          if (r.headers.get("x-migration-site-route") === "preserved-static")
            break;
          if (attempt < 9) await delay(2000);
        }
        if (
          !r.ok ||
          r.headers.get("x-migration-site-route") !== "preserved-static" ||
          bytes.length !== asset.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== asset.sha256
        )
          throw Error(
            "Public static validation failed: " +
              JSON.stringify({
                key: asset.key,
                status: r.status,
                route: r.headers.get("x-migration-site-route"),
                actualBytes: bytes.length,
                expectedBytes: asset.bytes,
                actualHash: createHash("sha256").update(bytes).digest("hex"),
                expectedHash: asset.sha256,
              }),
          );
        count++;
      }),
    );
  return count;
}
if (action === "site") {
  if (
    !definitions
      .filter((d) => d.kind === "static")
      .every((d) =>
        initial.some((r) => r.pattern === d.pattern && r.script === d.script),
      )
  )
    throw Error("Static continuity routes must be installed first");
  await verifyPublicStatic();
}
await privateJson(
  "site-rollout-before-" + action + "-" + Date.now() + ".json",
  { ...plan, existingRoutes: initial },
);
if (source.autoDeployTrigger !== "off") {
  const changed = await render("", "PATCH", { autoDeployTrigger: "off" });
  if (changed.autoDeployTrigger !== "off")
    throw Error("Source autodeploy freeze did not apply");
}
const applied = [];
try {
  for (const definition of definitions.filter((d) => d.kind === action)) {
    const existing = initial.find((r) => r.pattern === definition.pattern);
    const route =
      existing ??
      (await cf("/workers/routes", "POST", {
        pattern: definition.pattern,
        script: definition.script,
      }));
    applied.push({ id: route.id, ...definition, created: !existing });
    await privateJson(
      "site-rollout-route-" + route.id + "-" + Date.now() + ".json",
      { at: new Date().toISOString(), ...applied.at(-1) },
    );
  }
  let finalRoutes;
  for (let attempt = 0; attempt < 10; attempt++) {
    finalRoutes = await cf("/workers/routes");
    if (
      applied.every((r) =>
        finalRoutes.some((x) => x.id === r.id && x.script === r.script),
      )
    )
      break;
    if (attempt < 9) await delay(2000);
  }
  if (
    !applied.every((r) =>
      finalRoutes.some((x) => x.id === r.id && x.script === r.script),
    )
  )
    throw Error(
      "Route activation could not be confirmed: " + JSON.stringify(finalRoutes),
    );
  let verifiedAssets;
  if (action === "static") verifiedAssets = await verifyPublicStatic();
  if (action === "site") {
    // Route writes and edge propagation are separate. Wait only with GETs;
    // business mutations are never replayed while waiting for the new route.
    let active = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await fetch("https://" + host + "/", {
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      await response.body?.cancel();
      active =
        response.status === 200 &&
        response.headers.get("x-stonegate-hosting") === "cloudflare";
      if (active) break;
      await delay(1000);
    }
    if (!active) throw Error("Public website route did not become healthy");
  }
  const websiteChecks = action === "site" ? await verifyWebsite() : undefined;
  const receipt = {
    at: new Date().toISOString(),
    action,
    applied,
    verifiedAssets,
    websiteChecks,
    sourceAutodeploy: "off",
    dnsRecordsChanged: false,
  };
  await privateJson(
    "site-rollout-" + action + "-" + Date.now() + ".json",
    receipt,
  );
  console.log(JSON.stringify(receipt));
} catch (error) {
  // Revert only routes created by this invocation. Static continuity routes
  // remain installed when reverting the subsequent website switch.
  const removed = [];
  const failedRemovals = [];
  for (const route of applied.filter((r) => r.created)) {
    try {
      await cf("/workers/routes/" + route.id, "DELETE");
      removed.push(route.id);
    } catch {
      failedRemovals.push(route.id);
    }
  }
  const receipt = {
    at: new Date().toISOString(),
    action,
    ok: false,
    error: error.message,
    removed,
    failedRemovals,
    sourceAutodeploy: "off",
    dnsRecordsChanged: false,
  };
  await privateJson(
    "site-rollout-failed-" + action + "-" + Date.now() + ".json",
    receipt,
  );
  console.log(JSON.stringify(receipt));
  process.exitCode = 1;
}

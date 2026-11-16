import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const token = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const filename = (await readdir(directory))
  .filter((f) => /^site-static-preservation-\d+\.json$/.test(f))
  .sort()
  .at(-1);
if (!filename) throw Error("No completed static preservation receipt");
const preservation = JSON.parse(
  await readFile(path.join(directory, filename), "utf8"),
);
if (!preservation.ok) throw Error("Latest static preservation failed");
const legacy = JSON.parse(
  await readFile(
    path.join(directory, "site-render-static-inventory.json"),
    "utf8",
  ),
);
const legacyKeys = new Set(legacy.map((a) => a.key));
const base =
  "https://stonegate-site-rollback-validation.jeffrey-78e.workers.dev";
const checks = [];
const hash = (data) => createHash("sha256").update(data).digest("hex");
function check(name, pass, extra = {}) {
  checks.push({ name, pass, ...extra });
  if (!pass) throw Error("Rollback check failed: " + name);
}
async function call(route, options = {}, authenticated = true) {
  return fetch(base + route, {
    ...options,
    headers: {
      ...(authenticated ? { "x-migration-gateway-key": token } : {}),
      ...options.headers,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(35000),
  });
}
try {
  const rejected = await call("/", {}, false);
  await rejected.body?.cancel();
  check("private-rollout-rejects-anonymous", rejected.status === 401);
  for (const route of [
    "/",
    "/book",
    "/partners/login",
    "/team/login",
    "/mobile/login",
    "/api/healthz",
  ]) {
    const r = await call(route);
    await r.body?.cancel();
    check(
      "render-html:" + route,
      r.status === 200 &&
        r.headers.get("x-migration-site-route") === "render-origin",
    );
  }
  const www = await call("/", {
    headers: { "x-migration-preview-host": "www.stonegatejunkremoval.com" },
  });
  await www.body?.cancel();
  check(
    "www-origin-preserved",
    [200, 301, 302, 307, 308].includes(www.status) &&
      www.headers.get("x-migration-site-route") === "render-origin",
    { status: www.status },
  );
  let checked = 0;
  for (let i = 0; i < preservation.verified.length; i += 4) {
    await Promise.all(
      preservation.verified.slice(i, i + 4).map(async (asset) => {
        const r = await call("/_next/static/" + asset.key);
        const bytes = Buffer.from(await r.arrayBuffer());
        if (
          !r.ok ||
          r.headers.get("x-migration-site-route") !== "preserved-static" ||
          r.headers.get("content-type") !== asset.contentType ||
          bytes.length !== asset.bytes ||
          hash(bytes) !== asset.sha256
        )
          throw Error("Preserved asset differs");
        checked++;
      }),
    );
  }
  check(
    "all-build-assets-survive-render-rollback",
    checked === preservation.verified.length,
    { assets: checked },
  );
  const fresh = preservation.verified.find(
    (a) => !legacyKeys.has(a.key) && a.key.endsWith(".js"),
  );
  check("new-build-asset-available", Boolean(fresh));
  const oldOrigin = await fetch(
    "https://stonegate-site.onrender.com/_next/static/" + fresh.key,
    { redirect: "manual", signal: AbortSignal.timeout(30000) },
  );
  await oldOrigin.body?.cancel();
  check("old-origin-lacks-new-build-file", oldOrigin.status === 404, {
    status: oldOrigin.status,
  });
  const restored = await call("/_next/static/" + fresh.key);
  const etag = restored.headers.get("etag");
  await restored.body?.cancel();
  check(
    "preserved-asset-has-immutable-cache",
    restored.ok &&
      Boolean(etag) &&
      restored.headers.get("cache-control")?.includes("immutable"),
  );
  const head = await call("/_next/static/" + fresh.key, {
    method: "HEAD",
    headers: { "accept-encoding": "identity" },
  });
  check(
    "head-preserves-length-without-body",
    head.status === 200 &&
      Number(head.headers.get("content-length")) === fresh.bytes &&
      (await head.text()) === "",
  );
  const conditional = await call("/_next/static/" + fresh.key, {
    headers: { "if-none-match": etag },
  });
  check(
    "conditional-static-cache-returns-304",
    conditional.status === 304 && (await conditional.text()) === "",
  );
  for (const [route, method, status] of [
    ["/api/team/contacts", "POST", 405],
    ["/_next/server/server-reference-manifest.json", "GET", 404],
    ["/api/admin/contacts", "GET", 404],
  ]) {
    const r = await call(route, { method });
    await r.body?.cancel();
    check("blocked:" + route, r.status === status);
  }
  const untrusted = await call("/", {
    headers: { "x-migration-preview-host": "attacker.invalid" },
  });
  await untrusted.body?.cancel();
  check("arbitrary-origin-rejected", untrusted.status === 400);
} catch (error) {
  checks.push({
    name: "rollback-validation-failed",
    pass: false,
    error: error.message,
  });
  process.exitCode = 1;
}
const receipt = {
  at: new Date().toISOString(),
  ok: checks.every((c) => c.pass),
  productionRoutesChanged: false,
  sourceReceipt: filename,
  checks,
};
await writeFile(
  path.join(directory, "site-rollback-validation-" + Date.now() + ".json"),
  JSON.stringify(receipt, null, 2),
  { mode: 0o600, flag: "wx" },
);
console.log(JSON.stringify(receipt));

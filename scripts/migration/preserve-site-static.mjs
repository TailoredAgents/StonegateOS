import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const token = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const { ARCHIVE_TOKEN } = JSON.parse(
  await readFile(path.join(directory, "asset-worker-secrets.json"), "utf8"),
);
const expected = JSON.parse(
  await readFile(
    new URL(
      "../../infra/cloudflare/site-candidate/wrangler.jsonc",
      import.meta.url,
    ),
    "utf8",
  ),
).containers[0].images.base.image;
const legacy = JSON.parse(
  await readFile(
    path.join(directory, "site-render-static-inventory.json"),
    "utf8",
  ),
);
const candidate = "https://stonegate-site-candidate.jeffrey-78e.workers.dev";
const archive = "https://stonegate-migration-assets.jeffrey-78e.workers.dev";
const checks = [];
const verified = [];
let inventory;
const hash = (data) => createHash("sha256").update(data).digest("hex");
function check(name, pass, extra = {}) {
  checks.push({ name, pass, ...extra });
  if (!pass) throw Error("Static preservation failed: " + name);
}
async function call(base, route, credential, options = {}) {
  return fetch(base + route, {
    ...options,
    headers: { authorization: "Bearer " + credential, ...options.headers },
    redirect: "manual",
    signal: AbortSignal.timeout(150000),
  });
}
try {
  const unauth = await fetch(candidate + "/__candidate/static-manifest");
  await unauth.body?.cancel();
  check("inventory-requires-auth", unauth.status === 401);
  const start = await call(candidate, "/__candidate/start", token, {
    method: "POST",
  });
  const state = await start.json();
  check(
    "expected-private-site-image",
    start.ok && state.ready && state.image?.image === expected,
  );
  const response = await call(candidate, "/__candidate/static-manifest", token);
  inventory = await response.json();
  check(
    "bounded-static-inventory",
    response.ok &&
      inventory.assets?.length >= legacy.length &&
      inventory.totalBytes > 0 &&
      inventory.totalBytes <= 32 * 1024 * 1024,
  );
  const map = new Map(inventory.assets.map((a) => [a.key, a]));
  check(
    "all-legacy-assets-preserved",
    legacy.every(
      (a) =>
        map.get(a.key)?.sha256 === a.sha256 &&
        map.get(a.key)?.bytes === a.bytes,
    ),
  );
  for (const asset of inventory.assets) {
    if (
      !/^[a-zA-Z0-9_./@()~\[\]-]+$/.test(asset.key) ||
      asset.key.split("/").some((x) => !x || x === "." || x === "..")
    )
      throw Error("Unsafe inventory path");
    const current = await call(candidate, "/_next/static/" + asset.key, token);
    const bytes = Buffer.from(await current.arrayBuffer());
    if (
      !current.ok ||
      bytes.length !== asset.bytes ||
      hash(bytes) !== asset.sha256
    )
      throw Error("Candidate asset mismatch");
    const route = "/static/" + encodeURIComponent(asset.key);
    const uploaded = await call(archive, route, ARCHIVE_TOKEN, {
      method: "PUT",
      headers: { "x-content-sha256": asset.sha256 },
      body: bytes,
    });
    const receipt = await uploaded.json();
    if (
      !uploaded.ok ||
      !receipt.ok ||
      receipt.bytes !== asset.bytes ||
      receipt.sha256 !== asset.sha256
    )
      throw Error("Static upload failed");
    const remote = await call(archive, route, ARCHIVE_TOKEN);
    const copy = Buffer.from(await remote.arrayBuffer());
    if (
      !remote.ok ||
      copy.length !== asset.bytes ||
      hash(copy) !== asset.sha256 ||
      remote.headers.get("x-content-sha256") !== asset.sha256
    )
      throw Error("Static roundtrip mismatch");
    verified.push({
      ...asset,
      contentType: remote.headers.get("content-type"),
    });
  }
  check(
    "all-static-assets-roundtrip",
    verified.length === inventory.assets.length,
    {
      files: verified.length,
      bytes: inventory.totalBytes,
      legacy: legacy.length,
      newFiles: verified.length - legacy.length,
    },
  );
  const first = verified[0];
  const route = "/static/" + encodeURIComponent(first.key);
  const unauthAsset = await fetch(archive + route);
  await unauthAsset.body?.cancel();
  check("static-archive-remains-private", unauthAsset.status === 401);
  const corrupt = Buffer.from("deliberately different synthetic asset");
  const mismatch = await call(archive, route, ARCHIVE_TOKEN, {
    method: "PUT",
    headers: { "x-content-sha256": first.sha256 },
    body: corrupt,
  });
  await mismatch.body?.cancel();
  check("mismatched-content-rejected", mismatch.status === 422);
  const conflict = await call(archive, route, ARCHIVE_TOKEN, {
    method: "PUT",
    headers: { "x-content-sha256": hash(corrupt) },
    body: corrupt,
  });
  await conflict.body?.cancel();
  check("immutable-path-conflict-rejected", conflict.status === 409);
  const after = await call(archive, route, ARCHIVE_TOKEN);
  check(
    "original-static-object-survives-conflict",
    after.ok && hash(Buffer.from(await after.arrayBuffer())) === first.sha256,
  );
} catch (error) {
  checks.push({
    name: "preservation-failed",
    pass: false,
    error: error.message,
  });
  process.exitCode = 1;
} finally {
  const stop = await call(candidate, "/__candidate/stop", token, {
    method: "POST",
  });
  await stop.body?.cancel();
  checks.push({ name: "candidate-stopped", pass: stop.ok });
  const receipt = {
    at: new Date().toISOString(),
    image: expected,
    ok: checks.every((c) => c.pass),
    checks,
    inventory,
    verified,
  };
  await writeFile(
    path.join(directory, "site-static-preservation-" + Date.now() + ".json"),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify({ at: receipt.at, ok: receipt.ok, checks }));
  if (!receipt.ok) process.exitCode = 1;
}

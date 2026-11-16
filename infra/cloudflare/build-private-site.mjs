// This entrypoint is exclusively for the private Cloudflare registry workflow.
// The existing Render action key must never enter the public GHCR images.
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
if (process.env.STONEGATE_PRIVATE_SITE_BUILD !== "1")
  throw Error("Private site build guard is required");
const prior = JSON.parse(
  readFileSync("/run/secrets/site_compatibility", "utf8"),
);
if (
  typeof prior.actionKey !== "string" ||
  Buffer.from(prior.actionKey, "base64").length !== 32 ||
  !Array.isArray(prior.actionIds) ||
  !prior.actionIds.length ||
  prior.actionIds.some(
    (id) => typeof id !== "string" || !/^[a-f0-9]{40,64}$/.test(id),
  )
)
  throw Error("Invalid private compatibility manifest");
const archive = "/run/legacy_assets/site-assets.tar.gz";
const hash = (data) => createHash("sha256").update(data).digest("hex");
if (
  !Array.isArray(prior.staticInventory) ||
  !prior.staticInventory.length ||
  hash(readFileSync(archive)) !== prior.staticArchiveSha256
)
  throw Error("Legacy asset archive does not match captured inventory");
process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY = prior.actionKey;
try {
  await import("./build-site.mjs");
} finally {
  delete process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;
}
const built = JSON.parse(
  readFileSync(
    "/app/apps/site/.next/server/server-reference-manifest.json",
    "utf8",
  ),
);
const actual = Object.keys(built.node ?? {}).sort();
const expected = [...prior.actionIds].sort();
const missing = expected.filter((id) => !actual.includes(id));
const added = actual.filter((id) => !expected.includes(id));
if (built.encryptionKey !== prior.actionKey || missing.length || added.length)
  throw Error(
    `Server action compatibility failed: missing=${missing.length}, added=${added.length}`,
  );
// The archive hash was verified above and its exact members were independently
// checked when captured. Preserve existing immutable paths without overwrites.
const directory = mkdtempSync("/tmp/stonegate-site-assets-");
let copied = 0;
let identical = 0;
try {
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
  for (const asset of prior.staticInventory) {
    if (
      typeof asset.key !== "string" ||
      path.isAbsolute(asset.key) ||
      asset.key.split("/").includes("..")
    )
      throw Error("Invalid static asset key");
    const from = path.join(directory, asset.key),
      to = path.join("/app/apps/site/.next/static", asset.key);
    const data = readFileSync(from);
    if (data.length !== asset.bytes || hash(data) !== asset.sha256)
      throw Error("Legacy asset content mismatch");
    if (existsSync(to)) {
      if (hash(readFileSync(to)) !== asset.sha256)
        throw Error("Immutable asset path has conflicting contents");
      identical++;
    } else {
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied++;
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
writeFileSync(
  "/app/infra/cloudflare/site-legacy-assets.json",
  JSON.stringify(prior.staticInventory),
);
writeFileSync(
  "/app/infra/cloudflare/site-action-compatibility.json",
  JSON.stringify({
    ok: true,
    existingActionCount: expected.length,
    actionIdsMatch: true,
    encryptionKeyMatches: true,
    legacyAssets: prior.staticInventory.length,
    copiedAssets: copied,
    identicalAssets: identical,
    priorBuildId: prior.buildId,
    buildId: readFileSync("/app/apps/site/.next/BUILD_ID", "utf8").trim(),
  }),
);
console.log(
  JSON.stringify({
    event: "site.legacy_actions_and_assets_verified",
    count: expected.length,
    legacyAssets: prior.staticInventory.length,
  }),
);

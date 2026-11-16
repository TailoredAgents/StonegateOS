// Prepare private settings only. This does not deploy, start, activate, change
// source settings, rotate source credentials or send anything to a provider.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { compareRuntimeSettings } from "./runtime-settings.mjs";
import { splitApiStandbySecrets } from "./api-standby-settings.mjs";
const directory = process.argv[2];
const verifyExisting = process.argv[3] === "--verify-existing";
if (process.argv[3] && !verifyExisting)
  throw Error("Unknown preparation option");
if (!directory) throw Error("Private evidence directory required");
const files = await readdir(directory);
async function latest(prefix) {
  const filename = files
    .filter((name) => name.startsWith(prefix) && /\d+\.json$/.test(name))
    .sort()
    .at(-1);
  if (!filename) throw Error("Evidence missing: " + prefix);
  const data = JSON.parse(
    await readFile(path.join(directory, filename), "utf8"),
  );
  if (!(Date.now() - Date.parse(data.at) < 30 * 60000))
    throw Error("Evidence stale: " + prefix);
  return { filename, data };
}
const inventory = await latest("runtime-config-inventory-");
if (!inventory.data.ok || inventory.data.services.length !== 2)
  throw Error("Configuration audit incomplete");
const item = inventory.data.services.find((service) => service.name === "api");
if (!item || item.revision !== "0e66a789ea1c33b297aa5f1324571904c3fa2894")
  throw Error("Unexpected API revision");
const snapshot = JSON.parse(
  await readFile(path.join(directory, item.privateEvidenceFile), "utf8"),
);
const environment = snapshot.configured;
if (
  compareRuntimeSettings(environment, snapshot.effective).unexplainedDifferences
    .length
)
  throw Error("Runtime environment mismatch");
const environmentSha256 = createHash("sha256")
  .update(
    JSON.stringify(
      Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)),
    ),
  )
  .digest("hex");
if (environmentSha256 !== item.configuredSha256)
  throw Error("Environment fingerprint changed");
// Render's rotated login automatically SET ROLEs to its existing owner. Audit
// both identities; login flags alone do not describe effective privileges.
const identity = await latest("api-standby-session-identity-");
const observed = identity.data;
const login = observed.roles.find(
  (role) => role.rolname === "stonegate_rot_20260921",
);
const owner = observed.roles.find((role) => role.rolname === "stonegate");
if (
  observed.identity.database !== "stonegate" ||
  observed.identity.current_role !== "stonegate" ||
  observed.identity.login_role !== "stonegate_rot_20260921" ||
  observed.identity.configured_role !== "stonegate" ||
  observed.identity.transaction_read_only !== "on" ||
  observed.identity.tls !== true ||
  observed.environmentSha256 !== environmentSha256 ||
  observed.scope.writable_tables !== 230 ||
  observed.scope.writable_sequences !== 1 ||
  !login?.rolcanlogin ||
  login.rolsuper ||
  login.rolcreatedb ||
  login.rolcreaterole ||
  login.rolbypassrls ||
  owner?.rolcanlogin !== false ||
  owner.rolsuper ||
  owner.rolbypassrls ||
  !owner.rolcreatedb ||
  !owner.rolcreaterole
)
  throw Error("Source session identity or effective privileges changed");
const secrets = JSON.parse(
  await readFile(path.join(directory, "source-worker-secrets.json"), "utf8"),
);
const source = JSON.parse(secrets.MIGRATION_SOURCE_CONNECTION);
const db = new URL(environment.DATABASE_URL);
if (
  db.hostname !== "dpg-d43o7c0dl3ps73a4rb4g-a" ||
  decodeURIComponent(db.username) !== "stonegate_rot_20260921" ||
  db.pathname !== "/stonegate" ||
  source.host !== db.hostname ||
  source.rejectUnauthorized !== true ||
  !(Date.parse(source.expiresAt) > Date.now() + 24 * 3600000)
)
  throw Error("Unexpected source database connection");
const connection = {
  ...source,
  purpose: "source-production-connection",
  user: decodeURIComponent(db.username),
  password: decodeURIComponent(db.password),
  database: "stonegate",
};
const envelope = {
  purpose: "source-api-production-standby",
  service: item.service,
  sourceRevision: item.revision,
  environment,
  environmentSha256,
  connection,
};
const filename = "production-api-standby-secrets.json";
const existing = verifyExisting
  ? JSON.parse(await readFile(path.join(directory, filename), "utf8"))
  : null;
const prepared = splitApiStandbySecrets({
  SOURCE_API_RUNTIME_CONFIG: JSON.stringify(envelope),
  MIGRATION_PROBE_TOKEN:
    existing?.MIGRATION_PROBE_TOKEN ?? randomBytes(32).toString("hex"),
});
if (verifyExisting) {
  if (
    Object.keys(existing).length !== Object.keys(prepared).length ||
    Object.entries(prepared).some(([key, value]) => existing[key] !== value)
  )
    throw Error("Existing standby settings differ from fresh source audits");
} else {
  await writeFile(path.join(directory, filename), JSON.stringify(prepared), {
    mode: 0o600,
    flag: "wx",
  });
}
const receipt = {
  at: new Date().toISOString(),
  purpose: envelope.purpose,
  existingSettingsVerified: verifyExisting,
  sourceRevision: item.revision,
  environmentSha256,
  configuredCount: Object.keys(environment).length,
  settingsAudit: inventory.filename,
  sessionIdentityAudit: identity.filename,
  privateSecretsFile: filename,
  credentialExpiresAt: connection.expiresAt,
  sourceChanged: false,
  promotionAllowed: false,
  providerMessagesSent: 0,
};
await writeFile(
  path.join(
    directory,
    "production-api-standby-preparation-" + Date.now() + ".json",
  ),
  JSON.stringify(receipt, null, 2),
  { mode: 0o600, flag: "wx" },
);
console.log(JSON.stringify(receipt, null, 2));

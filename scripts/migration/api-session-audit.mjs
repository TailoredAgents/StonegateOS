// Inspect the existing application login and effective owner in READ ONLY
// transactions. Requires the authenticated source SSH forward on localhost:65431.
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const files = await readdir(directory);
const latest = files
  .filter((name) => /^runtime-config-inventory-\d+\.json$/.test(name))
  .sort()
  .at(-1);
if (!latest) throw Error("Configuration audit required");
const inventory = JSON.parse(
  await readFile(path.join(directory, latest), "utf8"),
);
if (!inventory.ok || Date.now() - Date.parse(inventory.at) > 30 * 60000)
  throw Error("Fresh successful configuration audit required");
const api = inventory.services.find((service) => service.name === "api");
if (
  api?.service !== "srv-d43o7k0dl3ps73a4rhu0" ||
  api.revision !== "0e66a789ea1c33b297aa5f1324571904c3fa2894"
)
  throw Error("Unexpected source API");
const snapshot = JSON.parse(
  await readFile(path.join(directory, api.privateEvidenceFile), "utf8"),
);
const url = new URL(snapshot.configured.DATABASE_URL);
const secrets = JSON.parse(
  await readFile(path.join(directory, "source-worker-secrets.json"), "utf8"),
);
const source = JSON.parse(secrets.MIGRATION_SOURCE_CONNECTION);
if (
  url.hostname !== "dpg-d43o7c0dl3ps73a4rb4g-a" ||
  decodeURIComponent(url.username) !== "stonegate_rot_20260921" ||
  url.pathname !== "/stonegate" ||
  source.host !== url.hostname ||
  source.rejectUnauthorized !== true ||
  Date.parse(source.expiresAt) <= Date.now()
)
  throw Error("Unexpected source connection");
const sql = postgres({
  host: "127.0.0.1",
  port: 65431,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: "stonegate",
  max: 1,
  prepare: false,
  connect_timeout: 5,
  onnotice() {},
  ssl: {
    ca: source.ca,
    servername: source.servername,
    rejectUnauthorized: true,
  },
  connection: {
    default_transaction_read_only: "on",
    statement_timeout: 10000,
    application_name: "stonegate-session-identity-audit",
  },
});
try {
  const data = await sql.begin("read only", async (tx) => {
    const [identity] =
      await tx`select current_database() as database,current_user as current_role,session_user as login_role,
      current_setting('role') as configured_role,current_setting('transaction_read_only') as transaction_read_only,
      (select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls`;
    const roles =
      await tx`select rolname,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolinherit,rolcanlogin from pg_roles where rolname in (current_user,session_user)`;
    const roleSettings =
      await tx`select d.datname,r.rolname,s.setconfig from pg_db_role_setting s left join pg_database d on d.oid=s.setdatabase left join pg_roles r on r.oid=s.setrole where r.rolname in (current_user,session_user)`;
    const [scope] = await tx`select
      (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind in ('r','p') and case when c.relkind in ('r','p') then has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') else false end) as writable_tables,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind='S' and case when c.relkind='S' then has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE') else false end) as writable_sequences`;
    return { identity, roles, roleSettings, scope };
  });
  const receipt = {
    at: new Date().toISOString(),
    sourceRevision: api.revision,
    environmentSha256: api.configuredSha256,
    ...data,
    sourceChanged: false,
  };
  await writeFile(
    path.join(
      directory,
      "api-standby-session-identity-" + Date.now() + ".json",
    ),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await sql.end({ timeout: 2 });
}

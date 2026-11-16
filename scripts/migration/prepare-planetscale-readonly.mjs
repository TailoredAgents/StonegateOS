// Scoped, expiring read-only credential for the separately restored target.
// Neither source credentials nor production runtime configuration are used.
import postgres from "postgres";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const read = async (name) =>
  JSON.parse(await readFile(path.join(directory, name), "utf8"));
const config = await read("planetscale-connection.json");
const target = await read("planetscale-restore-target.json");
if (
  config.purpose !== "migration-replacement-standby" ||
  config.project !== "stonegate-os-pg17" ||
  !config.host.endsWith(".psdb.cloud") ||
  target.host !== config.host ||
  target.user !== config.user ||
  target.database !== "stonegate_restore_20261116" ||
  Date.parse(target.expiresAt) <= Date.now()
)
  throw Error("Wrong or expired replacement target");
const user = "stonegate_target_probe_ro";
const branch = config.user.split(".").at(-1);
if (!/^[a-z0-9]+$/.test(branch) || !config.user.includes("."))
  throw Error("Invalid routing username");
const options = {
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: target.database,
  max: 1,
  prepare: false,
  ssl: { rejectUnauthorized: true },
  onnotice: () => {},
  connection: {
    statement_timeout: 15000,
    application_name: "stonegate-target-role-preparation",
  },
};
const admin = postgres(options);
let probe;
try {
  const existing = await admin`select 1 from pg_roles where rolname=${user}`;
  if (existing.length)
    throw Error("Probe role already exists; inspect instead of replacing it");
  const [security] =
    await admin`select count(*)::int as count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','drizzle') and p.prosecdef`;
  if (security.count)
    throw Error("Security-definer functions require a separate grant review");
  const credential = {
    purpose: "target-readiness-read-only",
    host: config.host,
    port: config.port,
    user: user + "." + branch,
    sqlRole: user,
    password: randomBytes(32).toString("hex"),
    database: target.database,
    expiresAt: target.expiresAt,
    rejectUnauthorized: true,
  };
  // Persist before mutation so an interrupted setup can be recovered privately.
  await writeFile(
    path.join(directory, "planetscale-readonly.json"),
    JSON.stringify(credential),
    { mode: 0o600, flag: "wx" },
  );
  await admin.begin(async (sql) => {
    await sql.unsafe(
      `CREATE ROLE ${user} LOGIN PASSWORD '${credential.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 VALID UNTIL '${credential.expiresAt}'`,
    );
    await sql.unsafe(`ALTER ROLE ${user} SET default_transaction_read_only=on`);
    await sql.unsafe(`ALTER ROLE ${user} SET statement_timeout='15s'`);
    await sql.unsafe(`ALTER ROLE ${user} SET lock_timeout='2s'`);
    await sql.unsafe(`GRANT CONNECT ON DATABASE ${target.database} TO ${user}`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA public,drizzle TO ${user}`);
    await sql.unsafe(
      `GRANT SELECT ON ALL TABLES IN SCHEMA public,drizzle TO ${user}`,
    );
    await sql.unsafe(
      `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public,drizzle TO ${user}`,
    );
  });
  probe = postgres({
    ...options,
    user: credential.user,
    password: credential.password,
  });
  const [identity] =
    await probe`select current_user as role,current_database() as database,current_setting('transaction_read_only') as read_only`;
  const [permissions] =
    await probe`select rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls from pg_roles where rolname=current_user`;
  const [scope] = await probe`select
    (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind in ('r','p') and has_table_privilege(current_user,c.oid,'SELECT')) as readable_tables,
    (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind in ('r','p') and has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')) as writable_tables,
    (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind='S' and has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE')) as writable_sequences`;
  if (
    identity.role !== user ||
    identity.database !== target.database ||
    identity.read_only !== "on" ||
    Object.values(permissions).some(Boolean) ||
    scope.readable_tables !== 230 ||
    scope.writable_tables ||
    scope.writable_sequences
  )
    throw Error("Read-only scope verification failed");
  const [expected] =
    await probe`select (select count(*)::int from contacts) as contacts,(select count(*)::int from appointments) as appointments,(select count(*)::int from outbox_events) as outbox_events`;
  credential.expected = expected;
  await writeFile(
    path.join(directory, "planetscale-readonly.json"),
    JSON.stringify(credential),
    { mode: 0o600 },
  );
  const token = (
    await readFile(path.join(directory, "probe-token"), "utf8")
  ).trim();
  await writeFile(
    path.join(directory, "planetscale-worker-secrets.json"),
    JSON.stringify({
      MIGRATION_TARGET_CONNECTION: JSON.stringify(credential),
      MIGRATION_PROBE_TOKEN: token,
    }),
    { mode: 0o600, flag: "wx" },
  );
  const receipt = {
    at: new Date().toISOString(),
    ...scope,
    privileged: false,
    defaultReadOnly: true,
    verifiedClientTls: true,
    sourceTouched: false,
  };
  await writeFile(
    path.join(directory, "planetscale-readonly-receipt.json"),
    JSON.stringify(receipt),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(receipt));
} catch (e) {
  await writeFile(
    path.join(directory, "planetscale-readonly-error.log"),
    e.stack,
    { mode: 0o600 },
  );
  console.error(JSON.stringify({ ok: false, code: e.code ?? e.name }));
  process.exitCode = 1;
} finally {
  await probe?.end({ timeout: 2 });
  await admin.end({ timeout: 2 });
}

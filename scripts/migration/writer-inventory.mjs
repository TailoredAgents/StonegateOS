// Read-only evidence for designing the eventual writer fence. This command
// never changes roles, terminates sessions, freezes writes or promotes a target.
import postgres from "postgres";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const read = async (name) =>
  JSON.parse(await readFile(path.join(directory, name), "utf8"));
const connection = await read("source-connection.json"),
  tls = await read("source-readonly.json");
const origin = new URL(connection.internalConnectionString);
if (origin.hostname !== "dpg-d43o7c0dl3ps73a4rb4g-a")
  throw Error("Unexpected source instance");
const sql = postgres({
  host: "127.0.0.1",
  port: 65431,
  user: decodeURIComponent(origin.username),
  password: decodeURIComponent(origin.password),
  database: origin.pathname.slice(1),
  max: 1,
  prepare: false,
  connect_timeout: 10,
  onnotice: () => {},
  ssl: { ca: tls.ca, servername: tls.servername, rejectUnauthorized: true },
  connection: {
    application_name: "stonegate-migration-writer-inventory",
    statement_timeout: 15000,
    lock_timeout: 2000,
  },
});
try {
  const receipt = await sql.begin("read only", async (tx) => {
    const [identity] =
      await tx`select current_database() as database,current_user as role,current_setting('transaction_read_only') as read_only,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls`;
    if (
      identity.database !== origin.pathname.slice(1) ||
      identity.read_only !== "on" ||
      identity.tls !== true
    )
      throw Error("Source identity or read-only/TLS boundary mismatch");
    const roles =
      await tx`select r.rolname,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,r.rolconnlimit,
   has_database_privilege(r.oid,current_database(),'CREATE') as can_create_schema,
   (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind in ('r','p') and has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')) as writable_tables
   from pg_roles r where r.rolcanlogin order by r.rolname`;
    const sessions =
      await tx`select usename,application_name,state,count(*)::int as connections,max(extract(epoch from now()-xact_start))::int as oldest_transaction_seconds from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and backend_type='client backend' group by usename,application_name,state order by usename,application_name,state`;
    const [special] =
      await tx`select (select count(*)::int from pg_prepared_xacts where database=current_database()) as prepared_transactions,(select count(*)::int from pg_largeobject_metadata) as large_objects,(select count(*)::int from pg_replication_slots where database=current_database()) as replication_slots,current_setting('wal_level') as wal_level`;
    return { at: new Date().toISOString(), identity, roles, sessions, special };
  });
  const bindings = [];
  for (const service of ["api", "outbox", "discord"]) {
    const env = await read(service + "-env.json");
    const u = new URL(env.DATABASE_URL);
    bindings.push({
      service,
      role: decodeURIComponent(u.username),
      sourceHostMatches: u.hostname === origin.hostname,
      sourceDatabaseMatches: u.pathname === origin.pathname,
    });
  }
  if (bindings.some((x) => !x.sourceHostMatches || !x.sourceDatabaseMatches))
    throw Error("Deployed database binding changed");
  receipt.bindings = bindings;
  await writeFile(
    path.join(directory, `writer-inventory-${Date.now()}.json`),
    JSON.stringify(receipt),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      readOnly: true,
      tlsVerified: true,
      loginRoles: receipt.roles.length,
      rolesWithWritableTables: receipt.roles.filter(
        (r) => r.writable_tables > 0,
      ).length,
      applicationWriterRoles: new Set(bindings.map((x) => x.role)).size,
      applicationServices: bindings.map((x) => x.service),
      sessions: receipt.sessions.reduce((sum, x) => sum + x.connections, 0),
      ...receipt.special,
      sourceFenced: false,
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.code ?? error.name }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
}

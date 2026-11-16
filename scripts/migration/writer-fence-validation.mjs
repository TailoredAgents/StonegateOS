// Rehearse the source's shared, nonprivileged login on an isolated Render
// recovery server. This script never reads or changes the live source password.
import postgres from "postgres";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const restore = JSON.parse(
  await readFile(path.join(directory, "restore-connection.json"), "utf8"),
);
const transport = JSON.parse(
  await readFile(path.join(directory, "container-restore-secret.json"), "utf8"),
);
const source = new URL(restore.internalConnectionString);
if (
  source.hostname !== "dpg-dbt21dui0phs73efick0-a" ||
  source.pathname !== "/stonegate_restore_20261115"
)
  throw Error("Wrong isolated recovery server");
const suffix = randomBytes(6).toString("hex");
const database = "stonegate_fence_" + suffix;
const role = "stonegate_fence_" + suffix;
const oldPassword = randomBytes(32).toString("hex");
const rotatedPassword = randomBytes(32).toString("hex");
const base = {
  host: "127.0.0.1",
  port: 65432,
  max: 1,
  prepare: false,
  connect_timeout: 5,
  onnotice: () => {},
  ssl: {
    ca: transport.ca,
    servername: transport.servername,
    rejectUnauthorized: true,
  },
};
const owner = postgres({
  ...base,
  user: decodeURIComponent(source.username),
  password: decodeURIComponent(source.password),
  database: source.pathname.slice(1),
});
const clients = [];
const checks = [];
let createdRole = false;
let createdDatabase = false;
let passed = false;
const started = performance.now();
await writeFile(
  path.join(directory, `writer-fence-intent-${suffix}.json`),
  JSON.stringify({
    at: new Date().toISOString(),
    database,
    role,
    recoveryServerOnly: true,
  }),
  { mode: 0o600, flag: "wx" },
);
function check(name, pass) {
  checks.push({ name, pass });
  if (!pass) throw Error("FENCE_CHECK_FAILED:" + name);
}
function client(password, label) {
  const c = postgres({
    ...base,
    user: role,
    password,
    database,
    connection: {
      application_name: "stonegate-fence-" + label,
      statement_timeout: 20000,
    },
  });
  clients.push(c);
  return c;
}
async function oldLoginRejected() {
  const c = client(oldPassword, "old-login-attempt");
  try {
    await c`select 1`;
    return false;
  } catch (e) {
    return e.code === "28P01";
  } finally {
    await c.end({ timeout: 1 });
  }
}
try {
  const [identity] =
    await owner`select current_database() as database,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls`;
  check(
    "isolated-render-target-and-tls",
    identity.database === "stonegate_restore_20261115" && identity.tls === true,
  );
  await owner.unsafe(
    `CREATE ROLE ${role} LOGIN PASSWORD '${oldPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 10 VALID UNTIL '2026-11-22T22:00:00Z'`,
  );
  createdRole = true;
  await owner.unsafe(
    `GRANT ${role} TO "${decodeURIComponent(source.username).replaceAll('"', '""')}"`,
  );
  await owner.unsafe(`CREATE DATABASE ${database} OWNER ${role}`);
  createdDatabase = true;
  await owner.unsafe(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  const fence = client(oldPassword, "controller");
  const [permissions] =
    await fence`select rolsuper,rolcreaterole,rolcreatedb from pg_roles where rolname=current_user`;
  check(
    "writer-matches-source-nonprivileged-role",
    !permissions.rolsuper &&
      !permissions.rolcreaterole &&
      !permissions.rolcreatedb,
  );
  await fence`create table committed_writes(label text primary key)`;
  const writers = [
    client(oldPassword, "api"),
    client(oldPassword, "outbox"),
    client(oldPassword, "discord"),
  ];
  await Promise.all(
    writers.map(
      (c, i) => c`insert into committed_writes values (${String(i)})`,
    ),
  );
  check(
    "three-existing-writers-commit",
    (await fence`select count(*)::int as count from committed_writes`)[0]
      .count === 3,
  );
  let entered;
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  const unfinished = writers[2]
    .begin(async (tx) => {
      await tx`insert into committed_writes values ('uncommitted')`;
      entered();
      await tx`select pg_sleep(15)`;
    })
    .then(
      () => ({ committed: true }),
      (e) => ({ committed: false, code: e.code }),
    );
  await enteredPromise;
  await fence.unsafe(`ALTER ROLE ${role} PASSWORD '${rotatedPassword}'`);
  check("old-credential-cannot-open-new-connection", await oldLoginRejected());
  // Explicitly demonstrate why password rotation alone is insufficient.
  await writers[0]`insert into committed_writes values ('before-session-fence')`;
  check(
    "existing-session-needs-explicit-termination",
    (await fence`select count(*)::int as count from committed_writes`)[0]
      .count === 4,
  );
  const terminated =
    await fence`select pg_terminate_backend(pid) as stopped from pg_stat_activity where usename=current_user and pid<>pg_backend_pid() and backend_type='client backend'`;
  check(
    "unprivileged-owner-can-fence-its-other-sessions",
    terminated.length >= 3 && terminated.every((x) => x.stopped),
  );
  check(
    "unfinished-transaction-does-not-commit",
    (await unfinished).committed === false,
  );
  check("fenced-credentials-remain-rejected", await oldLoginRejected());
  const migration = client(rotatedPassword, "verification-only");
  const state = await migration.begin(
    "isolation level repeatable read read only",
    async (tx) => ({
      rows: await tx`select label from committed_writes order by label`,
      identity: (
        await tx`select current_setting('transaction_read_only') as read_only,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls`
      )[0],
    }),
  );
  check(
    "all-committed-writes-preserved-at-boundary",
    state.rows.length === 4 &&
      !state.rows.some((x) => x.label === "uncommitted"),
  );
  check(
    "verification-connection-read-only-with-tls",
    state.identity.read_only === "on" && state.identity.tls === true,
  );
  const sessions =
    await fence`select application_name from pg_stat_activity where usename=current_user and pid<>pg_backend_pid() and backend_type='client backend'`;
  check(
    "no-old-writer-sessions-survive",
    sessions.every(
      (x) => x.application_name === "stonegate-fence-verification-only",
    ),
  );
  // Before any destination writes, restore the original credential and prove
  // that a freshly connected original writer can resume without lost records.
  await fence.unsafe(`ALTER ROLE ${role} PASSWORD '${oldPassword}'`);
  const rollback = client(oldPassword, "rollback-writer");
  await rollback`insert into committed_writes values ('rollback-resumed')`;
  check(
    "pre-promotion-rollback-resumes-writes",
    (await rollback`select count(*)::int as count from committed_writes`)[0]
      .count === 5,
  );
  passed = true;
} catch (e) {
  checks.push({
    name: "rehearsal-failed",
    pass: false,
    code: e.code ?? e.name,
    check: e.message?.startsWith("FENCE_CHECK_FAILED:")
      ? e.message.slice(19)
      : undefined,
  });
  process.exitCode = 1;
} finally {
  await Promise.all(
    clients.map((c) => c.end({ timeout: 2 }).catch(() => undefined)),
  );
  if (passed) {
    if (createdDatabase) await owner.unsafe(`DROP DATABASE ${database}`);
    if (createdRole) await owner.unsafe(`DROP ROLE ${role}`);
    checks.push({
      name: "only-new-synthetic-database-and-role-cleaned-up",
      pass: true,
    });
  }
  await owner.end({ timeout: 2 });
  const receipt = {
    at: new Date().toISOString(),
    ok: passed,
    elapsedMs: Math.round(performance.now() - started),
    recoveryServerOnly: true,
    productionFenced: false,
    database,
    role,
    checks,
  };
  await writeFile(
    path.join(directory, `writer-fence-validation-${Date.now()}.json`),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(receipt));
}

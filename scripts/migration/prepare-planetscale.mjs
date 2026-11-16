// Create an empty rehearsal database only in the separately provisioned target.
// No source connection, production application configuration or deletion occurs.
import postgres from "postgres";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const config = JSON.parse(
  await readFile(path.join(directory, "planetscale-connection.json"), "utf8"),
);
if (
  config.purpose !== "migration-replacement-standby" ||
  config.project !== "stonegate-os-pg17" ||
  config.branch !== "main" ||
  !config.host.endsWith(".psdb.cloud")
)
  throw Error("Wrong replacement target");
const database = "stonegate_restore_20261116";
async function handshake(servername) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: config.host, port: config.port });
    socket.setTimeout(10000, () =>
      socket.destroy(Error("TLS handshake timed out")),
    );
    socket.once("error", reject);
    socket.once("connect", () => {
      const packet = Buffer.alloc(8);
      packet.writeInt32BE(8, 0);
      packet.writeInt32BE(80877103, 4);
      socket.write(packet);
    });
    socket.once("data", (answer) => {
      if (answer.toString() !== "S") {
        socket.destroy();
        reject(Error("Postgres TLS not available"));
        return;
      }
      const secure = tls.connect({
        socket,
        servername,
        rejectUnauthorized: true,
      });
      secure.once("error", reject);
      secure.once("secureConnect", () => {
        const result = {
          authorized: secure.authorized,
          protocol: secure.getProtocol(),
          fingerprint: secure.getPeerCertificate().fingerprint256,
        };
        secure.end();
        resolve(result);
      });
    });
  });
}
const verified = await handshake(config.host);
let rejectsWrongName = false;
try {
  await handshake("incorrect-migration-host.invalid");
} catch (e) {
  rejectsWrongName = e.code === "ERR_TLS_CERT_ALTNAME_INVALID";
}
if (!verified.authorized || !rejectsWrongName)
  throw Error("Target TLS verification failed");
const options = {
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  max: 1,
  prepare: false,
  ssl: { rejectUnauthorized: true },
  connect_timeout: 15,
  onnotice: () => {},
  connection: {
    application_name: "stonegate-migration-target-prepare",
    statement_timeout: 30000,
  },
};
const admin = postgres({ ...options, database: config.database });
try {
  const [identity] =
    await admin`select current_user as role,current_setting('server_version_num')::int as version`;
  if (identity.version < 170000 || identity.version >= 180000)
    throw Error("Expected PostgreSQL 17");
  const existing =
    await admin`select datname from pg_database where datname=${database}`;
  if (existing.length)
    throw Error(
      "Rehearsal database already exists; inspect it instead of resetting it",
    );
  await admin.unsafe(
    'CREATE DATABASE "stonegate_restore_20261116" TEMPLATE template0',
  );
} finally {
  await admin.end({ timeout: 2 });
}
const target = postgres({ ...options, database });
try {
  const [count] =
    await target`select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not like 'pg_%' and n.nspname<>'information_schema' and c.relkind in ('r','p')`;
  const extensions =
    await target`select extname,extversion from pg_extension order by extname`;
  if (count.count !== 0 || extensions.some((x) => x.extname !== "plpgsql"))
    throw Error("Unexpected nonempty target template");
  const record = {
    purpose: "empty-planetscale-rehearsal",
    provider: "planetscale",
    project: config.project,
    host: config.host,
    port: config.port,
    user: config.user,
    database,
    expiresAt: "2026-11-22T22:00:00Z",
    at: new Date().toISOString(),
    clientTls: verified,
    rejectsWrongCertificateName: rejectsWrongName,
    extensions,
  };
  await writeFile(
    path.join(directory, "planetscale-restore-target.json"),
    JSON.stringify(record, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      createdEmptyRehearsalDatabase: true,
      postgresMajor: 17,
      clientTlsVerified: verified.authorized,
      protocol: verified.protocol,
      wrongCertificateNameRejected: rejectsWrongName,
      applicationTables: count.count,
      extensions,
    }),
  );
} finally {
  await target.end({ timeout: 2 });
}

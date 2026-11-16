// Bounded concurrent business reads through the actual API and gateway. Uses a
// SELECT-only role on the recovery copy; no production keys or provider calls.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const credential = JSON.parse(
  await readFile(path.join(directory, "planetscale-readonly.json"), "utf8"),
);
if (
  credential.purpose !== "target-readiness-read-only" ||
  credential.database !== "stonegate_restore_20261116" ||
  credential.sqlRole !== "stonegate_target_probe_ro" ||
  !credential.host.endsWith(".psdb.cloud") ||
  Date.parse(credential.expiresAt) <= Date.now()
)
  throw Error("Wrong read-only recovery target");
const token = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const config = JSON.parse(
  await readFile(
    new URL(
      "../../infra/cloudflare/http-gateway/wrangler.api.jsonc",
      import.meta.url,
    ),
    "utf8",
  ),
);
const base = "https://stonegate-api-gateway-validation.jeffrey-78e.workers.dev";
if (
  config.vars.GATEWAY_HOST !== new URL(base).hostname ||
  config.vars.SERVICE_KIND !== "target-api"
)
  throw Error("Wrong gateway target");
const checks = [];
const samples = [];
const check = (name, pass, extra = {}) => {
  checks.push({ name, pass, ...extra });
  if (!pass) throw Error("CHECK_FAILED:" + name);
};
async function control(action, generation) {
  const r = await fetch(base + "/__gateway/" + action, {
    method: action === "status" ? "GET" : "POST",
    headers: {
      "x-migration-gateway-key": token,
      ...(generation ? { "x-stonegate-gateway-generation": generation } : {}),
    },
    signal: AbortSignal.timeout(150000),
  });
  return { status: r.status, body: await r.json() };
}
let owned = false;
try {
  const sql = postgres({
    host: credential.host,
    port: credential.port,
    username: credential.user,
    password: credential.password,
    database: credential.database,
    ssl: { rejectUnauthorized: true },
    max: 1,
    prepare: false,
    onnotice() {},
    connection: {
      statement_timeout: 15000,
      application_name: "stonegate-api-read-scope-check",
    },
  });
  try {
    const [scope] =
      await sql`select current_database() as database,current_user as role,current_setting('transaction_read_only') as read_only,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind in ('r','p') and has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')) as writable_tables`;
    check(
      "recovery-copy-enforces-select-only",
      scope.database === credential.database &&
        scope.role === credential.sqlRole &&
        scope.read_only === "on" &&
        scope.writable_tables === 0,
    );
  } finally {
    await sql.end({ timeout: 2 });
  }
  let state = await control("status");
  check(
    "private-api-starts-stopped",
    state.body.phase === "standby" && !state.body.running,
  );
  owned = true;
  state = await control("warm");
  check(
    "actual-api-ready-on-exact-image",
    state.status === 200 &&
      state.body.phase === "ready" &&
      state.body.image?.image === config.containers[0].images.base.image,
  );
  state = await control("activate", state.body.generation);
  check(
    "private-api-activated",
    state.status === 200 && state.body.phase === "active",
  );
  const routes = [
    "/api/admin/schedule/summary?range=this_week",
    "/api/admin/appointments/source-summary?rangeDays=90",
  ];
  for (const concurrency of [1, 4, 8]) {
    const current = [];
    for (let offset = 0; offset < 32; offset += concurrency) {
      const batch = await Promise.all(
        Array.from({ length: concurrency }, async (_, index) => {
          const route = routes[(offset + index) % routes.length];
          const started = performance.now();
          const r = await fetch(base + route, {
            headers: {
              "x-migration-gateway-key": token,
              "x-api-key": "isolated-target-gateway-synthetic-key-only",
              "x-actor-type": "worker",
              "x-actor-label": "sales-draft-prep",
            },
            signal: AbortSignal.timeout(20000),
          });
          const body = await r.json();
          // Customer details in the JSON response are discarded, never logged or
          // retained. Keep only success and aggregate timing/count metadata.
          return {
            concurrency,
            route: route.split("?")[0],
            status: r.status,
            pass: r.status === 200 && body.ok === true,
            ms: Math.round(performance.now() - started),
          };
        }),
      );
      samples.push(...batch);
      current.push(...batch);
      if (batch.some((x) => !x.pass)) break;
    }
    const durations = current.map((x) => x.ms).sort((a, b) => a - b);
    check(
      "concurrent-business-reads:" + concurrency,
      current.length === 32 && current.every((x) => x.pass),
      {
        requests: current.length,
        concurrency,
        p50Ms: durations[Math.floor(durations.length * 0.5)],
        p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
        maxMs: durations.at(-1),
      },
    );
  }
} catch (error) {
  checks.push({
    name: error.message?.startsWith("CHECK_FAILED:")
      ? error.message.slice(13)
      : "validation-failed",
    pass: false,
    error: error.name,
  });
  process.exitCode = 1;
} finally {
  if (owned) {
    const stopped = await control("drain").catch(() => null);
    checks.push({
      name: "private-api-drained-and-stopped",
      pass:
        stopped?.body.phase === "standby" && stopped?.body.running === false,
    });
  }
  const receipt = {
    at: new Date().toISOString(),
    ok: checks.every((x) => x.pass),
    image: config.containers[0].images.base.image,
    checks,
    samples,
    productionTouched: false,
    businessWrites: false,
    limitation:
      "Two business-read endpoints and the existing five-connection API pool; not a full mixed workload or peak-capacity proof",
  };
  await writeFile(
    path.join(directory, "target-api-read-validation-" + Date.now() + ".json"),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify({ ...receipt, samples: samples.length }));
  if (!receipt.ok) process.exitCode = 1;
}

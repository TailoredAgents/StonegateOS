import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Local browser rehearsal only. Do not inherit production/provider secrets
// from either the calling shell or Next's automatic .env loading.
const repo = fileURLToPath(new URL("../", import.meta.url));
const service = process.argv[2];
if (service !== "api" && service !== "site") throw Error("Choose api or site");
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
};
for (const directory of [repo, `${repo}apps/api`, `${repo}apps/site`]) {
  for (const name of readdirSync(directory).filter((value) =>
    /^\.env(?:\.|$)/u.test(value),
  )) {
    for (const line of readFileSync(`${directory}/${name}`, "utf8").split(
      "\n",
    )) {
      const key = line.match(
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u,
      )?.[1];
      if (key && !["HOME", "PATH", "TMPDIR"].includes(key))
        environment[key] = "";
    }
  }
}
Object.assign(environment, {
  NODE_ENV: "production",
  // Match the API package's production build heap; Site retains its local test budget.
  NODE_OPTIONS:
    service === "api"
      ? "--max-old-space-size=4096"
      : "--max-old-space-size=6144",
  NEXT_TELEMETRY_DISABLED: "1",
  DATABASE_URL:
    "postgresql://portal_test:portal_local_only@127.0.0.1:55443/portal_access_browser",
  DATABASE_SSL: "false",
  DOTENV_CONFIG_PATH: "/dev/null",
  PORT: service === "api" ? "3111" : "3110",
  SITE_URL: "https://localhost:3112",
  NEXT_PUBLIC_SITE_URL: "https://portal-access.example.test",
  API_BASE_URL: "http://localhost:3111",
  NEXT_PUBLIC_API_BASE_URL: "http://localhost:3111",
  ADMIN_API_KEY: "local-access-browser-only-administration-key",
  QUOTE_PUBLIC_TRUSTED_PROXY_HOPS: "1",
  QUOTE_RATE_LIMIT_HMAC_SECRET: "local-portal-release-rate-limit-secret-2026",
  QUOTE_PUBLIC_PROXY_SHARED_SECRET:
    "local-portal-release-proxy-secret-2026-distinct",
  TEAM_AUTH_RATE_LIMIT_SECRET:
    "local-portal-release-team-rate-limit-secret-2026",
  PARTNER_LOCATION_SECRET_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
  PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64: Buffer.alloc(32, 2).toString("base64"),
  E2E_RUN_ID: "partner-production-release-rehearsal",
  TEAM_CRM_AUDIT_MODE: "1",
  MEDIA_OBJECT_ENDPOINT: "http://127.0.0.1:14566",
  MEDIA_OBJECT_BUCKET: "partner-release-rehearsal",
  MEDIA_OBJECT_REGION: "us-east-1",
  MEDIA_OBJECT_ACCESS_KEY_ID: "test",
  MEDIA_OBJECT_SECRET_ACCESS_KEY: "test",
  MEDIA_OBJECT_FORCE_PATH_STYLE: "true",
  MEDIA_OBJECT_AUTO_CREATE_BUCKET: "false",
  PARTNER_PORTAL_V2_READS_ENABLED: "true",
  PARTNER_PORTAL_V2_WRITES_ENABLED: "true",
  PARTNER_PORTAL_PURPOSE_AUTH_ENABLED: "true",
  PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED: "true",
  PARTNER_PORTAL_ROUTINE_MAGIC_LOGIN_ENABLED: "false",
  PARTNER_PORTAL_INTERNAL_TEST_MODE: "false",
  PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED: "false",
  PARTNER_PORTAL_EMBEDDED_PAYMENTS_ENABLED: "false",
  PARTNER_PORTAL_EMBEDDED_ACH_ENABLED: "false",
  PARTNER_PORTAL_HOSTED_PAYMENTS_ENABLED: "false",
  // Invitations may enter the local outbox, but no worker or provider can run.
  TEAM_KILL_EXTERNAL_SENDS: "false",
  TEAM_KILL_OUTBOX_DISPATCH: "true",
  TEAM_KILL_FINANCIAL_MUTATIONS: "true",
  TEAM_KILL_DESTRUCTIVE_MUTATIONS: "true",
  TEAM_KILL_ADVERTISING_CHANGES: "true",
  TEAM_KILL_PUBLISHING: "true",
  RENDER: "false",
});
const cwd = `${repo}apps/${service}`;
const require = createRequire(`${cwd}/package.json`);
const dev = service === "api" && process.env.PARTNER_ACCESS_API_DEV === "1";
if (dev) environment.NODE_ENV = "development";
const build = process.argv[3] === "build";
const child = spawn(
  process.execPath,
  [
    require.resolve("next/dist/bin/next"),
    ...(build
      ? ["build", "--turbopack"]
      : [dev ? "dev" : "start", "-H", "127.0.0.1", "-p", environment.PORT!]),
  ],
  { cwd, env: environment, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});

// Explicit per-channel sends, constrained to privately recorded user destinations.
// Neither this client nor the durable controller retries an effectful attempt.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
const directory = process.argv[2];
const action = process.argv[3];
if (
  !directory ||
  ![
    "preflight",
    "sms",
    "email",
    "sms-status",
    "status",
    "stop",
    "verify-repeat-denied",
  ].includes(action)
)
  throw Error("Private directory and explicit provider trial action required");
const secrets = JSON.parse(
  await readFile(path.join(directory, "provider-live-secrets.json"), "utf8"),
);
const configuration = JSON.parse(secrets.MIGRATION_PROVIDER_CONFIG);
const destinations = JSON.parse(
  await readFile(
    path.join(directory, "authorized-test-destinations.json"),
    "utf8",
  ),
);
if (
  configuration.phone !== destinations.phone ||
  configuration.email !== destinations.email ||
  configuration.purpose !== "authorized-migration-deliveries"
)
  throw Error("Trial destinations differ from user authorization");
const source = await readFile(
  new URL("../../infra/cloudflare/providers/probe.ts", import.meta.url),
  "utf8",
);
const code = runInNewContext(
  source.slice(source.indexOf("String.raw`"), source.lastIndexOf(";")),
  {},
  { timeout: 1000 },
);
const hash = createHash("sha256").update(code).digest("hex");
const worker = JSON.parse(
  await readFile(
    new URL("../../infra/cloudflare/providers/wrangler.jsonc", import.meta.url),
    "utf8",
  ),
);
const origin = "https://stonegate-provider-validation.jeffrey-78e.workers.dev";
const checks = [];
const check = (name, pass, extra = {}) => {
  checks.push({ name, pass, ...extra });
  if (!pass) throw Error("CHECK_FAILED:" + name);
};
async function call(route, authorized = true) {
  const r = await fetch(origin + route, {
    method: route === "/status" ? "GET" : "POST",
    headers: authorized
      ? { authorization: "Bearer " + secrets.MIGRATION_PROBE_TOKEN }
      : {},
    signal: AbortSignal.timeout(160000),
  });
  return {
    status: r.status,
    probeMatches: r.headers.get("x-stonegate-provider-probe-sha256") === hash,
    body: await r.json(),
  };
}
let result;
try {
  const state = await call("/status");
  check(
    "exact-private-trial-and-image",
    state.status === 200 &&
      state.probeMatches &&
      state.body.runId === configuration.runId &&
      state.body.image === worker.containers[0].images.base.image,
  );
  if (action === "preflight") {
    check(
      "unauthenticated-send-denied",
      (await call("/send/sms", false)).status === 401,
    );
    check(
      "unrecognized-route-denied",
      (await call("/send/other")).status === 404,
    );
    if (!state.body.preflight && !state.body.sms && !state.body.email)
      check(
        "send-requires-successful-preflight",
        (await call("/send/email")).status === 409,
      );
  }
  if (["sms", "email"].includes(action)) {
    check("channel-never-attempted", state.body[action] === null);
    // If the local process or HTTP connection disappears, inspect provider and
    // durable status rather than invoke this send again.
    await writeFile(
      path.join(
        directory,
        "provider-" + configuration.runId + "-" + action + "-attempt.json",
      ),
      JSON.stringify({
        at: new Date().toISOString(),
        action,
        runId: configuration.runId,
        certainty: "not_yet_known",
      }),
      { mode: 0o600, flag: "wx" },
    );
    result = await call("/send/" + action);
    check(
      "provider-accepted-" + action,
      result.status === 200 &&
        result.probeMatches &&
        result.body.phase === "accepted",
      { phase: result.body.phase ?? "unknown" },
    );
  } else if (action === "verify-repeat-denied") {
    for (const channel of ["sms", "email"]) {
      check("existing-attempt-" + channel, Boolean(state.body[channel]));
      const rejected = await call("/send/" + channel);
      check(
        "repeat-denied-" + channel,
        rejected.status === 409 && rejected.body.error === "already_attempted",
      );
    }
    result = await call("/status");
  } else {
    result = action === "status" ? state : await call("/" + action);
    check(
      "trial-" + action,
      result.status === 200 &&
        result.probeMatches &&
        (action === "preflight"
          ? result.body.ok === true &&
            result.body.smtpVerified &&
            result.body.smsAccountActive
          : action === "stop"
            ? !result.body.running
            : true),
    );
  }
} catch (error) {
  checks.push({
    name: error.message?.startsWith("CHECK_FAILED:")
      ? error.message.slice(13)
      : "trial-request-failed",
    pass: false,
    error: error.name,
  });
  process.exitCode = 1;
} finally {
  const receipt = {
    at: new Date().toISOString(),
    runId: configuration.runId,
    action,
    checks,
    result,
    ok: checks.every((c) => c.pass),
    image: worker.containers[0].images.base.image,
  };
  await writeFile(
    path.join(
      directory,
      "provider-live-" + action + "-" + Date.now() + ".json",
    ),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      ...receipt,
      result: result
        ? {
            status: result.status,
            probeMatches: result.probeMatches,
            phase: result.body.phase,
            providerStatus: result.body.status,
            code: result.body.code ?? result.body.result?.code,
            error: result.body.error,
            smtpVerified: result.body.smtpVerified,
          }
        : null,
    }),
  );
}

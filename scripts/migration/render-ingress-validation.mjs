import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isIP } from "node:net";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const saved = JSON.parse(
  await readFile(path.join(directory, "render-ingress-service.json"), "utf8"),
);
let expectedRevision = saved.revision;
try {
  const expected = JSON.parse(
    await readFile(
      path.join(directory, "render-ingress-expected.json"),
      "utf8",
    ),
  );
  if (expected.serviceId !== saved.service.id)
    throw Error("Unexpected deployment identity");
  expectedRevision = expected.revision;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const credentials = JSON.parse(
  await readFile(
    path.join(directory, "render-ingress-credentials.json"),
    "utf8",
  ),
);
const operator = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const origin = saved.service.serviceDetails.url;
if (
  origin !== "https://stonegate-legacy-ingress-validation.onrender.com" ||
  saved.revision !== credentials.revision
)
  throw Error("Unexpected ingress fixture");
const target =
  "https://stonegate-http-gateway-validation.jeffrey-78e.workers.dev";
const webhooks = createRequire(
  new URL(
    "../../infra/cloudflare/webhook-journal/package.json",
    import.meta.url,
  ),
)("twilio/lib/webhooks/webhooks.js");
const checks = [];
const check = (name, pass, extra = {}) => {
  checks.push({ name, pass, ...extra });
  if (!pass) throw Error("CHECK_FAILED:" + name);
};
async function control(action, generation) {
  const r = await fetch(target + "/__gateway/" + action, {
    method: action === "status" ? "GET" : "POST",
    headers: {
      "x-migration-gateway-key": operator,
      ...(generation ? { "x-stonegate-gateway-generation": generation } : {}),
    },
    signal: AbortSignal.timeout(150000),
  });
  return { status: r.status, body: await r.json() };
}
async function call(route, init = {}, authenticated = true) {
  const headers = new Headers(init.headers);
  if (authenticated)
    headers.set("x-migration-ingress-key", credentials.ingressToken);
  return fetch(origin + route, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  const status = await promisify(execFile)(process.execPath, [
    "scripts/migration/render-ingress-rehearsal.mjs",
    directory,
    "status",
  ]);
  const deployed = JSON.parse(status.stdout);
  check(
    "exact-isolated-deployment-live-with-autodeploy-off",
    deployed.serviceId === saved.service.id &&
      deployed.deployment.revision === expectedRevision &&
      deployed.deployment.status === "live" &&
      deployed.autoDeploy === "off",
  );
  let state = await control("status");
  check(
    "cloudflare-fixture-starts-stopped",
    state.body.phase === "standby" && !state.body.running,
  );
  state = await control("warm");
  check(
    "fixture-ready-before-routing",
    state.status === 200 && state.body.phase === "ready",
  );
  state = await control("activate", state.body.generation);
  check(
    "fixture-activated",
    state.status === 200 && state.body.phase === "active",
  );
  let r = await call("/api/echo", {}, false);
  check("anonymous-public-forwarding-denied", r.status === 401);
  await r.arrayBuffer();
  r = await call("/__gateway/status");
  check("public-ingress-cannot-reach-controls", r.status === 404);
  await r.arrayBuffer();
  const direct = await fetch(target + "/api/echo", {
    headers: { "x-migration-gateway-key": operator },
    signal: AbortSignal.timeout(10000),
  });
  const directEcho = await direct.json();
  const expectedClient = directEcho.headers["cf-connecting-ip"];
  check(
    "independent-client-address-observed",
    direct.status === 200 && isIP(expectedClient) > 0,
  );
  r = await call("/api/echo");
  let echo = await r.json();
  await writeFile(
    path.join(
      directory,
      "render-ingress-address-observation-" + Date.now() + ".json",
    ),
    JSON.stringify({
      at: new Date().toISOString(),
      directStatus: direct.status,
      directClient: expectedClient,
      ingressStatus: r.status,
      error: echo.error,
      forwardedFor: echo.headers?.["x-forwarded-for"],
      cfConnectingIp: echo.headers?.["cf-connecting-ip"],
    }),
    { mode: 0o600, flag: "wx" },
  );
  check(
    "render-edge-preserves-original-client-address",
    r.status === 200 &&
      echo.headers?.["x-forwarded-for"] === expectedClient &&
      echo.headers?.["cf-connecting-ip"] === expectedClient,
    { status: r.status, error: echo.error },
  );
  for (const value of ["192.0.2.99", "spoofed", "192.0.2.1, 192.0.2.2"]) {
    r = await call("/api/echo", {
      headers: {
        "cf-connecting-ip": value,
        "x-forwarded-for": value,
        "x-real-ip": value,
        "x-migration-legacy-client-ip": value,
        "x-migration-legacy-key": "attacker",
        "x-migration-gateway-key": "attacker",
      },
    });
    echo = await r.json();
    check(
      "render-edge-overwrites-forged-client-address:" + value,
      r.status === 200 &&
        echo.headers["x-forwarded-for"] === expectedClient &&
        echo.headers["cf-connecting-ip"] === expectedClient,
    );
  }
  const route = "/api/webhooks/twilio/sms?original=%2f&value=one&value=two";
  const params = {
    Body: "synthetic snowman ☃",
    From: "+15555550100",
    MessageSid: "SM00000000000000000000000000000099",
  };
  const body = new URLSearchParams(params).toString();
  const secret = "synthetic-signature-only-no-provider-account";
  const signature = webhooks.getExpectedTwilioSignature(
    secret,
    "https://stonegate-api.onrender.com" + route,
    params,
  );
  r = await call(route, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
      authorization: "Bearer synthetic-app",
      cookie: "session=synthetic",
      origin: "https://foreign.invalid",
    },
  });
  echo = await r.json();
  check(
    "signed-callback-body-query-and-legacy-origin-preserved",
    r.status === 200 &&
      echo.url === route &&
      echo.sha256 === digest(body) &&
      echo.headers.host === "stonegate-api.onrender.com",
  );
  const signedUrl = "https://" + echo.headers.host + echo.url;
  check(
    "official-twilio-sdk-validates-after-public-proxy-chain",
    webhooks.validateRequest(
      secret,
      echo.headers["x-twilio-signature"],
      signedUrl,
      params,
    ),
  );
  check(
    "changed-query-remains-invalid-after-forwarding",
    !webhooks.validateRequest(
      secret,
      echo.headers["x-twilio-signature"],
      signedUrl.replace("value=one&value=two", "value=two&value=one"),
      params,
    ),
  );
  check(
    "app-auth-cookie-and-csrf-origin-preserved",
    echo.headers.authorization === "Bearer synthetic-app" &&
      echo.headers.cookie === "session=synthetic" &&
      echo.headers.origin === "https://foreign.invalid",
  );
  check(
    "all-ingress-forwarding-and-operator-secrets-removed",
    !Object.keys(echo.headers).some((name) => name.startsWith("x-migration-")),
  );
  const upload = Buffer.alloc(20 * 1024 * 1024, 42);
  r = await call("/api/upload", { method: "POST", body: upload });
  echo = await r.json();
  check(
    "public-proxy-chain-preserves-twenty-megabyte-upload",
    r.status === 200 &&
      echo.bytes === upload.length &&
      echo.sha256 === digest(upload),
  );
  r = await call("/api/cookies");
  check(
    "public-proxy-chain-retains-separate-cookies",
    r.headers.getSetCookie().length === 2,
  );
  await r.arrayBuffer();
  r = await call("/api/redirect");
  check(
    "public-proxy-chain-preserves-redirect",
    r.status === 307 && r.headers.get("location") === "/landing?next=%2Fteam",
  );
  await r.arrayBuffer();
  const started = performance.now();
  r = await call("/api/stream");
  const reader = r.body.getReader();
  const first = await reader.read();
  const firstMs = Math.round(performance.now() - started);
  check(
    "public-proxy-chain-streams-without-buffering",
    new TextDecoder().decode(first.value) === "data: first\n\n" &&
      firstMs < 1700,
    { firstMs },
  );
  let rest = "";
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    rest += new TextDecoder().decode(item.value);
  }
  check("public-stream-completes", rest === "data: second\n\n");
  r = await call("/api/lost-response", { method: "POST", body: "accepted" });
  check("ambiguous-public-write-fails-without-retry", r.status === 502);
  await r.arrayBuffer();
  await wait(500);
  r = await call("/api/counts");
  const counts = await r.json();
  check("public-write-executed-exactly-once", counts.mutations === 1);
} finally {
  try {
    const stopped = await promisify(execFile)(
      process.execPath,
      ["scripts/migration/render-ingress-rehearsal.mjs", directory, "suspend"],
      { timeout: 150000 },
    );
    const state = JSON.parse(stopped.stdout);
    check(
      "temporary-render-service-suspended-and-autodeploy-off",
      state.serviceId === saved.service.id &&
        state.suspended === "suspended" &&
        state.autoDeploy === "off",
    );
  } catch {
    checks.push({ name: "render-fixture-cleanup", pass: false });
  }
  try {
    const state = await control("drain");
    check(
      "cloudflare-fixture-stopped",
      state.status === 200 && !state.body.running,
    );
  } catch {
    checks.push({ name: "cloudflare-fixture-cleanup", pass: false });
  }
  const receipt = {
    at: new Date().toISOString(),
    serviceId: saved.service.id,
    revision: expectedRevision,
    checks,
    failures: checks.filter((x) => !x.pass).length,
    publicRenderIngressClientIpProven:
      checks.some(
        (x) =>
          x.name === "render-edge-preserves-original-client-address" && x.pass,
      ) &&
      checks
        .filter((x) => x.name.startsWith("render-edge-overwrites-forged"))
        .filter((x) => x.pass).length === 3,
    fixtureOnly: true,
    productionRoutingChanged: false,
    realProviderCredentialsUsed: false,
  };
  await writeFile(
    path.join(directory, "render-ingress-validation-" + Date.now() + ".json"),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.failures) process.exitCode = 1;
}

// Exercises a temporary loopback-only process on the current Render API host.
// SSH carries only the fixture credential, source code and lifecycle commands.
// The production API process, configuration, callbacks and database are untouched.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as wait } from "node:timers/promises";

const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const operator = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const { LEGACY_FORWARDER_TOKEN: token } = JSON.parse(
  await readFile(path.join(directory, "legacy-forwarder-secrets.json"), "utf8"),
);
const config = JSON.parse(
  await readFile(
    new URL(
      "../../infra/cloudflare/http-gateway/wrangler.jsonc",
      import.meta.url,
    ),
    "utf8",
  ),
);
const source = await readFile(
  new URL(
    "../../infra/cloudflare/legacy-api-forwarder/server.mjs",
    import.meta.url,
  ),
  "utf8",
);
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const target = "https://" + config.vars.GATEWAY_HOST;
if (
  target !== "https://stonegate-http-gateway-validation.jeffrey-78e.workers.dev"
)
  throw Error("Wrong fixture target");
const localOrigin = "http://127.0.0.1:17453";
const service = "srv-d43o7k0dl3ps73a4rhu0";
const sourceRevision = "0e66a789ea1c33b297aa5f1324571904c3fa2894";
const checks = [];
let cycle = 0,
  child,
  ready,
  remoteStop,
  remoteOutput = "",
  remoteError = "",
  childExit;
const check = (name, pass, extra = {}) => {
  checks.push({ cycle, name, pass, ...extra });
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
async function call(route, init = {}) {
  return fetch(localOrigin + route, {
    ...init,
    redirect: "manual",
    signal: init.signal ?? AbortSignal.timeout(30000),
  });
}
async function rawCall(route) {
  return new Promise((resolve, reject) => {
    const r = http.request(localOrigin, { path: route }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    r.once("error", reject);
    r.end();
  });
}
const loader = `
const readline=require('node:readline'),{createHash}=require('node:crypto');
const input=readline.createInterface({input:process.stdin});let instance,starting,stopping=false;
async function stop(){if(stopping)return;stopping=true;try{await starting;if(instance){const state=await instance.drain();console.log(JSON.stringify({event:'stopped',...state}));process.exit(state.forced?1:0);}else process.exit(1);}catch{process.exit(1);}}
input.on('line',line=>{if(line==='stop'){void stop();return;}if(starting)return;
starting=(async()=>{const config=JSON.parse(line);
if(process.env.RENDER_SERVICE_ID!==config.service||process.env.RENDER_GIT_COMMIT!==config.revision||process.version!=='v24.21.0')throw Error('SOURCE_IDENTITY_CHANGED');
const hash=createHash('sha256').update(config.source).digest('hex');if(hash!==config.sourceSha256)throw Error('SOURCE_HASH_MISMATCH');
for(const key of Object.keys(process.env))delete process.env[key];
const module=await import('data:text/javascript;base64,'+Buffer.from(config.source).toString('base64'));
instance=await module.runForwarder({STONEGATE_FORWARDER_MODE:'fixture',STONEGATE_FORWARDER_TARGET:config.target,STONEGATE_FORWARDER_TOKEN:config.token,PORT:'18087'});
console.log(JSON.stringify({event:'ready',sourceSha256:hash,node:process.version,revision:config.revision,service:config.service}));
})().catch(()=>{console.error('isolated_forwarder_start_failed');process.exit(1);});});
input.on('close',()=>void stop());process.once('SIGHUP',()=>void stop());
`;
async function startRemote() {
  ready = null;
  remoteStop = null;
  remoteOutput = "";
  remoteError = "";
  const command = "node -e " + "'" + loader.replaceAll("'", "'\\''") + "'";
  child = spawn(
    "ssh",
    [
      "-i",
      path.join(homedir(), ".ssh/stonegate_migration_20261115"),
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "127.0.0.1:17453:127.0.0.1:18087",
      service + "@ssh.virginia.render.com",
      command,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  childExit = once(child, "exit");
  child.stdout.on("data", (chunk) => {
    remoteOutput += chunk.toString();
    while (remoteOutput.includes("\n")) {
      const at = remoteOutput.indexOf("\n");
      const line = remoteOutput.slice(0, at);
      remoteOutput = remoteOutput.slice(at + 1);
      try {
        const event = JSON.parse(line);
        if (event.event === "ready") ready = event;
        if (event.event === "stopped") remoteStop = event;
      } catch {}
    }
  });
  child.stderr.on("data", (chunk) => {
    if (remoteError.length < 2000) remoteError += chunk.toString();
  });
  child.stdin.on("error", () => {});
  child.stdin.write(
    JSON.stringify({
      service,
      revision: sourceRevision,
      source,
      sourceSha256,
      target,
      token,
    }) + "\n",
  );
  for (let i = 0; i < 150 && !ready && child.exitCode === null; i++)
    await wait(100);
  check(
    "isolated-render-process-exact-runtime-and-source",
    ready?.sourceSha256 === sourceSha256 &&
      ready.node === "v24.21.0" &&
      ready.revision === sourceRevision &&
      ready.service === service,
  );
}
async function stopRemote() {
  if (!child) return;
  if (child.exitCode === null) child.stdin.write("stop\n");
  const result = await Promise.race([
    childExit,
    wait(30000, undefined, { ref: false }).then(() => null),
  ]);
  if (!result) {
    child.stdin.end();
    child.kill("SIGTERM");
    throw Error("REMOTE_STOP_UNCONFIRMED");
  }
  check(
    "temporary-render-forwarder-drained-and-exited",
    result[0] === 0 &&
      remoteStop?.stopped &&
      !remoteStop.forced &&
      remoteStop.pending === 0,
  );
  child = undefined;
}

try {
  for (cycle = 1; cycle <= 2; cycle++) {
    let state = await control("status");
    check(
      "fixture-starts-stopped",
      state.body.phase === "standby" && !state.body.running,
    );
    state = await control("warm");
    check(
      "exact-fixture-image-ready",
      state.status === 200 &&
        state.body.phase === "ready" &&
        state.body.image?.image === config.containers[0].images.base.image,
    );
    state = await control("activate", state.body.generation);
    check(
      "fixture-activated",
      state.status === 200 && state.body.phase === "active",
    );
    await startRemote();
    let denied = await fetch(target + "/__gateway/drain", {
      method: "POST",
      headers: {
        "x-migration-legacy-key": token,
        "x-migration-legacy-client-ip": "127.0.0.1",
      },
    });
    check("forwarding-key-cannot-control-gateway", denied.status === 401);
    await denied.arrayBuffer();
    denied = await fetch(target + "/api/echo", {
      headers: {
        "x-migration-legacy-key": "wrong",
        "x-migration-legacy-client-ip": "127.0.0.1",
      },
    });
    check("wrong-forwarding-key-denied", denied.status === 401);
    await denied.arrayBuffer();
    for (const route of [
      "/__gateway/status",
      "/api/../__gateway/drain",
      "/api/%2e%2e/__gateway/warm",
      "//attacker.invalid/api/echo",
    ])
      check(
        "control-or-normalized-path-denied:" + route,
        (await rawCall(route)) === 404,
      );
    const bytes = Buffer.from(
      "Body=snowman+%E2%98%83&From=%2B15555550100&MessageSid=synthetic",
    );
    const route = "/api/echo?duplicate=one&duplicate=two&encoded=%2f";
    let r = await call(route, {
      method: "POST",
      body: bytes,
      headers: {
        authorization: "Bearer synthetic-application",
        cookie: "session=synthetic",
        origin: "https://foreign.invalid",
        "x-twilio-signature": "unchanged-synthetic-signature",
        "next-action": "unchanged-action",
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "spoofed",
        "cf-connecting-ip": "spoofed",
        "x-migration-gateway-key": "attacker",
        "x-migration-legacy-client-ip": "192.0.2.90",
      },
    });
    let echo = await r.json();
    check(
      "render-to-cloudflare-preserves-exact-body-and-query",
      r.status === 200 &&
        echo.url === route &&
        echo.method === "POST" &&
        echo.bytes === bytes.length &&
        echo.sha256 === createHash("sha256").update(bytes).digest("hex"),
    );
    check(
      "application-auth-cookie-origin-and-signature-preserved",
      echo.headers.authorization === "Bearer synthetic-application" &&
        echo.headers.cookie === "session=synthetic" &&
        echo.headers.origin === "https://foreign.invalid" &&
        echo.headers["x-twilio-signature"] ===
          "unchanged-synthetic-signature" &&
        echo.headers["next-action"] === "unchanged-action",
    );
    check(
      "legacy-origin-and-verified-proxy-client-identity",
      echo.headers.host === "stonegate-api.onrender.com" &&
        echo.headers["x-forwarded-host"] === "stonegate-api.onrender.com" &&
        echo.headers["x-forwarded-proto"] === "https" &&
        echo.headers["x-forwarded-for"] === "127.0.0.1",
    );
    check(
      "neither-forwarding-nor-control-secrets-reach-application",
      !Object.keys(echo.headers).some((key) => key.startsWith("x-migration-")),
    );
    r = await call("/api/redirect");
    check(
      "redirect-not-followed",
      r.status === 307 && r.headers.get("location") === "/landing?next=%2Fteam",
    );
    await r.arrayBuffer();
    r = await call("/api/cookies");
    check(
      "separate-secure-cookies-preserved",
      r.headers.getSetCookie().length === 2 &&
        r.headers.getSetCookie().every((value) => value.includes("Secure")),
    );
    await r.arrayBuffer();
    r = await call("/api/empty");
    check(
      "empty-response-preserved",
      r.status === 204 && (await r.arrayBuffer()).byteLength === 0,
    );
    const upload = Buffer.alloc(20 * 1024 * 1024, 42);
    r = await call("/api/upload", { method: "POST", body: upload });
    echo = await r.json();
    check(
      "twenty-megabyte-upload-exact-through-both-hops",
      echo.bytes === upload.length &&
        echo.sha256 === createHash("sha256").update(upload).digest("hex"),
    );
    const started = performance.now();
    r = await call("/api/stream");
    const reader = r.body.getReader();
    const first = await reader.read();
    const firstMs = Math.round(performance.now() - started);
    check(
      "first-chunk-arrives-before-stream-completes",
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
    check("stream-finishes-intact", rest === "data: second\n\n");
    r = await call("/api/lost-response", { method: "POST", body: "accepted" });
    check("lost-write-response-fails-without-retry", r.status === 502);
    await r.arrayBuffer();
    r = await call("/api/counts");
    let counts = await r.json();
    check("ambiguous-write-executed-once", counts.mutations === 1);
    const slow = call("/api/slow-write", {
      method: "POST",
      body: "accepted-before-drain",
    });
    await wait(600);
    const stopped = stopRemote();
    r = await slow;
    const committed = await r.json();
    check(
      "accepted-write-completes-through-forwarder-drain",
      r.status === 200 &&
        committed.committed === true &&
        committed.slowWrites === 1,
    );
    await stopped;
    state = await control("drain");
    check(
      "fixture-final-stopped-state",
      state.status === 200 &&
        !state.body.running &&
        state.body.phase === "standby",
    );
  }
} finally {
  if (child) {
    try {
      await stopRemote();
    } catch {
      checks.push({ cycle, name: "remote-cleanup", pass: false });
    }
  }
  try {
    const state = await control("drain");
    check(
      "cloudflare-final-cleanup",
      state.status === 200 && !state.body.running,
    );
  } catch {
    checks.push({ cycle, name: "cloudflare-cleanup", pass: false });
  }
  const receipt = {
    at: new Date().toISOString(),
    sourceSha256,
    sourceRevision,
    checks,
    failures: checks.filter((x) => !x.pass).length,
    loopbackOnlyRenderProcess: true,
    fixtureOnly: true,
    productionRoutingChanged: false,
    publicRenderIngressClientIpProven: false,
  };
  await writeFile(
    path.join(directory, `legacy-forwarder-validation-${Date.now()}.json`),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.failures) process.exitCode = 1;
}

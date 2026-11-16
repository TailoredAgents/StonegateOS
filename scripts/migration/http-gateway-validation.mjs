import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const token = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const config = JSON.parse(
  await readFile(
    new URL(
      "../../infra/cloudflare/http-gateway/wrangler.jsonc",
      import.meta.url,
    ),
    "utf8",
  ),
);
const base = "https://" + config.vars.GATEWAY_HOST;
const expectedImage = config.containers[0].images.base.image;
const checks = [];
let cycle = 0;
function check(name, pass, extra = {}) {
  checks.push({ cycle, name, pass, ...extra });
  if (!pass) throw Error("Gateway check failed: " + name);
}
async function call(route, init = {}, auth = true) {
  const headers = new Headers(init.headers);
  if (auth) headers.set("x-migration-gateway-key", token);
  return fetch(base + route, {
    ...init,
    headers,
    redirect: "manual",
    signal: init.signal ?? AbortSignal.timeout(150000),
  });
}
async function control(action, generation) {
  const r = await call("/__gateway/" + action, {
    method: action === "status" ? "GET" : "POST",
    headers: generation ? { "x-stonegate-gateway-generation": generation } : {},
  });
  return { status: r.status, body: await r.json() };
}
try {
  for (cycle = 1; cycle <= 2; cycle++) {
    let r = await call("/echo", {}, false);
    await r.body?.cancel();
    check("anonymous-rejected", r.status === 401);
    let state = await control("status");
    check(
      "starts-stopped",
      state.body.phase === "standby" && state.body.running === false,
    );
    r = await call("/echo");
    await r.body?.cancel();
    check("standby-blocks-traffic", r.status === 503);
    const started = performance.now();
    state = await control("warm");
    check(
      "warm-before-routing",
      state.status === 200 &&
        state.body.phase === "ready" &&
        state.body.image?.image === expectedImage,
      { ms: Math.round(performance.now() - started) },
    );
    const generation = state.body.generation;
    r = await call("/echo");
    await r.body?.cancel();
    check("ready-still-blocks-traffic", r.status === 503);
    state = await control("activate", "stale-generation");
    check("stale-activation-rejected", state.status === 409);
    state = await control("activate", generation);
    check(
      "explicit-activation",
      state.status === 200 && state.body.phase === "active",
    );
    const bytes = Buffer.from('{"signed":"☃","amount":123}\n');
    r = await call("/echo?duplicate=one&duplicate=two&encoded=%2F", {
      method: "POST",
      body: bytes,
      headers: {
        authorization: "Bearer synthetic-application-auth",
        cookie: "myst-team-session=synthetic",
        origin: "https://untrusted.invalid",
        "content-type": "application/json",
        "next-action": "synthetic-action",
        "x-forwarded-host": "untrusted.invalid",
        "x-forwarded-proto": "http",
        "x-forwarded-for": "spoofed",
        forwarded: "host=untrusted.invalid",
      },
    });
    let echo = await r.json();
    check(
      "signed-request-bytes-preserved",
      r.status === 200 &&
        echo.bytes === bytes.length &&
        echo.sha256 === createHash("sha256").update(bytes).digest("hex"),
    );
    check(
      "method-query-auth-cookie-action-preserved",
      echo.method === "POST" &&
        echo.url === "/echo?duplicate=one&duplicate=two&encoded=%2F" &&
        echo.headers.authorization === "Bearer synthetic-application-auth" &&
        echo.headers.cookie === "myst-team-session=synthetic" &&
        echo.headers["next-action"] === "synthetic-action",
    );
    check(
      "origin-preserved-for-csrf",
      echo.headers.origin === "https://untrusted.invalid",
    );
    check(
      "forwarded-host-cannot-be-spoofed",
      echo.headers.host === config.vars.GATEWAY_HOST &&
        echo.headers["x-forwarded-host"] === config.vars.GATEWAY_HOST &&
        echo.headers["x-forwarded-proto"] === "https" &&
        echo.headers["x-forwarded-for"] !== "spoofed" &&
        !echo.headers.forwarded,
    );
    check(
      "gateway-secret-not-forwarded",
      !echo.headers["x-migration-gateway-key"],
    );
    r = await call("/redirect");
    await r.body?.cancel();
    check(
      "redirect-not-followed",
      r.status === 307 && r.headers.get("location") === "/landing?next=%2Fteam",
    );
    r = await call("/cookies");
    await r.body?.cancel();
    check(
      "separate-secure-cookies-preserved",
      r.headers.getSetCookie().length === 2 &&
        r.headers.getSetCookie().some((x) => x.includes("HttpOnly")),
    );
    r = await call("/empty");
    check(
      "empty-response-preserved",
      r.status === 204 && (await r.text()) === "",
    );
    const upload = Buffer.alloc(20 * 1024 * 1024, 0x6a);
    r = await call("/upload", {
      method: "PUT",
      body: upload,
      headers: { "content-type": "application/octet-stream" },
    });
    echo = await r.json();
    check(
      "twenty-megabyte-upload-exact",
      r.status === 200 &&
        echo.bytes === upload.length &&
        echo.sha256 === createHash("sha256").update(upload).digest("hex"),
    );
    const streamStarted = performance.now();
    r = await call("/stream");
    const reader = r.body.getReader();
    const first = await reader.read();
    const firstMs = Math.round(performance.now() - streamStarted);
    check(
      "first-chunk-streams-before-completion",
      new TextDecoder().decode(first.value) === "data: first\n\n",
      { firstMs },
    );
    let remainder = "";
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      remainder += new TextDecoder().decode(item.value);
    }
    check("stream-finishes-intact", remainder === "data: second\n\n", {
      totalMs: Math.round(performance.now() - streamStarted),
    });
    r = await call("/lost-response", {
      method: "POST",
      body: "synthetic mutation",
    });
    await r.body?.cancel();
    check("lost-write-response-fails-closed", r.status === 502);
    r = await call("/counts");
    echo = await r.json();
    check("ambiguous-mutation-was-not-retried", echo.mutations === 1);
    const slow = call("/slow-write", {
      method: "POST",
      body: "synthetic slow mutation",
    });
    let accepted = false;
    for (let i = 0; i < 30; i++) {
      state = await control("status");
      if (state.body.inFlight > 0) {
        accepted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check("accepted-write-visible-before-drain", accepted);
    const draining = control("drain");
    for (let i = 0; i < 30; i++) {
      state = await control("status");
      if (state.body.phase === "draining") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    r = await call("/echo");
    await r.body?.cancel();
    check("drain-stops-new-admission", r.status === 503);
    const committed = await (await slow).json();
    check(
      "accepted-write-completes-during-drain",
      committed.committed === true && committed.slowWrites === 1,
    );
    state = await draining;
    check(
      "graceful-drain-stops-container",
      state.status === 200 &&
        state.body.drained === true &&
        state.body.running === false,
    );
    state = await control("status");
    check(
      "stopped-lease-cleared-no-inflight",
      state.body.phase === "standby" &&
        state.body.running === false &&
        state.body.lease === 0 &&
        state.body.inFlight === 0,
    );
  }
} catch (error) {
  checks.push({
    cycle,
    name: "trial-failed",
    pass: false,
    error: error.message,
  });
  process.exitCode = 1;
} finally {
  try {
    const stopped = await control("drain");
    if (!stopped.body.drained) {
      checks.push({ name: "cleanup-incomplete", pass: false });
      process.exitCode = 1;
    }
  } catch {
    checks.push({ name: "cleanup-failed", pass: false });
    process.exitCode = 1;
  }
}
const receipt = {
  at: new Date().toISOString(),
  ok: checks.every((x) => x.pass),
  checks,
};
await writeFile(
  path.join(directory, `http-gateway-validation-${Date.now()}.json`),
  JSON.stringify(receipt, null, 2),
  { mode: 0o600, flag: "wx" },
);
console.log(JSON.stringify(receipt));

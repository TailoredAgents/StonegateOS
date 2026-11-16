import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash, createHmac } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import {
  createForwarder,
  runForwarder,
} from "../../infra/cloudflare/legacy-api-forwarder/server.mjs";
import {
  legacyForwardedRequest,
  upstreamRequest,
} from "../../infra/cloudflare/http-gateway/proxy.mjs";

const token = "synthetic-legacy-forwarder-credential-only";
test("public ingress fixture requires its separate admission key before forwarding", async (t) => {
  let count = 0;
  const proxy = await setup(
    t,
    (_request, response) => {
      count++;
      response.end("ok");
    },
    { ingressToken: token },
  );
  for (const headers of [{}, { "x-migration-ingress-key": "wrong" }])
    assert.equal(await rawCall(proxy.origin, "/api/test", headers), 401);
  assert.equal(await rawCall(proxy.origin, "/_forwarder/ingress"), 401);
  assert.equal(count, 0);
  assert.equal(await rawCall(proxy.origin, "/_forwarder/healthz"), 200);
  assert.equal(count, 0);
  assert.equal(
    await rawCall(proxy.origin, "/api/test", {
      "x-migration-ingress-key": token,
    }),
    200,
  );
  assert.equal(count, 1);
});
async function setup(t, handler, extra = {}) {
  const upstream = http.createServer(handler);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = createForwarder({
    target: `http://127.0.0.1:${upstream.address().port}`,
    token,
    allowLoopback: true,
    ...extra,
  });
  proxy.server.listen(0, "127.0.0.1");
  await once(proxy.server, "listening");
  t.after(async () => {
    await proxy.drain(200);
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  return {
    ...proxy,
    origin: `http://127.0.0.1:${proxy.server.address().port}`,
  };
}
function rawCall(origin, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(origin, { path, headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

test("legacy proxy preserves exact signed bytes, query, authorization, cookies and CSRF origin", async (t) => {
  const data = "Body=snowman+%E2%98%83&From=%2B15555550100&Body=second";
  const route = "/api/webhooks/twilio/sms?b=%2f&b=two&a=%2B";
  const signature = createHmac("sha1", "synthetic-provider-key")
    .update("https://stonegate-api.onrender.com" + route + data)
    .digest("base64");
  const proxy = await setup(t, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        path: request.url,
        method: request.method,
        headers: request.headers,
        body,
      }),
    );
  });
  const response = await fetch(proxy.origin + route, {
    method: "POST",
    body: data,
    headers: {
      "x-twilio-signature": signature,
      authorization: "Bearer app-token",
      cookie: "session=unchanged",
      origin: "https://foreign.invalid",
      "x-migration-legacy-key": "attacker",
      "x-migration-legacy-client-ip": "192.0.2.99",
      "x-forwarded-for": "spoofed",
      "cf-connecting-ip": "spoofed",
      "x-migration-gateway-key": "attacker-control",
    },
  });
  const result = await response.json();
  assert.equal(result.path, route);
  assert.equal(result.body, data);
  assert.equal(result.method, "POST");
  assert.equal(result.headers["x-twilio-signature"], signature);
  assert.equal(result.headers.authorization, "Bearer app-token");
  assert.equal(result.headers.cookie, "session=unchanged");
  assert.equal(result.headers.origin, "https://foreign.invalid");
  assert.equal(result.headers["x-migration-legacy-key"], token);
  assert.equal(result.headers["x-migration-legacy-client-ip"], "127.0.0.1");
  for (const name of [
    "x-forwarded-for",
    "cf-connecting-ip",
    "x-migration-gateway-key",
  ])
    assert.equal(result.headers[name], undefined);
});

test("legacy credential admits only API traffic and strips all ingress secrets before the application", async () => {
  const make = (path, key = token, ip = "192.0.2.4") =>
    new Request("https://worker.example" + path, {
      headers: {
        "x-migration-legacy-key": key,
        "x-migration-legacy-client-ip": ip,
        "x-forwarded-host": "attacker.invalid",
        "cf-connecting-ip": "198.51.100.2",
        "x-migration-gateway-key": "attacker",
        origin: "https://foreign.invalid",
      },
    });
  assert.equal(legacyForwardedRequest(make("/__gateway/drain"), token), null);
  assert.equal(
    legacyForwardedRequest(make("/api/../__gateway/drain"), token),
    null,
  );
  assert.equal(legacyForwardedRequest(make("/api/test", "wrong"), token), null);
  assert.equal(
    legacyForwardedRequest(
      make("/api/test", token, "192.0.2.4, 198.51.100.3"),
      token,
    ),
    null,
  );
  assert.equal(legacyForwardedRequest(make("/api/test"), undefined), null);
  const forwarded = upstreamRequest(
    legacyForwardedRequest(make("/api/test?a=%2f&a=two"), token),
  );
  assert.equal(
    forwarded.url,
    "http://stonegate-api.onrender.com/api/test?a=%2f&a=two",
  );
  assert.equal(forwarded.headers.get("host"), "stonegate-api.onrender.com");
  assert.equal(forwarded.headers.get("x-forwarded-for"), "192.0.2.4");
  assert.equal(forwarded.headers.get("origin"), "https://foreign.invalid");
  for (const name of forwarded.headers.keys())
    assert.ok(!name.startsWith("x-migration-"));
});

test("control paths, normalization and arbitrary targets never reach the upstream", async (t) => {
  let count = 0;
  const proxy = await setup(t, (_request, response) => {
    count++;
    response.end();
  });
  for (const path of [
    "/__gateway/status",
    "/api/../__gateway/drain",
    "/api/%2e%2e/__gateway/warm",
    "//attacker.invalid/api/test",
    "https://attacker.invalid/api/test",
    "/api/test#fragment",
  ])
    assert.equal(await rawCall(proxy.origin, path), 404);
  assert.equal(count, 0);
  await assert.rejects(
    runForwarder({
      STONEGATE_FORWARDER_MODE: "production",
      STONEGATE_FORWARDER_TARGET: "https://attacker.invalid",
      STONEGATE_FORWARDER_TOKEN: token,
    }),
    /UNAPPROVED_FORWARDER_TARGET/,
  );
  assert.throws(
    () => createForwarder({ target: "http://127.0.0.1", token }),
    /INVALID_FORWARDER_CONFIGURATION/,
  );
});

test("response streaming, distinct cookies, redirects and 20 MiB request bodies remain intact", async (t) => {
  const proxy = await setup(t, async (request, response) => {
    if (request.url === "/api/stream") {
      response.writeHead(200);
      response.write("first");
      await wait(400);
      response.end("second");
      return;
    }
    if (request.url === "/api/redirect") {
      response.writeHead(307, {
        location: "/api/next?q=%2F",
        "set-cookie": ["one=a; Secure; HttpOnly", "two=b; Secure"],
      });
      response.end();
      return;
    }
    let bytes = 0;
    const hash = createHash("sha256");
    for await (const chunk of request) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    response.end(JSON.stringify({ bytes, sha256: hash.digest("hex") }));
  });
  const redirect = await fetch(proxy.origin + "/api/redirect", {
    redirect: "manual",
  });
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get("location"), "/api/next?q=%2F");
  assert.deepEqual(redirect.headers.getSetCookie(), [
    "one=a; Secure; HttpOnly",
    "two=b; Secure",
  ]);
  await redirect.arrayBuffer();
  const stream = await fetch(proxy.origin + "/api/stream");
  const reader = stream.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  assert.equal(new TextDecoder().decode((await reader.read()).value), "second");
  assert.ok((await reader.read()).done);
  const body = Buffer.alloc(20 * 1024 * 1024, 42);
  const upload = await fetch(proxy.origin + "/api/upload", {
    method: "POST",
    body,
  });
  assert.deepEqual(await upload.json(), {
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
});

test("a lost response or deadline never retries an accepted write", async (t) => {
  let committed = 0;
  const proxy = await setup(
    t,
    (request, response) => {
      committed++;
      if (request.url === "/api/lost") request.socket.destroy();
      else setTimeout(() => response.end("late"), 400).unref();
    },
    { timeoutMs: 150 },
  );
  const lost = await fetch(proxy.origin + "/api/lost", {
    method: "POST",
    body: "write",
  });
  assert.equal(lost.status, 502);
  await lost.arrayBuffer();
  await wait(200);
  assert.equal(committed, 1);
  const timeout = await fetch(proxy.origin + "/api/slow", {
    method: "POST",
    body: "write",
  });
  assert.equal(timeout.status, 504);
  await timeout.arrayBuffer();
  await wait(450);
  assert.equal(committed, 2);
});

test("graceful drain completes the accepted write before closing", async (t) => {
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let committed = 0;
  const proxy = await setup(t, async (_request, response) => {
    enter();
    await wait(200);
    committed++;
    response.end("committed");
  });
  const pending = fetch(proxy.origin + "/api/slow", {
    method: "POST",
    body: "write",
  });
  await entered;
  const drained = proxy.drain(1000);
  assert.equal(proxy.state().accepting, false);
  assert.equal(await (await pending).text(), "committed");
  assert.deepEqual(await drained, { stopped: true, forced: false, pending: 0 });
  assert.equal(committed, 1);
});

test("unverified or malformed trusted-edge client identity fails closed", async (t) => {
  let count = 0;
  const proxy = await setup(
    t,
    (_request, response) => {
      count++;
      response.end();
    },
    { clientIpHeader: "cf-connecting-ip" },
  );
  for (const headers of [
    {},
    { "cf-connecting-ip": "spoofed" },
    { "cf-connecting-ip": "192.0.2.1, 192.0.2.2" },
  ])
    assert.equal(await rawCall(proxy.origin, "/api/test", headers), 400);
  assert.equal(count, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  upstreamRequest,
  trackedResponse,
} from "../../infra/cloudflare/http-gateway/proxy.mjs";

test("proxy preserves auth, CSRF origin and signed bytes while replacing spoofed forwarding headers", async () => {
  const bytes = Buffer.from('{"amount":1,"unicode":"☃"}\n');
  const r = upstreamRequest(
    new Request("https://stonegate.example/api/write?x=%2F&x=two", {
      method: "POST",
      body: bytes,
      headers: {
        origin: "https://attacker.invalid",
        authorization: "Bearer application-token",
        cookie: "session=synthetic",
        "next-action": "action-id",
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "http",
        "x-forwarded-for": "spoofed",
        "cf-connecting-ip": "192.0.2.1",
        forwarded: "host=attacker.invalid",
        "x-migration-gateway-key": "probe-secret",
        connection: "x-hop",
        "x-hop": "remove-me",
      },
    }),
  );
  assert.equal(r.url, "http://stonegate.example/api/write?x=%2F&x=two");
  assert.equal(r.redirect, "manual");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
  assert.equal(r.headers.get("origin"), "https://attacker.invalid");
  assert.equal(r.headers.get("authorization"), "Bearer application-token");
  assert.equal(r.headers.get("cookie"), "session=synthetic");
  assert.equal(r.headers.get("next-action"), "action-id");
  assert.equal(r.headers.get("host"), "stonegate.example");
  assert.equal(r.headers.get("x-forwarded-host"), "stonegate.example");
  assert.equal(r.headers.get("x-forwarded-proto"), "https");
  assert.equal(r.headers.get("x-forwarded-for"), "192.0.2.1");
  for (const header of [
    "forwarded",
    "x-migration-gateway-key",
    "connection",
    "x-hop",
  ])
    assert.equal(r.headers.get(header), null);
});

test("response stays streaming and retains separate cookies; drain completion waits for EOF", async () => {
  let source;
  let completed = 0;
  const upstream = new ReadableStream({
    start(c) {
      source = c;
    },
  });
  const headers = new Headers();
  headers.append("set-cookie", "a=1; Path=/");
  headers.append("set-cookie", "b=2; Path=/");
  const r = trackedResponse(
    new Response(upstream, { headers }),
    () => completed++,
  );
  assert.equal(completed, 0);
  assert.deepEqual(r.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
  const reader = r.body.getReader();
  source.enqueue(new Uint8Array([1]));
  assert.deepEqual((await reader.read()).value, new Uint8Array([1]));
  assert.equal(completed, 0);
  source.enqueue(new Uint8Array([2]));
  source.close();
  assert.deepEqual((await reader.read()).value, new Uint8Array([2]));
  assert.equal((await reader.read()).done, true);
  assert.equal(completed, 1);
});

test("cancelled, empty and failed streams release drain accounting exactly once", async () => {
  let completed = 0;
  let cancelled = 0;
  const r = trackedResponse(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    ),
    () => completed++,
  );
  await r.body.cancel();
  assert.equal(completed, 1);
  assert.equal(cancelled, 1);
  assert.equal(
    trackedResponse(new Response(null, { status: 204 }), () => completed++)
      .status,
    204,
  );
  assert.equal(completed, 2);
  const failed = trackedResponse(
    new Response(
      new ReadableStream({
        start(c) {
          c.error(Error("lost stream"));
        },
      }),
    ),
    () => completed++,
  );
  await assert.rejects(failed.text(), /lost stream/);
  assert.equal(completed, 3);
});

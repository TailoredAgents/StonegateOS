import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import {
  QUOTE_PUBLIC_NETWORK_KEY_HEADER,
  QUOTE_PUBLIC_NETWORK_SIGNATURE_HEADER,
  QUOTE_PUBLIC_NETWORK_TIMESTAMP_HEADER,
  quotePublicProxyNetworkHeaders,
} from "../src/lib/quote-public-proxy-network";

const RATE_SECRET = "site-test-quote-rate-limit-secret-at-least-32-bytes";
const PROXY_SECRET = "site-test-quote-proxy-secret-at-least-32-bytes";
const original = {
  rate: process.env["QUOTE_RATE_LIMIT_HMAC_SECRET"],
  proxy: process.env["QUOTE_PUBLIC_PROXY_SHARED_SECRET"],
  hops: process.env["QUOTE_PUBLIC_TRUSTED_PROXY_HOPS"],
};

before(() => {
  process.env["QUOTE_RATE_LIMIT_HMAC_SECRET"] = RATE_SECRET;
  process.env["QUOTE_PUBLIC_PROXY_SHARED_SECRET"] = PROXY_SECRET;
  process.env["QUOTE_PUBLIC_TRUSTED_PROXY_HOPS"] = "1";
});

after(() => {
  for (const [name, value] of Object.entries({
    QUOTE_RATE_LIMIT_HMAC_SECRET: original.rate,
    QUOTE_PUBLIC_PROXY_SHARED_SECRET: original.proxy,
    QUOTE_PUBLIC_TRUSTED_PROXY_HOPS: original.hops,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

void test("signs the exact upstream method/path and never forwards an address", () => {
  const target = new URL(
    `https://api.example.test/api/public/quotes/${"a".repeat(43)}/changes`,
  );
  const now = new Date("2026-08-31T12:00:00.000Z");
  const signed = quotePublicProxyNetworkHeaders(
    {
      method: "POST",
      headers: new Headers({
        "x-forwarded-for": "198.51.100.99, 203.0.113.42",
      }),
    },
    target,
    now,
  );
  const key = signed[QUOTE_PUBLIC_NETWORK_KEY_HEADER]!;
  const timestamp = signed[QUOTE_PUBLIC_NETWORK_TIMESTAMP_HEADER]!;
  const expectedSignature = createHmac("sha256", PROXY_SECRET)
    .update(
      [
        "quote-v2-public-network-v1",
        timestamp,
        "POST",
        target.pathname,
        key,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
  assert.equal(signed[QUOTE_PUBLIC_NETWORK_SIGNATURE_HEADER], expectedSignature);
  assert.match(key, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(signed), /203\.0\.113\.42|198\.51\.100\.99/u);
});

void test("a rotating caller-supplied left hop keeps the same trusted network key", () => {
  const target = new URL(
    `https://api.example.test/api/public/quotes/${"a".repeat(43)}`,
  );
  const first = quotePublicProxyNetworkHeaders(
    {
      method: "GET",
      headers: new Headers({
        "x-forwarded-for": "192.0.2.1, 203.0.113.42",
      }),
    },
    target,
  );
  const rotated = quotePublicProxyNetworkHeaders(
    {
      method: "GET",
      headers: new Headers({
        "x-forwarded-for": "198.51.100.200, 203.0.113.42",
      }),
    },
    target,
  );
  assert.equal(
    first[QUOTE_PUBLIC_NETWORK_KEY_HEADER],
    rotated[QUOTE_PUBLIC_NETWORK_KEY_HEADER],
  );
});

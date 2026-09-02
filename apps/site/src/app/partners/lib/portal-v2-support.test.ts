import assert from "node:assert/strict";
import test from "node:test";
import {
  partnerPortalFetch,
  portalSupportReference,
  readPortalV2Response,
  withPortalSupportReference,
} from "./portal-v2";

void test("uses only bounded support references and never duplicates the label", () => {
  assert.equal(
    portalSupportReference(" request_12345678 "),
    "request_12345678",
  );
  assert.equal(portalSupportReference("bad reference\nprivate"), null);
  assert.equal(
    withPortalSupportReference("Try again.", "request_12345678"),
    "Try again. Support reference: request_12345678.",
  );
  assert.equal(
    withPortalSupportReference(
      "Try again. Support reference: request_12345678.",
      "request_12345678",
    ),
    "Try again. Support reference: request_12345678.",
  );
});

void test("prefers the response correlation header over untrusted error content", async () => {
  const result = await readPortalV2Response<{ ok: true }>(
    new Response(
      JSON.stringify({
        ok: false,
        error: "service_unavailable",
        message: "The request failed.",
        correlationId: "body_12345678",
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json",
          "x-correlation-id": "header_12345678",
        },
      },
    ),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.correlationId, "header_12345678");
  assert.match(result.error.message, /Support reference: header_12345678\./u);
  assert.doesNotMatch(result.error.message, /body_12345678/u);
});

void test("a network failure returns a retryable correlated result", async () => {
  const originalFetch = globalThis.fetch;
  let requestCorrelation: string | null = null;
  globalThis.fetch = ((_input, init) => {
    requestCorrelation = new Headers(init?.headers).get("x-correlation-id");
    return Promise.reject(new TypeError("network down"));
  }) as typeof fetch;

  try {
    const result = await partnerPortalFetch<{ ok: true }>("notifications", {
      headers: new Headers({ Accept: "application/json" }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.response.status, 503);
    assert.equal(result.error.retryable, true);
    assert.match(result.error.correlationId ?? "", /^portal_[0-9a-f]{32}$/u);
    assert.equal(requestCorrelation, result.error.correlationId);
    assert.match(result.error.message, /Support reference: portal_/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

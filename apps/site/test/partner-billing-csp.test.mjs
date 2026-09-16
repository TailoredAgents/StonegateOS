import assert from "node:assert/strict";
import test from "node:test";
import {
  createPartnerBillingCsp,
  partnerMediaStorageOrigin,
} from "../config/partner-billing-csp.mjs";

const storageOrigin = "https://test-account.r2.cloudflarestorage.com";
const directives = (policy) =>
  Object.fromEntries(
    policy.split("; ").map((directive) => {
      const [name, ...sources] = directive.split(" ");
      return [name, sources];
    }),
  );

test("adds only the exact configured storage origin to transfers and previews", () => {
  const previous = directives(createPartnerBillingCsp(undefined));
  const configured = directives(createPartnerBillingCsp(storageOrigin));
  assert.deepEqual(Object.keys(configured), Object.keys(previous));
  for (const [name, sources] of Object.entries(previous)) {
    assert.deepEqual(
      configured[name],
      ["connect-src", "img-src"].includes(name)
        ? [...sources, storageOrigin]
        : sources,
    );
  }
  assert.deepEqual(configured["object-src"], ["'none'"]);
  assert.deepEqual(configured["frame-ancestors"], ["'none'"]);
  assert.deepEqual(configured["default-src"], ["'self'"]);
  assert.deepEqual(configured["script-src"], [
    "'self'",
    "'unsafe-inline'",
    "https://web.squarecdn.com",
    "https://sandbox.web.squarecdn.com",
  ]);
});

test("unset configuration preserves the policy without a storage allowance", () => {
  assert.equal(partnerMediaStorageOrigin(undefined), null);
  assert.equal(partnerMediaStorageOrigin("  "), null);
  assert.equal(createPartnerBillingCsp(""), createPartnerBillingCsp(undefined));
  assert.equal(partnerMediaStorageOrigin(` ${storageOrigin} `), storageOrigin);
  assert.equal(
    partnerMediaStorageOrigin("https://127.0.0.1:44321"),
    "https://127.0.0.1:44321",
  );
});

test("rejects wildcard, insecure, credential, path and injected policy values safely", () => {
  const invalid = [
    "*",
    "https:",
    "http://storage.example.test",
    "http://localhost:4566",
    "https://*.r2.cloudflarestorage.com",
    "https://secret:password@storage.example.test",
    `${storageOrigin}/`,
    `${storageOrigin}/bucket`,
    `${storageOrigin}/../`,
    `${storageOrigin}?token=secret`,
    `${storageOrigin}#secret`,
    `${storageOrigin}; script-src *`,
    `${storageOrigin} https://second.example.test`,
    `${storageOrigin}\nscript-src 'unsafe-eval'`,
    "https:\\storage.example.test",
    "not-an-origin",
  ];
  for (const value of invalid) {
    assert.throws(
      () => createPartnerBillingCsp(value),
      (error) => {
        assert.equal(
          error.message,
          "PARTNER_MEDIA_STORAGE_ORIGIN must be one exact HTTPS origin.",
        );
        assert.equal(error.message.includes(value), false);
        return true;
      },
    );
  }
});

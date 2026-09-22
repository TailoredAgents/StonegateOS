import assert from "node:assert/strict";
import test from "node:test";
import {
  COOKIE_CONSENT_MAX_AGE,
  parseCookiePreferences,
} from "../src/lib/cookie-consent";

void test("only current, versioned, explicit category choices permit tracking", () => {
  const preferences = {
    version: 1,
    analytics: true,
    advertising: false,
    updatedAt: Date.now(),
  };
  assert.deepEqual(
    parseCookiePreferences(encodeURIComponent(JSON.stringify(preferences))),
    preferences,
  );
  assert.deepEqual(
    parseCookiePreferences(JSON.stringify(preferences)),
    preferences,
  );
  for (const value of [
    undefined,
    null,
    "",
    "%",
    "true",
    "[]",
    "null",
    "{}",
    JSON.stringify({ ...preferences, version: 2 }),
    JSON.stringify({ ...preferences, analytics: "true" }),
    JSON.stringify({ ...preferences, advertising: 1 }),
    JSON.stringify({ ...preferences, updatedAt: "2026-09-15" }),
    JSON.stringify({ ...preferences, updatedAt: Date.now() + 60_000 }),
    JSON.stringify({
      ...preferences,
      updatedAt: Date.now() - COOKIE_CONSENT_MAX_AGE * 1000,
    }),
  ])
    assert.equal(parseCookiePreferences(value), null, `Must deny ${value}`);
});

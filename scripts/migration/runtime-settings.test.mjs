import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRuntimeSettings } from "./runtime-settings.mjs";
const key = "PARTNER_LOCATION_SECRET_KEY_BASE64";
const proofKey = "PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64";
const a = Buffer.alloc(32, 42).toString("base64");
const b = Buffer.alloc(32, 43).toString("base64");
test("runtime settings preserve exact values and permit only known key-padding differences", () => {
  assert.deepEqual(
    compareRuntimeSettings(
      { MODE: "production", [key]: a },
      { MODE: "production", [key]: a },
    ).unexplainedDifferences,
    [],
  );
  const result = compareRuntimeSettings(
    { [key]: a, [proofKey]: b.slice(0, -1) },
    { [key]: a.slice(0, -1), [proofKey]: b },
  );
  assert.deepEqual(result.paddingEquivalentKeys, [key, proofKey]);
  assert.deepEqual(result.unexplainedDifferences, []);
});
test("changed or missing encryption keys always block migration", () => {
  for (const effective of [
    { [key]: b },
    { [key]: b.slice(0, -1) },
    {},
    { [key]: "" },
  ])
    assert.deepEqual(
      compareRuntimeSettings({ [key]: a }, effective).unexplainedDifferences,
      [key],
    );
});
test("other secret and feature differences are never normalized", () => {
  const result = compareRuntimeSettings(
    { API_KEY: a, FLAG: "false", [key]: a },
    { API_KEY: a.slice(0, -1), FLAG: "true", [key]: a },
  );
  assert.deepEqual(result.unexplainedDifferences, ["API_KEY", "FLAG"]);
  assert.deepEqual(result.paddingEquivalentKeys, []);
});
test("malformed, noncanonical or wrong-length key encodings fail closed", () => {
  const noncanonical = "A".repeat(42) + "B";
  for (const [configured, effective] of [
    [" " + a, a],
    [a, a + "\n"],
    [noncanonical + "=", noncanonical],
    [
      Buffer.alloc(31).toString("base64"),
      Buffer.alloc(31).toString("base64").replace(/=+$/, ""),
    ],
  ])
    assert.deepEqual(
      compareRuntimeSettings({ [key]: configured }, { [key]: effective })
        .unexplainedDifferences,
      [key],
    );
});

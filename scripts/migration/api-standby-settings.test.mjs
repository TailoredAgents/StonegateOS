import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { splitApiStandbySecrets } from "./api-standby-settings.mjs";
function input(environment) {
  const environmentSha256 = createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest("hex");
  return {
    SOURCE_API_RUNTIME_CONFIG: JSON.stringify({
      purpose: "synthetic-test",
      environment,
      environmentSha256,
    }),
    MIGRATION_PROBE_TOKEN: "synthetic-operator-token",
  };
}
test("bounded secret parts reconstruct Unicode, credentials and literal shell syntax exactly", () => {
  const environment = {
    KEY: "x".repeat(6000),
    LABEL: "snowman ☃ emoji 🧪",
    LITERAL: "$(do-not-execute) `literal`\nsecond line",
  };
  const result = splitApiStandbySecrets(input(environment));
  assert.deepEqual(
    JSON.parse(result.SOURCE_API_ENV_1 + result.SOURCE_API_ENV_2),
    environment,
  );
  assert.equal(
    JSON.parse(result.SOURCE_API_RUNTIME_CONFIG).environment,
    undefined,
  );
  assert.equal(
    JSON.parse(result.SOURCE_API_RUNTIME_CONFIG).environmentParts,
    2,
  );
  for (const value of Object.values(result))
    assert.ok(Buffer.byteLength(value) <= 4096);
});
test("oversized settings are rejected without truncating or dropping fields", () => {
  assert.throws(
    () => splitApiStandbySecrets(input({ VALUE: "x".repeat(9000) })),
    /exceeds/,
  );
});
test("a changed setting cannot reuse a previous environment fingerprint", () => {
  const prepared = input({ KEY: "original" });
  const envelope = JSON.parse(prepared.SOURCE_API_RUNTIME_CONFIG);
  envelope.environment.KEY = "changed";
  prepared.SOURCE_API_RUNTIME_CONFIG = JSON.stringify(envelope);
  assert.throws(() => splitApiStandbySecrets(prepared), /fingerprint mismatch/);
});

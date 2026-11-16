import { test } from "node:test";
import assert from "node:assert/strict";
import { isIsolatedRestoreTarget } from "./database.mjs";
const record = {
  purpose: "empty-planetscale-rehearsal",
  provider: "planetscale",
  project: "stonegate-os-pg17",
  host: "test.psdb.cloud",
  port: 5432,
  user: "fixture.branch",
  database: "stonegate_restore_20261116",
  expiresAt: "2026-11-22T22:00:00Z",
};
const now = Date.parse("2026-11-16T02:00:00Z");
const url = new URL(
  "postgres://fixture.branch:fake@test.psdb.cloud/stonegate_restore_20261116?sslmode=verify-full",
);
test("remote restores require the recorded target, isolated database name and verified TLS", () => {
  assert.equal(isIsolatedRestoreTarget(url, record, now), true);
  assert.equal(isIsolatedRestoreTarget(url, null, now), false);
  assert.equal(
    isIsolatedRestoreTarget(url, record, Date.parse(record.expiresAt)),
    false,
  );
  for (const [field, value] of [
    ["hostname", "source.onrender.com"],
    ["username", "another-role"],
    ["port", "6432"],
    ["pathname", "/postgres"],
    ["pathname", "/stonegate_live"],
    ["search", "?sslmode=require"],
  ]) {
    const changed = new URL(url);
    changed[field] = value;
    assert.equal(isIsolatedRestoreTarget(changed, record, now), false, field);
  }
});

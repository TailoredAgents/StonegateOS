import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manager = readFileSync(
  new URL("../components/PartnerLocationManager.tsx", import.meta.url),
  "utf8",
);
const page = readFileSync(
  new URL("../(portal)/properties/page.tsx", import.meta.url),
  "utf8",
);
const proxy = readFileSync(
  new URL("../../api/partners/portal/[...segments]/route.ts", import.meta.url),
  "utf8",
);

void test("the location workspace presents portfolio controls without exposing secrets", () => {
  assert.match(manager, /Make default/u);
  assert.match(manager, /Favorite/u);
  assert.match(manager, /Parent group/u);
  assert.match(manager, /Grouped under/u);
  assert.match(manager, /Review archive impact/u);
  assert.match(manager, /active quotes/u);
  assert.match(manager, /issued quotes awaiting a/u);
  assert.match(manager, /Archiving is blocked/u);
  assert.match(manager, /impact\.issuedActionableQuoteV2Count > 0/u);
  assert.match(manager, /financial evidence after a later archive/u);
  assert.match(manager, /New account default/u);
  assert.match(manager, /Reason for archiving/u);
  assert.match(manager, /ARCHIVE LOCATION/u);
  assert.match(manager, /Review the suggested address/u);
  assert.match(manager, /Use suggested address/u);
  assert.match(manager, /Keep mine and request review/u);
  assert.match(manager, /MERGE DUPLICATE LOCATION/u);
  assert.match(manager, /RESTORE MERGED LOCATION/u);
  assert.match(manager, /Historical jobs and documents still reference/u);
  assert.match(manager, /never include gate codes or access secrets/u);
  assert.doesNotMatch(
    manager,
    /site_name,[^\n]*(gate_code|access_secret|access_code)/u,
  );
});

void test("bulk controls expose dry-run evidence, correction download, and explicit atomic commit", () => {
  assert.match(manager, /Download template/u);
  assert.match(manager, /Validate file/u);
  assert.match(manager, /validation results/u);
  assert.match(manager, /Download corrections/u);
  assert.match(manager, /location-import-commit/u);
  assert.match(manager, /"If-Match": directoryEtag/u);
  assert.match(manager, /IMPORT \$\{operation\.rowCount\} LOCATIONS/u);
  assert.match(manager, /Load more locations/u);
  assert.match(manager, /Export CSV/u);
});

void test("the server page preserves capability boundaries and directory revisions", () => {
  assert.match(page, /canManagePortfolio/u);
  assert.match(page, /exportOperationalReports/u);
  assert.match(page, /initialNextCursor/u);
  assert.match(page, /initialDirectoryEtag/u);
});

void test("the portal proxy forwards archive bodies and directory revision headers", () => {
  assert.match(proxy, /method === "DELETE"/u);
  assert.match(proxy, /x-location-directory-etag/u);
  assert.match(proxy, /idempotency-key/u);
  assert.match(proxy, /if-match/u);
});

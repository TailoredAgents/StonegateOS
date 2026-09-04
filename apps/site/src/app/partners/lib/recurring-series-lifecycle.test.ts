import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../components/PartnerRepeatWorkManager.tsx", import.meta.url),
  "utf8",
);
const bookingPage = readFileSync(
  new URL("../(portal)/book/page.tsx", import.meta.url),
  "utf8",
);

void test("recurring lifecycle controls use capability, idempotency, and the latest ETag", () => {
  assert.match(
    bookingPage,
    /canManageSeries=\{context\.permissions\.updateJobs\}/u,
  );
  assert.match(component, /method: "PATCH"/u);
  assert.match(component, /"Idempotency-Key": createPortalOperationKey/u);
  assert.match(component, /"If-Match": item\.etag/u);
  assert.match(component, /result\?\.response\.status === 412/u);
  assert.match(component, /result\.response\.headers\.get\("etag"\)/u);
  assert.doesNotMatch(component, /series\.slice\(0, 5\)/u);
});

void test("recurring lifecycle controls state their bounded consequences accessibly", () => {
  assert.match(component, /Reason for schedule change/u);
  assert.match(component, /minLength=\{2\}/u);
  assert.match(component, /maxLength=\{300\}/u);
  assert.match(component, /aria-describedby=\{helpId\}/u);
  assert.match(
    component,
    /Existing\s+jobs and review requests remain unchanged/u,
  );
  assert.match(
    component,
    /does not reserve capacity outside the 30-day\s+horizon/u,
  );
  assert.match(component, /Pause future work/u);
  assert.match(component, /Resume future work/u);
  assert.match(component, /Cancel future work/u);
  assert.match(component, /role="status"/u);
  assert.match(component, /aria-live="polite"/u);
});

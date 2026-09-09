import assert from "node:assert/strict";
import test from "node:test";
import {
  additionalServiceDraftId,
  parseAdditionalServicePage,
} from "./additional-service";

const source = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";
const summary = {
  id: child,
  status: "under_review",
  serviceKey: "service_request",
  createdAt: "2026-09-09T12:00:00.000Z",
};
const page = () => ({
  ok: true,
  originalJob: null,
  jobs: [summary],
  page: { nextCursor: "next-page", hasMore: true, limit: 25 },
});

void test("reads bounded account-authorized job relationships and preserves pagination", () => {
  const result = parseAdditionalServicePage(page(), source);
  assert.deepEqual(result?.jobs, [summary]);
  assert.equal(result?.page.nextCursor, "next-page");
  const original = parseAdditionalServicePage(
    { ...page(), originalJob: { ...summary, id: source }, jobs: [] },
    child,
  );
  assert.equal(original?.originalJob?.id, source);
  assert.ok(
    parseAdditionalServicePage(
      { ...page(), jobs: [{ ...summary, serviceKey: null }] },
      source,
    ),
  );
});

void test("rejects malformed relationships, duplicate jobs and silently truncated pages", () => {
  assert.equal(
    parseAdditionalServicePage(
      { ...page(), jobs: [...page().jobs, summary] },
      source,
    ),
    null,
  );
  assert.equal(
    parseAdditionalServicePage(
      { ...page(), jobs: [{ ...summary, id: source }] },
      source,
    ),
    null,
  );
  assert.equal(
    parseAdditionalServicePage(
      { ...page(), jobs: [{ ...summary, id: "javascript:alert(1)" }] },
      source,
    ),
    null,
  );
  assert.equal(
    parseAdditionalServicePage(
      { ...page(), page: { limit: 25, hasMore: true, nextCursor: null } },
      source,
    ),
    null,
  );
  assert.equal(
    parseAdditionalServicePage(
      { ...page(), page: { limit: 26, hasMore: true, nextCursor: "x" } },
      source,
    ),
    null,
  );
  assert.equal(
    parseAdditionalServicePage(
      { ...page(), jobs: [{ ...summary, createdAt: "tomorrow" }] },
      source,
    ),
    null,
  );
});

void test("opens only a verified additional-service draft for the current original job", () => {
  assert.equal(
    additionalServiceDraftId(
      { ok: true, draft: { id: child, additionalServiceFromJobId: source } },
      source,
    ),
    child,
  );
  assert.equal(
    additionalServiceDraftId(
      { ok: true, draft: { id: child, additionalServiceFromJobId: child } },
      source,
    ),
    null,
  );
  assert.equal(
    additionalServiceDraftId({ ok: true, draft: { id: child } }, source),
    null,
  );
  assert.equal(
    additionalServiceDraftId(
      {
        ok: true,
        draft: { id: "//attacker.test", additionalServiceFromJobId: source },
      },
      source,
    ),
    null,
  );
});

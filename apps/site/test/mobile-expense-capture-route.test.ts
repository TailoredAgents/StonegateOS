import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildExactDuplicateCaptureReviewPath,
  GET,
} from "../src/app/api/mobile/expenses/captures/route";

const routePath = fileURLToPath(
  new URL("../src/app/api/mobile/expenses/captures/route.ts", import.meta.url),
);
const proxyPath = fileURLToPath(
  new URL(
    "../src/app/api/mobile/expenses/lib/expense-proxy.ts",
    import.meta.url,
  ),
);

void test("duplicate review proxy canonicalizes only bounded queue parameters", () => {
  assert.deepEqual(
    buildExactDuplicateCaptureReviewPath(
      "https://crm.test/api/mobile/expenses/captures",
    ),
    { ok: true, path: "/api/admin/expenses/captures" },
  );
  assert.deepEqual(
    buildExactDuplicateCaptureReviewPath(
      "https://crm.test/api/mobile/expenses/captures?limit=025&cursor=abc_DEF-123&ignored=value",
    ),
    {
      ok: true,
      path: "/api/admin/expenses/captures?limit=25&cursor=abc_DEF-123",
    },
  );
  assert.deepEqual(
    buildExactDuplicateCaptureReviewPath(
      `https://crm.test/api/mobile/expenses/captures?limit=100&cursor=${"a".repeat(256)}`,
    ),
    {
      ok: true,
      path: `/api/admin/expenses/captures?limit=100&cursor=${"a".repeat(256)}`,
    },
  );
});

void test("duplicate review proxy rejects invalid or ambiguous limits", () => {
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=twenty-five",
    "limit=0001",
    "limit=25&limit=50",
  ]) {
    assert.deepEqual(
      buildExactDuplicateCaptureReviewPath(
        `https://crm.test/api/mobile/expenses/captures?${query}`,
      ),
      {
        ok: false,
        field: "limit",
        message: query.includes("&")
          ? "Use one review queue limit."
          : "Use a review queue limit from 1 through 100.",
      },
    );
  }
});

void test("duplicate review proxy treats cursors as bounded opaque base64url", () => {
  for (const query of [
    "cursor=",
    "cursor=abc%3D",
    `cursor=${"a".repeat(257)}`,
    "cursor=first&cursor=second",
  ]) {
    const result = buildExactDuplicateCaptureReviewPath(
      `https://crm.test/api/mobile/expenses/captures?${query}`,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.field, "cursor");
  }
});

void test("invalid review queries return a private no-store response", async () => {
  const response = await GET(
    new Request(
      "https://crm.test/api/mobile/expenses/captures?limit=25&limit=50",
    ),
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "invalid_capture_review_query",
    field: "limit",
    message: "Use one review queue limit.",
    retryable: false,
  });
});

void test("collection methods keep separate owner-review and submit permissions", async () => {
  const [source, proxy] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(proxyPath, "utf8"),
  ]);
  const getStart = source.indexOf("export async function GET");
  const postStart = source.indexOf("export async function POST");
  assert.notEqual(getStart, -1);
  assert.notEqual(postStart, -1);
  const getSource = source.slice(getStart, postStart);
  const postSource = source.slice(postStart);

  assert.match(getSource, /permission: "expenses\.approve"/u);
  assert.match(getSource, /method: "GET"/u);
  assert.match(source, /"Cache-Control": "private, no-store"/u);
  assert.match(proxy, /"Cache-Control": "private, no-store"/u);
  assert.match(postSource, /permission: "expenses\.submit"/u);
  assert.match(postSource, /method: "POST"/u);
  assert.match(postSource, /uploadUrl:/u);
});

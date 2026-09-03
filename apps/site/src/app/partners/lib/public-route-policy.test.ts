import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  middleware,
  resolvePartnerLandingSessionState,
} from "../../../middleware";
import { resolvePartnerApiBaseUrl, resolvePartnerApiUrl } from "./api-origin";
import { isValidPartnerSessionToken } from "@/lib/partner-session";

const VALID_SESSION_TOKEN = "S".repeat(43);
const CURRENT_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_MEMBERSHIP_ID = "33333333-3333-4333-8333-333333333333";

function sessionResponse(
  status: number,
  payload: unknown = {
    ok: true,
    session: { current: true },
    currentAccountId: CURRENT_ACCOUNT_ID,
    currentMembershipId: CURRENT_MEMBERSHIP_ID,
  },
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withFetchStub<T>(
  fetcher: typeof fetch,
  operation: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
import {
  isValidPartnerPurposeToken,
  partnerLandingDestination,
  partnerPurposeTokenPolicy,
} from "./public-route-policy";

void test("the public landing adapts without treating cookie presence as authentication", () => {
  assert.equal(
    partnerLandingDestination({
      applicationSessionPresent: false,
      portalState: "absent",
    }),
    null,
  );
  assert.equal(
    partnerLandingDestination({
      applicationSessionPresent: false,
      portalState: "authenticated",
    }),
    "/partners/overview",
  );
  assert.equal(
    partnerLandingDestination({
      applicationSessionPresent: true,
      portalState: "unauthenticated",
    }),
    "/partners/application",
  );
  assert.equal(
    partnerLandingDestination({
      applicationSessionPresent: true,
      portalState: "unavailable",
    }),
    null,
    "an identity outage must render a recoverable warning instead of hiding it behind an applicant redirect",
  );
  assert.equal(
    partnerLandingDestination({
      applicationSessionPresent: true,
      portalState: "authenticated",
    }),
    "/partners/overview",
    "an authenticated account takes precedence over an old applicant cookie",
  );
});

void test("only exact purpose-token routes receive short-lived HttpOnly cookie policy", () => {
  assert.deepEqual(partnerPurposeTokenPolicy("/partners/activate"), {
    cookieName: "myst-partner-activation-token",
    maximumAgeSeconds: 24 * 60 * 60,
  });
  assert.deepEqual(partnerPurposeTokenPolicy("/partners/reset-password"), {
    cookieName: "myst-partner-password-reset-token",
    maximumAgeSeconds: 30 * 60,
  });
  assert.deepEqual(partnerPurposeTokenPolicy("/partners/invitations/accept"), {
    cookieName: "myst-partner-invitation-token",
    maximumAgeSeconds: 30 * 60,
  });
  assert.equal(partnerPurposeTokenPolicy("/partners/verify"), null);
  assert.equal(partnerPurposeTokenPolicy("/partners/activate/extra"), null);
  assert.equal(partnerPurposeTokenPolicy("/partners"), null);
});

void test("purpose tokens accept only bounded URL-safe entropy", () => {
  assert.equal(isValidPartnerPurposeToken("a".repeat(32)), true);
  assert.equal(
    isValidPartnerPurposeToken("Ab_9-".repeat(8).slice(0, 43)),
    true,
  );
  assert.equal(isValidPartnerPurposeToken("z".repeat(256)), true);
  assert.equal(isValidPartnerPurposeToken("a".repeat(31)), false);
  assert.equal(isValidPartnerPurposeToken("a".repeat(257)), false);
  assert.equal(isValidPartnerPurposeToken(`${"a".repeat(31)}/`), false);
  assert.equal(isValidPartnerPurposeToken(`${"a".repeat(31)} `), false);
});

void test("partner session tokens require the exact generated base64url shape", () => {
  assert.equal(isValidPartnerSessionToken(VALID_SESSION_TOKEN), true);
  assert.equal(isValidPartnerSessionToken("-_".repeat(21) + "A"), true);
  assert.equal(isValidPartnerSessionToken("S".repeat(42)), false);
  assert.equal(isValidPartnerSessionToken("S".repeat(44)), false);
  assert.equal(isValidPartnerSessionToken(`${"S".repeat(42)}/`), false);
  assert.equal(isValidPartnerSessionToken(`${"S".repeat(42)}=`), false);
});

void test("partner API origins are server-configured, normalized, and fail closed", () => {
  assert.equal(
    resolvePartnerApiBaseUrl({
      NODE_ENV: "production",
      API_BASE_URL: "https://api.stonegate.example/root/",
    }),
    "https://api.stonegate.example/root",
  );
  assert.equal(
    resolvePartnerApiUrl("/api/portal/v2/session", {
      NODE_ENV: "production",
      API_BASE_URL: "https://api.stonegate.example/root/",
    }),
    "https://api.stonegate.example/root/api/portal/v2/session",
  );
  assert.equal(
    resolvePartnerApiBaseUrl({
      NODE_ENV: "production",
      API_BASE_URL: "https://user:secret@api.stonegate.example",
    }),
    null,
  );
  assert.equal(
    resolvePartnerApiBaseUrl({
      NODE_ENV: "production",
      API_BASE_URL: "https://api.stonegate.example?redirect=bad",
    }),
    null,
  );
  assert.equal(resolvePartnerApiBaseUrl({ NODE_ENV: "production" }), null);
  assert.equal(
    resolvePartnerApiBaseUrl({ NODE_ENV: "development" }),
    "http://localhost:3001",
  );
});

void test("the landing probe authenticates only a valid account-scoped session payload", async () => {
  let calls = 0;
  const fetcher = ((input, init) => {
    calls += 1;
    assert.equal(input, "https://api.stonegate.example/api/portal/v2/session");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${VALID_SESSION_TOKEN}`);
    assert.match(
      headers.get("x-correlation-id") ?? "",
      /^portal_[0-9a-f]{32}$/u,
    );
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    return Promise.resolve(sessionResponse(200));
  }) as typeof fetch;

  assert.equal(
    await resolvePartnerLandingSessionState(VALID_SESSION_TOKEN, {
      apiUrl: "https://api.stonegate.example/api/portal/v2/session",
      fetcher,
    }),
    "authenticated",
  );
  assert.equal(calls, 1);

  for (const payload of [
    null,
    { ok: true, session: { current: false } },
    {
      ok: true,
      session: { current: true },
      currentAccountId: "not-an-account-id",
      currentMembershipId: CURRENT_MEMBERSHIP_ID,
    },
  ]) {
    assert.equal(
      await resolvePartnerLandingSessionState(VALID_SESSION_TOKEN, {
        apiUrl: "https://api.stonegate.example/api/portal/v2/session",
        fetcher: (() =>
          Promise.resolve(sessionResponse(200, payload))) as typeof fetch,
      }),
      "unavailable",
    );
  }
});

void test("the landing probe separates rejection, outages, malformed tokens, and timeout", async () => {
  let malformedCalls = 0;
  assert.equal(
    await resolvePartnerLandingSessionState("malformed", {
      apiUrl: "https://api.stonegate.example/api/portal/v2/session",
      fetcher: (() => {
        malformedCalls += 1;
        return Promise.resolve(sessionResponse(200));
      }) as typeof fetch,
    }),
    "unauthenticated",
  );
  assert.equal(malformedCalls, 0);

  for (const status of [401, 403]) {
    assert.equal(
      await resolvePartnerLandingSessionState(VALID_SESSION_TOKEN, {
        apiUrl: "https://api.stonegate.example/api/portal/v2/session",
        fetcher: (() =>
          Promise.resolve(
            sessionResponse(status, { ok: false }),
          )) as typeof fetch,
      }),
      "unauthenticated",
    );
  }
  for (const status of [404, 429, 500, 503]) {
    assert.equal(
      await resolvePartnerLandingSessionState(VALID_SESSION_TOKEN, {
        apiUrl: "https://api.stonegate.example/api/portal/v2/session",
        fetcher: (() =>
          Promise.resolve(
            sessionResponse(status, { ok: false }),
          )) as typeof fetch,
      }),
      "unavailable",
    );
  }
  assert.equal(
    await resolvePartnerLandingSessionState(VALID_SESSION_TOKEN, {
      apiUrl: null,
    }),
    "unavailable",
  );
  assert.equal(
    await resolvePartnerLandingSessionState(VALID_SESSION_TOKEN, {
      apiUrl: "https://api.stonegate.example/api/portal/v2/session",
      fetcher: ((_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        })) as typeof fetch,
      timeoutMs: 5,
    }),
    "unavailable",
  );
});

void test("activation links move the token into an HttpOnly cookie and sanitize the URL", async () => {
  const token = "A_9-".repeat(12);
  const response = await middleware(
    new NextRequest(
      `https://stonegate.example/partners/activate?campaign=fall&token=${token}`,
    ),
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "https://stonegate.example/partners/activate?campaign=fall",
  );
  assert.equal(
    response.cookies.get("myst-partner-activation-token")?.value,
    token,
  );
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /myst-partner-activation-token=/u);
  assert.match(setCookie, /HttpOnly/iu);
  assert.match(setCookie, /SameSite=lax/iu);
  assert.match(setCookie, /Path=\//u);
  assert.match(setCookie, /Max-Age=86400/iu);
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

void test("sanitized activation responses remain private and non-cacheable", async () => {
  const response = await middleware(
    new NextRequest("https://stonegate.example/partners/activate"),
  );

  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

void test("anonymous landing traffic passes through without private cache headers or an auth probe", async () => {
  let fetchCalls = 0;
  await withFetchStub(
    (() => {
      fetchCalls += 1;
      return Promise.resolve(sessionResponse(500, { ok: false }));
    }) as typeof fetch,
    async () => {
      const response = await middleware(
        new NextRequest("https://stonegate.example/partners"),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-middleware-next"), "1");
      assert.equal(response.headers.get("cache-control"), null);
      assert.equal(response.headers.get("referrer-policy"), null);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("x-middleware-rewrite"), null);
    },
  );
  assert.equal(fetchCalls, 0);
});

void test("HEAD requests use the same safe landing matrix and strip internal-state spoofing", async () => {
  let anonymousFetchCalls = 0;
  await withFetchStub(
    (() => {
      anonymousFetchCalls += 1;
      return Promise.resolve(sessionResponse(500, { ok: false }));
    }) as typeof fetch,
    async () => {
      const response = await middleware(
        new NextRequest("https://stonegate.example/partners", {
          method: "HEAD",
          headers: { "x-partner-internal-degraded": "spoofed" },
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-middleware-next"), "1");
      assert.equal(response.headers.get("cache-control"), null);
      assert.doesNotMatch(
        response.headers.get(
          "x-middleware-request-x-partner-internal-degraded",
        ) ?? "",
        /spoofed/u,
      );
    },
  );
  assert.equal(anonymousFetchCalls, 0);

  await withFetchStub(
    (() => Promise.resolve(sessionResponse(200))) as typeof fetch,
    async () => {
      const response = await middleware(
        new NextRequest("https://stonegate.example/partners", {
          method: "HEAD",
          headers: {
            cookie: `myst-partner-session=${VALID_SESSION_TOKEN}`,
          },
        }),
      );
      assert.equal(response.status, 307);
      assert.equal(
        response.headers.get("location"),
        "https://stonegate.example/partners/overview",
      );
      assert.equal(
        response.headers.get("cache-control"),
        "private, no-store, max-age=0",
      );
    },
  );
});

void test("the landing redirects only a validated session and gives it precedence over an applicant cookie", async () => {
  await withFetchStub(
    (() => Promise.resolve(sessionResponse(200))) as typeof fetch,
    async () => {
      const response = await middleware(
        new NextRequest("https://stonegate.example/partners?from=bookmark", {
          headers: {
            cookie: [
              `myst-partner-session=${VALID_SESSION_TOKEN}`,
              "myst-partner-application=applicant-session",
            ].join("; "),
          },
        }),
      );
      assert.equal(response.status, 307);
      assert.equal(
        response.headers.get("location"),
        "https://stonegate.example/partners/overview",
      );
      assert.equal(
        response.headers.get("cache-control"),
        "private, no-store, max-age=0",
      );
      assert.equal(response.headers.get("set-cookie"), null);
    },
  );
});

void test("definitively rejected and malformed sessions are cleared without trusting cookie presence", async () => {
  await withFetchStub(
    (() =>
      Promise.resolve(sessionResponse(401, { ok: false }))) as typeof fetch,
    async () => {
      const response = await middleware(
        new NextRequest("https://stonegate.example/partners", {
          headers: {
            cookie: [
              `myst-partner-session=${VALID_SESSION_TOKEN}`,
              "myst-partner-application=applicant-session",
            ].join("; "),
          },
        }),
      );
      assert.equal(response.status, 307);
      assert.equal(
        response.headers.get("location"),
        "https://stonegate.example/partners/application",
      );
      assert.match(
        response.headers.get("set-cookie") ?? "",
        /myst-partner-session=;/u,
      );
    },
  );

  let fetchCalls = 0;
  await withFetchStub(
    (() => {
      fetchCalls += 1;
      return Promise.resolve(sessionResponse(200));
    }) as typeof fetch,
    async () => {
      const response = await middleware(
        new NextRequest("https://stonegate.example/partners", {
          headers: { cookie: "myst-partner-session=malformed" },
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("cache-control"),
        "private, no-store, max-age=0",
      );
      assert.match(
        response.headers.get("set-cookie") ?? "",
        /myst-partner-session=;/u,
      );
    },
  );
  assert.equal(fetchCalls, 0);
});

void test("an applicant-only landing request resumes the application privately", async () => {
  const response = await middleware(
    new NextRequest("https://stonegate.example/partners", {
      headers: { cookie: "myst-partner-application=applicant-session" },
    }),
  );
  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    "https://stonegate.example/partners/application",
  );
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
});

void test("session-provider uncertainty internally rewrites to a private noindex fallback", async () => {
  await withFetchStub(
    (() =>
      Promise.resolve(sessionResponse(503, { ok: false }))) as typeof fetch,
    async () => {
      const response = await middleware(
        new NextRequest("https://stonegate.example/partners?from=bookmark", {
          headers: {
            cookie: [
              `myst-partner-session=${VALID_SESSION_TOKEN}`,
              "myst-partner-application=applicant-session",
            ].join("; "),
            "x-partner-internal-degraded": "spoofed",
          },
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("location"), null);
      assert.equal(
        response.headers.get("x-middleware-rewrite"),
        "https://stonegate.example/partners/unavailable",
      );
      assert.equal(
        response.headers.get("cache-control"),
        "private, no-store, max-age=0",
      );
      assert.equal(
        response.headers.get("x-robots-tag"),
        "noindex, nofollow, noarchive",
      );
      assert.equal(response.headers.get("set-cookie"), null);
      assert.doesNotMatch(
        response.headers.get(
          "x-middleware-request-x-partner-internal-degraded",
        ) ?? "",
        /spoofed/u,
      );
    },
  );
});

void test("the degraded implementation path cannot be navigated directly", async () => {
  const response = await middleware(
    new NextRequest("https://stonegate.example/partners/unavailable", {
      headers: { "x-partner-internal-degraded": "1" },
    }),
  );
  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    "https://stonegate.example/partners",
  );
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assert.equal(
    response.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive",
  );
});

void test("the canonical middleware retains admin protection and attribution", async () => {
  const adminResponse = await middleware(
    new NextRequest("https://stonegate.example/admin/not-a-route?mode=audit"),
  );
  assert.equal(adminResponse.status, 307);
  assert.equal(
    adminResponse.headers.get("location"),
    "https://stonegate.example/admin/login?redirectTo=%2Fadmin%2Fnot-a-route%3Fmode%3Daudit",
  );

  const attributionResponse = await middleware(
    new NextRequest(
      "https://stonegate.example/commercial?utm_source=partner&utm_campaign=fall",
    ),
  );
  const attributionCookie = attributionResponse.cookies.get("myst_utm");
  assert.ok(attributionCookie);
  assert.deepEqual(JSON.parse(attributionCookie.value), {
    source: "partner",
    campaign: "fall",
  });
});

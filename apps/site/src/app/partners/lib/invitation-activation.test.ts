import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../invitations/accept/complete/route";
import { parsePartnerInvitationActivationQueued } from "./invitation-activation";
import { derivePartnerInvitationActivationToken } from "./invitation-handoff";
import {
  activationInspectionHeaders,
  resolveActivationInspectionOrigin,
} from "./activation-inspection";

const TOKEN = "A".repeat(43);
const EXPIRY = "2099-01-01T00:00:00.000Z";
const ready = {
  ok: true,
  activationRequired: true,
  deliveryStatus: "ready",
  activationExpiresAt: EXPIRY,
};
const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

void test("activation inspection uses the configured Site origin, never the API transport or caller headers", () => {
  const siteOrigin = resolveActivationInspectionOrigin({
    NODE_ENV: "production",
    NEXT_PUBLIC_SITE_URL: "https://stonegate.example",
    API_BASE_URL: "https://api.stonegate.example",
  });
  assert.equal(siteOrigin, "https://stonegate.example");
  const headers = activationInspectionHeaders(
    new Headers({
      "x-forwarded-for": "203.0.113.10, 192.0.2.8",
      "user-agent": "a".repeat(600),
      origin: "https://untrusted.example",
      host: "untrusted.example",
      "x-forwarded-host": "untrusted.example",
      "sec-fetch-site": "cross-site",
      referer: "https://untrusted.example/?token=secret",
      cookie: "credential=secret",
      authorization: "Bearer secret",
    }),
    siteOrigin!,
    { trustedProxyHops: "1" },
  );
  assert.equal(headers.get("origin"), "https://stonegate.example");
  assert.equal(headers.get("x-forwarded-for"), "192.0.2.8");
  assert.equal(headers.get("user-agent")?.length, 512);
  assert.equal(headers.has("cookie"), false);
  assert.equal(headers.has("authorization"), false);
  for (const name of ["host", "x-forwarded-host", "sec-fetch-site", "referer"])
    assert.equal(headers.has(name), false);
  for (const trustedProxyHops of ["", "0", "11", "abc"])
    assert.equal(
      activationInspectionHeaders(
        new Headers({ "x-forwarded-for": "203.0.113.10" }),
        "https://api.stonegate.example",
        { trustedProxyHops },
      ).has("x-forwarded-for"),
      false,
    );
  for (const forwarded of [
    "not-an-ip",
    "a".repeat(4097),
    Array.from({ length: 33 }, () => "203.0.113.10").join(","),
  ])
    assert.equal(
      activationInspectionHeaders(
        new Headers({ "x-forwarded-for": forwarded }),
        "https://api.stonegate.example",
        { trustedProxyHops: "1" },
      ).has("x-forwarded-for"),
      false,
    );
  assert.equal(
    activationInspectionHeaders(
      new Headers({
        "cf-connecting-ip": "203.0.113.10",
        "x-real-ip": "203.0.113.11",
        "x-forwarded-for": "203.0.113.12,2001:db8::1,192.0.2.8",
      }),
      "https://api.stonegate.example",
      { trustedProxyHops: "2" },
    ).get("x-forwarded-for"),
    "2001:db8::1",
  );
});

void test("activation inspection fails closed on missing or invalid production Site configuration", () => {
  for (const value of [
    undefined,
    "",
    "bad url",
    "http://stonegate.example",
    "https://user:pass@stonegate.example",
    "https://stonegate.example/path",
    "https://stonegate.example?token=secret",
    "https://stonegate.example#fragment",
    "javascript:alert(1)",
  ]) {
    assert.equal(
      resolveActivationInspectionOrigin({
        NODE_ENV: "production",
        NEXT_PUBLIC_SITE_URL: value,
        API_BASE_URL: "https://api.stonegate.example",
      }),
      null,
    );
  }
  assert.equal(
    resolveActivationInspectionOrigin({
      NODE_ENV: "production",
      NEXT_PUBLIC_SITE_URL: "invalid",
      SITE_URL: "https://stonegate.example/",
    }),
    "https://stonegate.example",
  );
  assert.equal(
    resolveActivationInspectionOrigin({
      NODE_ENV: "production",
      NEXT_PUBLIC_SITE_URL: "https://canonical.example",
      SITE_URL: "https://site.example",
    }),
    "https://canonical.example",
  );
  assert.equal(
    resolveActivationInspectionOrigin({ NODE_ENV: "development" }),
    "http://localhost:3000",
  );
  assert.equal(
    resolveActivationInspectionOrigin({
      NODE_ENV: "test",
      SITE_URL: "http://127.0.0.1:4200",
    }),
    "http://127.0.0.1:4200",
  );
  const page = source("../(public)/activate/page.tsx");
  assert.match(page, /token && inspectionUrl && inspectionOrigin/u);
  assert.match(
    page,
    /activationInspectionHeaders\(\s*await headers\(\),\s*inspectionOrigin,/u,
  );
});
function request(origin = "https://stonegate.example", body = "") {
  return new NextRequest(
    "https://stonegate.example/partners/invitations/accept/complete",
    {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
        cookie: "myst-partner-invitation-token=" + TOKEN,
      },
      body,
    },
  );
}
async function withFetch(fetcher: typeof fetch, run: () => Promise<void>) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
}

void test("accepts only the non-credential same-email activation handoff", () => {
  assert.deepEqual(
    parsePartnerInvitationActivationQueued({
      ...ready,
      correlationId: "corr_example",
    }),
    ready,
  );
  for (const value of [
    null,
    { ...ready, deliveryStatus: "queued" },
    { ...ready, activationRequired: false },
    { ...ready, activationExpiresAt: "2020-01-01" },
    { ...ready, activationExpiresAt: "invalid" },
    { ...ready, sessionToken: TOKEN },
    { ...ready, token: TOKEN },
  ])
    assert.equal(parsePartnerInvitationActivationQueued(value), null);
});

void test("derives a separate fixed-length credential without reusing the invitation token", () => {
  const activation = derivePartnerInvitationActivationToken(TOKEN);
  assert.match(activation, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(activation, TOKEN);
  assert.equal(activation, derivePartnerInvitationActivationToken(TOKEN));
  assert.notEqual(
    activation,
    derivePartnerInvitationActivationToken("B".repeat(43)),
  );
  assert.throws(() => derivePartnerInvitationActivationToken("short"));
});

void test("native invitation POST hands off HttpOnly activation only and retries with the same idempotency key", async () => {
  const keys: string[] = [];
  await withFetch(
    ((input, init) => {
      assert.ok(typeof input === "string");
      assert.ok(input.endsWith("/api/portal/v2/invitations/accept"));
      assert.equal(init?.method, "POST");
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      assert.ok(typeof init?.body === "string");
      assert.deepEqual(JSON.parse(init.body), { token: TOKEN });
      return Promise.resolve(Response.json(ready, { status: 202 }));
    }) as typeof fetch,
    async () => {
      for (let index = 0; index < 2; index += 1) {
        const response = await POST(request());
        assert.equal(response.status, 303);
        assert.equal(
          response.headers.get("location"),
          "https://stonegate.example/partners/activate",
        );
        const cookies = response.headers.get("set-cookie") ?? "";
        assert.ok(
          cookies.includes(
            "myst-partner-activation-token=" +
              derivePartnerInvitationActivationToken(TOKEN),
          ),
        );
        assert.match(cookies, /myst-partner-invitation-token=;/u);
        assert.match(cookies, /HttpOnly/iu);
        assert.doesNotMatch(cookies, /myst-partner-session=/u);
        assert.match(
          response.headers.get("cache-control") ?? "",
          /private, no-store/u,
        );
        assert.ok(!(await response.text()).includes(TOKEN));
      }
    },
  );
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.ok(!keys[0]!.includes(TOKEN));
});

void test("transport/rate errors preserve the invite while rejected credentials are cleared", async () => {
  for (const status of [401, 410, 429, 503]) {
    await withFetch(
      (() =>
        Promise.resolve(
          Response.json({ ok: false }, { status }),
        )) as typeof fetch,
      async () => {
        const response = await POST(request());
        assert.equal(response.status, 303);
        assert.equal(
          Boolean(response.headers.get("set-cookie")),
          status === 401 || status === 410,
        );
        assert.match(
          response.headers.get("location") ?? "",
          status === 429
            ? /rate_limited$/u
            : status === 503
              ? /unavailable$/u
              : /invalid$/u,
        );
      },
    );
  }
});

void test("cross-origin and injected form fields never consume an invitation", async () => {
  await withFetch(
    (() => {
      throw new Error("unexpected API call");
    }) as typeof fetch,
    async () => {
      assert.equal((await POST(request("https://evil.example"))).status, 403);
      assert.match(
        (await POST(request(undefined, "token=attacker"))).headers.get(
          "location",
        ) ?? "",
        /error=invalid$/u,
      );
    },
  );
});

void test("the invitation screen is a native POST without a second email, MFA, or live-access claim", () => {
  const page = source("../(public)/invitations/accept/page.tsx");
  assert.match(page, /method="post"/u);
  assert.match(page, /Continue to password setup/u);
  assert.doesNotMatch(
    page,
    /separate activation link|MFA|authenticator|recovery code/iu,
  );
  assert.match(page, /index: false, follow: false, nocache: true/u);
  assert.match(page, /referrer: "same-origin"/u);
});

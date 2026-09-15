import assert from "node:assert/strict";
import test from "node:test";
import {
  flushOpenAiAdsConsentRevocations,
  getOpenAiAdsAttribution,
  initializeOpenAiAdsPixel,
  isOpenAiAdsMeasurementAllowed,
  isOpenAiAdsPublicPath,
  sanitizeOpenAiAdsSourceUrl,
  setOpenAiAdsMeasurementConsent,
  suspendOpenAiAdsPixel,
  trackOpenAiAdsBooking,
  trackOpenAiAdsPhoneClick,
  withOpenAiAdsUtm,
} from "../src/lib/openai-ads";

function browser(url: string) {
  const storage = new Map<string, string>();
  const cookies = new Map<string, string>();
  const calls: unknown[][] = [];
  const scripts: unknown[] = [];
  const fakeDocument = {
    get cookie() {
      return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    },
    set cookie(value: string) {
      const [entry] = value.split(";");
      const separator = entry!.indexOf("=");
      cookies.set(entry!.slice(0, separator), entry!.slice(separator + 1));
    },
    getElementById: () => scripts[0],
    createElement: () => ({}),
    head: { appendChild: (script: unknown) => scripts.push(script) },
  };
  const fakeWindow = {
    location: new URL(url),
    navigator: { doNotTrack: "0", globalPrivacyControl: false },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
    dispatchEvent: () => true,
    oaiq: (...args: unknown[]) => {
      calls.push(args);
      if (args[0] === "consent") {
        storage.set("oaiq_consent", String(args[1]));
        cookies.set("__oaiq_consent", String(args[1]));
      }
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument,
  });
  process.env["NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID"] = "test-pixel";
  delete process.env["NEXT_PUBLIC_OPENAI_ADS_REQUIRE_CONSENT"];
  setOpenAiAdsMeasurementConsent(false);
  setOpenAiAdsMeasurementConsent(true);
  calls.length = 0;
  return { window: fakeWindow, storage, cookies, calls, scripts };
}

void test("public route boundary excludes credentials, private proposals, partner and staff routes", () => {
  for (const path of [
    "/",
    "/book",
    "/bookdemo",
    "/services/furniture-removal",
    "/privacy",
  ])
    assert.equal(isOpenAiAdsPublicPath(path), true);
  for (const path of [
    "/team",
    "/team/inbox",
    "/partners",
    "/mobile",
    "/admin",
    "/quote/bearer-token",
    "/schedule",
    "/api/anything",
    "/book/private",
  ])
    assert.equal(isOpenAiAdsPublicPath(path), false);
  assert.equal(
    sanitizeOpenAiAdsSourceUrl(
      "https://example.com/book?email=private@example.com#token",
    ),
    "https://example.com",
  );
  assert.equal(
    sanitizeOpenAiAdsSourceUrl("https://example.com/quote/private"),
    undefined,
  );
  assert.equal(sanitizeOpenAiAdsSourceUrl("javascript:alert(1)"), undefined);
});

void test("captures click and browser identifiers and preserves them through navigation", () => {
  const b = browser(
    "https://example.com/?oppref=click_123&email=private@example.com#private",
  );
  b.cookies.set("__obref", "browser_456");
  const first = getOpenAiAdsAttribution();
  assert.deepEqual(first, {
    consentId: first?.consentId,
    oppref: "click_123",
    obref: "browser_456",
    sourceUrl: "https://example.com",
    consent: true,
    capturedAt: first?.capturedAt,
  });
  b.window.location = new URL("https://example.com/book");
  assert.deepEqual(getOpenAiAdsAttribution(), first);
  assert.deepEqual(withOpenAiAdsUtm({ campaign: "spring" }), {
    campaign: "spring",
    source: "chatgpt",
    medium: "paid",
  });
  b.window.location = new URL(
    "https://example.com/book?oppref=click_123&utm_source=explicit&utm_medium=cpc",
  );
  assert.deepEqual(withOpenAiAdsUtm({ source: "explicit", medium: "cpc" }), {
    source: "explicit",
    medium: "cpc",
  });
});

void test("new ad clicks replace the prior click but organic traffic has no paid source", () => {
  const b = browser("https://example.com/book");
  assert.deepEqual(withOpenAiAdsUtm({ source: "chatgpt.com" }), {
    source: "chatgpt.com",
  });
  b.window.location = new URL("https://example.com/book?oppref=first");
  assert.equal(getOpenAiAdsAttribution()?.oppref, "first");
  b.window.location = new URL("https://example.com/book?oppref=second");
  assert.equal(getOpenAiAdsAttribution()?.oppref, "second");
  assert.deepEqual(withOpenAiAdsUtm({ source: "google", medium: "cpc" }), {
    source: "chatgpt",
    medium: "paid",
  });
  assert.deepEqual(JSON.parse(decodeURIComponent(b.cookies.get("myst_utm")!)), {
    source: "chatgpt",
    medium: "paid",
  });
  b.window.location = new URL("https://example.com/book?oppref=opaque%3D%3D");
  assert.equal(getOpenAiAdsAttribution()?.oppref, "opaque==");
});

void test("privacy signals and opt-out prevent SDK loading and carry denial to the server", () => {
  const b = browser("https://example.com/book?oppref=secret");
  b.window.navigator.globalPrivacyControl = true;
  assert.equal(initializeOpenAiAdsPixel("pixel"), false);
  assert.deepEqual(getOpenAiAdsAttribution(), { consent: false });
  assert.equal(b.scripts.length, 0);
  b.window.navigator.globalPrivacyControl = false;
  b.window.navigator.doNotTrack = "1";
  assert.equal(isOpenAiAdsMeasurementAllowed(), false);
  b.window.navigator.doNotTrack = "0";
  setOpenAiAdsMeasurementConsent(false);
  assert.deepEqual(getOpenAiAdsAttribution(), { consent: false });
  trackOpenAiAdsBooking("denied-booking");
  assert.equal(b.calls.filter((args) => args[0] === "measure").length, 0);
});

void test("SDK stored denial is honored even when site's prior preference allowed measurement", () => {
  const b = browser("https://example.com/book");
  b.storage.set("oaiq_consent", "false");
  assert.equal(isOpenAiAdsMeasurementAllowed(), false);
  assert.deepEqual(getOpenAiAdsAttribution(), { consent: false });
});

void test("booking is deduplicated with server ID and phone taps stay secondary", () => {
  const b = browser("https://example.com/book?oppref=click");
  trackOpenAiAdsBooking("appointment-123");
  trackOpenAiAdsBooking("appointment-123");
  trackOpenAiAdsPhoneClick();
  assert.deepEqual(b.calls, [
    [
      "measure",
      "appointment_scheduled",
      { type: "customer_action" },
      { event_id: "booking:appointment-123" },
    ],
    [
      "measure",
      "custom",
      { type: "custom" },
      { custom_event_name: "phone_click" },
    ],
  ]);
  b.window.location = new URL("https://example.com/quote/private-token");
  assert.equal(getOpenAiAdsAttribution(), undefined);
  trackOpenAiAdsPhoneClick();
  assert.equal(b.calls.length, 2);
});

void test("private navigation suspends SDK measurement and public return restores permission", () => {
  const b = browser("https://example.com/book?oppref=return-click");
  assert.equal(initializeOpenAiAdsPixel("pixel"), true);
  assert.equal(b.scripts.length, 1);
  assert.deepEqual(
    b.calls.find((args) => args[0] === "init"),
    ["init", { pixelId: "pixel", debug: false }],
  );
  b.window.location = new URL("https://example.com/team");
  suspendOpenAiAdsPixel();
  assert.deepEqual(b.calls.at(-1), ["consent", false]);
  b.window.location = new URL("https://example.com/book");
  assert.equal(initializeOpenAiAdsPixel("pixel"), true);
  assert.equal(getOpenAiAdsAttribution()?.oppref, "return-click");
  assert.equal(b.scripts.length, 1);
});

void test("malformed identifiers and stale stored attribution do not travel to the server", () => {
  const b = browser("https://example.com/book?oppref=bad%20value");
  b.storage.set(
    "sg:openai-ads-attribution",
    JSON.stringify({
      consent: true,
      oppref: "expired",
      capturedAt: "2020-01-01T00:00:00.000Z",
    }),
  );
  assert.equal(getOpenAiAdsAttribution()?.oppref, undefined);
});

void test("opt-out persists revocation for retry and regrant creates a fresh consent context", async () => {
  const b = browser("https://example.com/book?oppref=click");
  const first = getOpenAiAdsAttribution();
  const originalFetch = globalThis.fetch;
  const originalApiBase = process.env["NEXT_PUBLIC_API_BASE_URL"];
  process.env["NEXT_PUBLIC_API_BASE_URL"] = "https://api.example.com";
  const sent: Array<{ url: string; body: unknown; keepalive?: boolean }> = [];
  try {
    globalThis.fetch = (url, options) => {
      assert.equal(typeof url, "string");
      assert.equal(typeof options?.body, "string");
      sent.push({
        url: url as string,
        body: JSON.parse(options?.body as string) as unknown,
        keepalive: options?.keepalive,
      });
      return Promise.reject(new Error("offline"));
    };
    setOpenAiAdsMeasurementConsent(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent.at(-1), {
      url: "https://api.example.com/api/public/openai/ads/consent",
      body: { consentId: first?.consentId, consent: false },
      keepalive: true,
    });
    const pending = JSON.parse(
      b.storage.get("sg:openai-ads-pending-revocations")!,
    ) as unknown[];
    assert.ok(pending.includes(first?.consentId));
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    flushOpenAiAdsConsentRevocations();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      JSON.parse(b.storage.get("sg:openai-ads-pending-revocations")!),
      [],
    );
    setOpenAiAdsMeasurementConsent(true);
    const next = getOpenAiAdsAttribution();
    assert.notEqual(next?.consentId, first?.consentId);
    b.window.navigator.globalPrivacyControl = true;
    assert.deepEqual(getOpenAiAdsAttribution(), {
      consent: false,
      consentId: next?.consentId,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      b.storage.get("sg:openai-ads-revoked-context"),
      next?.consentId,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiBase === undefined)
      delete process.env["NEXT_PUBLIC_API_BASE_URL"];
    else process.env["NEXT_PUBLIC_API_BASE_URL"] = originalApiBase;
  }
});

void test("a different platform's new click does not inherit a prior ChatGPT source", () => {
  const b = browser("https://example.com/book?oppref=click");
  getOpenAiAdsAttribution();
  b.window.location = new URL("https://example.com/book?gclid=google-click");
  assert.deepEqual(withOpenAiAdsUtm({ source: "chatgpt", medium: "paid" }), {
    source: undefined,
    medium: undefined,
  });
  b.window.location = new URL(
    "https://example.com/book?fbclid=facebook-click&utm_source=facebook&utm_medium=referral",
  );
  assert.deepEqual(withOpenAiAdsUtm({}), {
    source: "facebook",
    medium: "referral",
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  COOKIE_CONSENT_COOKIE,
  COOKIE_CONSENT_EVENT,
} from "../src/lib/cookie-consent";
import {
  setGoogleAdsEnhancedConversionsUserData,
  trackGoogleAdsConversion,
} from "../src/lib/google-ads";
import { readConsentedUtm } from "../src/lib/use-utm";
import {
  ensureVisitStarted,
  flushWebAnalytics,
  trackWebEvent,
} from "../src/lib/web-analytics";
import { middleware } from "../src/middleware";

function consent(analytics: boolean, advertising: boolean): string {
  return encodeURIComponent(
    JSON.stringify({
      version: 1,
      analytics,
      advertising,
      updatedAt: Date.now(),
    }),
  );
}

function browser() {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const cookies = new Map<string, string>();
  const sent: Blob[] = [];
  const calls: unknown[][] = [];
  const storage = (values: Map<string, string>) => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  });
  const fakeWindow = Object.assign(new EventTarget(), {
    location: new URL(
      "https://example.com/book?utm_source=google&utm_campaign=spring&gclid=ad-click&fbclid=meta-click",
    ),
    innerWidth: 1200,
    navigator: {
      globalPrivacyControl: false,
      doNotTrack: "0",
      sendBeacon: (_url: string, payload: Blob) => {
        sent.push(payload);
        return true;
      },
    },
    localStorage: storage(local),
    sessionStorage: storage(session),
    gtag: (...args: unknown[]) => {
      calls.push(args);
    },
  });
  const fakeDocument = {
    referrer: "https://example.com/",
    get cookie() {
      return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    },
    set cookie(value: string) {
      const [entry] = value.split(";");
      const separator = entry!.indexOf("=");
      const key = entry!.slice(0, separator);
      if (value.includes("Max-Age=0")) cookies.delete(key);
      else cookies.set(key, entry!.slice(separator + 1));
    },
  };
  const replacements = {
    window: fakeWindow,
    document: fakeDocument,
    navigator: fakeWindow.navigator,
    localStorage: fakeWindow.localStorage,
    sessionStorage: fakeWindow.sessionStorage,
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(replacements)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const originalApiBase = process.env["NEXT_PUBLIC_API_BASE_URL"];
  const originalPixel = process.env["NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID"];
  process.env["NEXT_PUBLIC_API_BASE_URL"] = "https://api.example.com";
  delete process.env["NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID"];
  const choose = (analytics: boolean, advertising: boolean) => {
    cookies.set(COOKIE_CONSENT_COOKIE, consent(analytics, advertising));
    fakeWindow.dispatchEvent(new Event(COOKIE_CONSENT_EVENT));
  };
  return {
    window: fakeWindow,
    local,
    session,
    cookies,
    sent,
    calls,
    choose,
    restore() {
      choose(false, false);
      flushWebAnalytics();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      if (originalApiBase === undefined)
        delete process.env["NEXT_PUBLIC_API_BASE_URL"];
      else process.env["NEXT_PUBLIC_API_BASE_URL"] = originalApiBase;
      if (originalPixel === undefined)
        delete process.env["NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID"];
      else process.env["NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID"] = originalPixel;
    },
  };
}

void test("unset and rejected consent prevent analytics storage, attribution and Google calls", () => {
  const b = browser();
  try {
    b.cookies.set(
      "myst_utm",
      encodeURIComponent(JSON.stringify({ source: "old", gclid: "old-click" })),
    );
    for (const rejected of [false, true]) {
      if (rejected) b.choose(false, false);
      ensureVisitStarted("/book");
      trackWebEvent({ event: "book_booking_success", path: "/book" });
      setGoogleAdsEnhancedConversionsUserData({ email: "person@example.com" });
      trackGoogleAdsConversion("AW-test/booking");
      flushWebAnalytics();
      assert.deepEqual(readConsentedUtm(), {});
      assert.equal(b.local.size, 0);
      assert.equal(b.session.size, 0);
      assert.equal(b.sent.length, 0);
      assert.equal(b.calls.length, 0);
    }
  } finally {
    b.restore();
  }
});

void test("analytics and advertising permissions operate independently", async () => {
  const b = browser();
  try {
    b.choose(true, false);
    ensureVisitStarted("/book");
    trackWebEvent({ event: "page_view", path: "/book" });
    trackGoogleAdsConversion("AW-test/booking");
    flushWebAnalytics();
    const payload = JSON.parse(await b.sent[0]!.text()) as {
      events: Array<{ event: string; utm?: unknown }>;
    };
    assert.deepEqual(
      payload.events.map((event) => event.event),
      ["visit_start", "page_view"],
    );
    assert.ok(payload.events.every((event) => event.utm === undefined));
    assert.equal(b.session.has("sg:utm"), false);
    assert.equal(b.calls.length, 0);

    b.choose(false, true);
    trackWebEvent({ event: "page_view", path: "/book" });
    trackGoogleAdsConversion("AW-test/booking");
    setGoogleAdsEnhancedConversionsUserData({ email: "Person@example.com" });
    assert.equal(b.calls.length, 2);
    assert.equal(b.sent.length, 1);
    assert.equal(readConsentedUtm().gclid, "ad-click");
    assert.equal(readConsentedUtm().fbclid, "meta-click");
    assert.ok(b.cookies.has("myst_utm"));
  } finally {
    b.restore();
  }
});

void test("withdrawal discards pending analytics, including after a quick regrant", () => {
  const b = browser();
  try {
    b.choose(true, true);
    trackWebEvent({ event: "page_view", path: "/book" });
    b.choose(false, false);
    b.choose(true, true);
    flushWebAnalytics();
    assert.equal(b.sent.length, 0);
    b.window.navigator.globalPrivacyControl = true;
    trackWebEvent({ event: "page_view", path: "/book" });
    trackGoogleAdsConversion("AW-test/booking");
    assert.deepEqual(readConsentedUtm(), {});
    assert.equal(b.calls.length, 0);
    assert.equal(b.sent.length, 0);
  } finally {
    b.restore();
  }
});

void test("withdrawing advertising strips campaign data already queued for allowed analytics", async () => {
  const b = browser();
  try {
    b.choose(true, true);
    trackWebEvent({ event: "page_view", path: "/book" });
    b.choose(true, false);
    flushWebAnalytics();
    const payload = JSON.parse(await b.sent[0]!.text()) as {
      events: Array<{ utm?: unknown }>;
    };
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0]!.utm, undefined);
  } finally {
    b.restore();
  }
});

void test("operational partner events avoid public analytics storage and campaign context", async () => {
  const b = browser();
  try {
    b.window.location = new URL(
      "https://example.com/partners/book?utm_source=private",
    );
    trackWebEvent({
      event: "partner_funnel",
      path: "/partners/book",
      privacyMode: "product",
      referrer: "private",
      zip: "private",
    });
    flushWebAnalytics();
    const payload = JSON.parse(await b.sent[0]!.text()) as {
      events: Array<Record<string, unknown>>;
    };
    assert.equal(payload.events[0]!["event"], "partner_funnel");
    assert.equal(payload.events[0]!["utm"], undefined);
    assert.equal(payload.events[0]!["referrer"], undefined);
    assert.equal(payload.events[0]!["zip"], undefined);
    assert.equal(b.local.size, 0);
    assert.equal(b.session.size, 0);
  } finally {
    b.restore();
  }
});

void test("middleware writes attribution only on public pages with advertising consent and no privacy signal", async () => {
  const cases = [
    { cookie: undefined, path: "/book", allowed: false },
    { cookie: consent(false, false), path: "/book", allowed: false },
    { cookie: consent(true, false), path: "/book", allowed: false },
    { cookie: "malformed", path: "/book", allowed: false },
    { cookie: consent(false, true), path: "/book", allowed: true },
    {
      cookie: consent(true, true),
      path: "/book",
      signal: "Sec-GPC",
      allowed: false,
    },
    {
      cookie: consent(true, true),
      path: "/book",
      signal: "DNT",
      allowed: false,
    },
    { cookie: consent(true, true), path: "/team", allowed: false },
    {
      cookie: consent(true, true),
      path: "/quote/private-token",
      allowed: false,
    },
    { cookie: consent(true, true), path: "/api/public", allowed: false },
  ];
  for (const entry of cases) {
    const headers = new Headers();
    if (entry.cookie)
      headers.set("cookie", `${COOKIE_CONSENT_COOKIE}=${entry.cookie}`);
    if (entry.signal) headers.set(entry.signal, "1");
    const response = await middleware(
      new NextRequest(
        `https://example.com${entry.path}?utm_source=google&gclid=click`,
        { headers },
      ),
    );
    const attribution = response.cookies.get("myst_utm");
    assert.equal(Boolean(attribution), entry.allowed, JSON.stringify(entry));
    if (entry.allowed)
      assert.deepEqual(JSON.parse(attribution!.value), {
        source: "google",
        gclid: "click",
      });
  }
});

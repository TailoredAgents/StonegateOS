import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicQuoteAvailabilityResponseSchema } from "@/lib/quote-v2-contract";
import { quoteV2AvailabilityResponseBody } from "@/lib/quote-v2-scheduling-route";
import {
  calculateQuoteV2LivePricing,
  formatQuoteV2AppointmentWindow,
  isQuoteV2PublicEnvelope,
  normalizeQuoteV2Availability,
  normalizeQuoteV2PublicPayload,
  quoteV2ConsentSummary,
  quoteV2ReadOnlyMessage,
  type QuoteV2PublicEnvelope,
} from "../../../site/src/app/quote/[token]/quote-v2-customer-model";
import { createQuoteV2PublicHandlers } from "../../../site/src/app/quote/[token]/quote-v2-public-client";

const REPO_ROOT = join(process.cwd(), "../..");

function source(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function parsedRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON request body.");
  }
  return JSON.parse(init.body) as unknown;
}

function fixture(): QuoteV2PublicEnvelope {
  return {
    quoteId: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
    versionId: "6000319b-e380-4c14-bd60-7366f18c42e4",
    versionNumber: 2,
    quoteNumber: "Q-2026-1001",
    lifecycleState: "issued",
    displayState: "Awaiting client",
    document: {
      schemaVersion: 1,
      documentType: "range",
      audience: "commercial",
      schedulingMode: "self_schedule",
      parties: {
        customerName: "Alex Client",
        companyName: "Example Commercial",
        attentionName: "Alex Client",
        attentionTitle: "Facilities Manager",
        serviceAddress: "200 Service Way, Atlanta, GA 30302",
        projectName: "Warehouse cleanout",
        purchaseOrder: "PO-44",
        preparerName: "Jordan Sales",
      },
      issuer: {
        legalName: "Stonegate Services LLC",
        displayName: "Stonegate",
        address: "Woodstock, GA",
        email: "sales@example.test",
        phoneE164: "+14045550100",
      },
      scope: "Remove and responsibly dispose of the listed material.",
      inclusions: ["Labor", "Disposal"],
      exclusions: ["Hazardous material"],
      assumptions: ["Normal access"],
      pricing: {
        documentType: "range",
        currency: "USD",
        lineItems: [
          {
            id: "base",
            name: "Commercial cleanout",
            quantity: 1.125,
            unit: "load",
            unitPriceMinCents: 10_000,
            unitPriceMaxCents: 12_000,
            selectedByDefault: false,
            displayOrder: 0,
          },
          {
            id: "option-a",
            name: "Standard disposal",
            quantity: 1,
            unit: "project",
            unitPriceMinCents: 5_000,
            unitPriceMaxCents: 7_000,
            optionGroupId: "disposal",
            selectedByDefault: true,
            displayOrder: 1,
          },
          {
            id: "option-b",
            name: "Priority disposal",
            quantity: 1,
            unit: "project",
            unitPriceMinCents: 8_000,
            unitPriceMaxCents: 9_000,
            optionGroupId: "disposal",
            selectedByDefault: false,
            displayOrder: 2,
          },
        ],
        optionGroups: [
          {
            id: "disposal",
            label: "Disposal speed",
            mode: "single",
            minimumSelections: 1,
            maximumSelections: 1,
          },
        ],
        adjustments: [
          {
            id: "discount",
            kind: "discount",
            label: "Approved discount",
            calculation: "percentage",
            basis: "subtotal",
            eligibleLineItemIds: [],
            basisPoints: 1_000,
            displayOrder: 0,
          },
          {
            id: "travel",
            kind: "travel",
            label: "Travel",
            calculation: "fixed",
            basis: "subtotal",
            eligibleLineItemIds: [],
            amountCents: 1_000,
            displayOrder: 1,
          },
        ],
        deposit: { mode: "fixed", amountCents: 5_000 },
      },
      terms: {
        templateVersion: "commercial-v2",
        terms: "Proposal terms",
        paymentTerms: "Deposit before appointment confirmation.",
        changeOrderRules: "Changes require written approval.",
        validityDays: 30,
        consentVersion: "range-consent-v2",
      },
      estimatedDurationMinutes: 240,
      serviceZoneConfirmed: true,
    },
    selectedOptionIds: ["option-a"],
    totals: {
      subtotalMinCents: 16_250,
      subtotalMaxCents: 20_500,
      discountMinCents: 1_625,
      discountMaxCents: 2_050,
      feeMinCents: 1_000,
      feeMaxCents: 1_000,
      totalMinCents: 15_625,
      totalMaxCents: 19_450,
      depositCents: 5_000,
      balanceMinCents: 10_625,
      balanceMaxCents: 14_450,
    },
    issuedAt: "2026-08-30T12:00:00.000Z",
    expiresAt: "2026-09-29T12:00:00.000Z",
    allowedActions: [
      "view",
      "pdf",
      "change",
      "accept",
      "decline",
      "availability",
      "hold",
    ],
    acceptedResponseId: null,
    acceptedAppointmentId: null,
    appointment: null,
  };
}

describe("Quote V2 customer proposal", () => {
  it("normalizes the canonical envelope and rollout wrappers without confusing legacy quotes", () => {
    const envelope = fixture();
    expect(isQuoteV2PublicEnvelope(envelope)).toBe(true);
    expect(normalizeQuoteV2PublicPayload(envelope)).toBe(envelope);
    expect(normalizeQuoteV2PublicPayload({ quote: envelope })).toBe(envelope);
    expect(normalizeQuoteV2PublicPayload({ data: { quote: envelope } })).toBe(
      envelope,
    );
    expect(
      normalizeQuoteV2PublicPayload({
        quote: { id: "legacy", revision: 2, total: 400 },
      }),
    ).toBeNull();
  });

  it("mirrors integer-cent option, range, adjustment, deposit, and balance calculations", () => {
    const envelope = fixture();
    expect(calculateQuoteV2LivePricing(envelope, ["option-a"])).toMatchObject({
      valid: true,
      totals: envelope.totals,
    });
    expect(calculateQuoteV2LivePricing(envelope, ["option-b"])).toMatchObject({
      valid: true,
      totals: {
        subtotalMinCents: 19_250,
        subtotalMaxCents: 22_500,
        discountMinCents: 1_925,
        discountMaxCents: 2_250,
        feeMinCents: 1_000,
        feeMaxCents: 1_000,
        totalMinCents: 18_325,
        totalMaxCents: 21_250,
        depositCents: 5_000,
        balanceMinCents: 13_325,
        balanceMaxCents: 16_250,
      },
    });
    const invalid = calculateQuoteV2LivePricing(envelope, []);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors["disposal"]).toContain("requires");
  });

  it("keeps truly empty availability distinct from provider or payload failure and recommends three slots", () => {
    const availabilityBase = {
      quoteId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      responseId: null,
      timezone: "America/New_York",
      durationMinutes: 120,
      travelBufferMinutes: 30,
      arrivalWindowMeaning:
        "The selected time is the scheduled service start in the timezone shown. Stonegate will confirm any separate arrival window in the booking confirmation.",
      generatedAt: "2026-08-31T16:00:00.000Z",
    };
    expect(
      normalizeQuoteV2Availability({
        availability: {
          ...availabilityBase,
          state: "empty",
          recommendedSlots: [],
          days: [{ date: "2026-09-01", slots: [] }],
        },
      }),
    ).toEqual({
      kind: "empty",
      timezone: "America/New_York",
      arrivalWindowMeaning: availabilityBase.arrivalWindowMeaning,
    });
    const unavailable = normalizeQuoteV2Availability({ ok: false });
    expect(unavailable.kind).toBe("unavailable");
    expect(unavailable.kind === "unavailable" && unavailable.message).toContain(
      "does not mean",
    );
    const slots = [1, 2, 3, 4].map((day) => ({
      startAt: `2026-09-0${day}T13:00:00.000Z`,
      endAt: `2026-09-0${day}T15:00:00.000Z`,
      label: `September ${day} · 9:00 AM`,
    }));
    expect(
      normalizeQuoteV2Availability({
        availability: {
          ...availabilityBase,
          state: "available",
          recommendedSlots: slots.slice(0, 3),
          days: [{ date: "2026-09-01", slots }],
        },
      }),
    ).toMatchObject({
      kind: "available",
      recommended: slots.slice(0, 3),
      arrivalWindowMeaning: availabilityBase.arrivalWindowMeaning,
    });
    expect(
      normalizeQuoteV2Availability({
        ok: true,
        suggestions: slots,
        days: [],
        timezone: "America/New_York",
      }).kind,
    ).toBe("unavailable");
  });

  it("normalizes the exact availability payload emitted by the public API", () => {
    const slot = {
      startAt: "2026-09-08T13:00:00.000Z",
      endAt: "2026-09-08T15:00:00.000Z",
      label: "Tue, Sep 8 · 9:00 AM",
    };
    const body = quoteV2AvailabilityResponseBody({
      state: "available",
      quoteId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      responseId: null,
      timezone: "America/New_York",
      durationMinutes: 120,
      travelBufferMinutes: 30,
      arrivalWindowMeaning:
        "The selected time is the scheduled service start in the timezone shown. Stonegate will confirm any separate arrival window in the booking confirmation.",
      recommendedSlots: [slot],
      days: [{ date: "2026-09-08", slots: [slot] }],
      generatedAt: "2026-08-31T16:00:00.000Z",
    });
    expect(PublicQuoteAvailabilityResponseSchema.parse(body)).toEqual(body);
    expect(body).not.toHaveProperty("suggestions");
    expect(normalizeQuoteV2Availability(body)).toEqual({
      kind: "available",
      recommended: [slot],
      days: [{ date: "2026-09-08", slots: [slot] }],
      timezone: "America/New_York",
      arrivalWindowMeaning:
        "The selected time is the scheduled service start in the timezone shown. Stonegate will confirm any separate arrival window in the booking confirmation.",
    });
  });

  it("posts every customer decision and expired update request to a version-bound endpoint with idempotency", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: requestUrl(url), ...(init ? { init } : {}) });
      return Promise.resolve(
        Response.json({ ok: true, data: { responseId: "response-1" } }),
      );
    };
    const handlers = createQuoteV2PublicHandlers({
      token: "secret-token",
      fetcher: fetcher as typeof fetch,
    });
    const envelope = fixture();
    await handlers.recordVisibleEngagement({
      quoteId: envelope.quoteId,
      versionId: envelope.versionId,
      event: "visible",
      visibleMs: 1_500,
    });
    await handlers.accept({
      decision: "accepted",
      quoteId: envelope.quoteId,
      versionId: envelope.versionId,
      selectedOptionIds: ["option-a"],
      signer: {
        name: "Alex Client",
        title: "Facilities Manager",
        authorityAffirmed: true,
      },
      consentVersion: "range-consent-v2",
      consentAffirmed: true,
      requestedStartAt: null,
    });
    await handlers.requestUpdatedProposal({
      quoteId: envelope.quoteId,
      versionId: envelope.versionId,
      message: "Please account for the revised timing.",
    });
    expect(calls[0]?.url).toBe("/api/public/quotes/secret-token/engagement");
    const engagementHeaders = new Headers(calls[0]?.init?.headers);
    expect(engagementHeaders.get("idempotency-key")).toMatch(
      /^quote-v2:engagement:/u,
    );
    expect(parsedRequestBody(calls[0]?.init)).toMatchObject({
      quoteId: envelope.quoteId,
      versionId: envelope.versionId,
      event: "visible",
    });
    expect(calls[1]?.url).toBe("/api/public/quotes/secret-token");
    const headers = new Headers(calls[1]?.init?.headers);
    expect(headers.get("idempotency-key")).toMatch(/^quote-v2:accept:/u);
    expect(parsedRequestBody(calls[1]?.init)).toMatchObject({
      quoteId: envelope.quoteId,
      versionId: envelope.versionId,
      decision: "accepted",
    });
    expect(calls[2]?.url).toBe("/api/public/quotes/secret-token/refresh");
    const refreshHeaders = new Headers(calls[2]?.init?.headers);
    expect(refreshHeaders.get("idempotency-key")).toMatch(
      /^quote-v2:refresh:/u,
    );
    expect(parsedRequestBody(calls[2]?.init)).toEqual({
      quoteId: envelope.quoteId,
      versionId: envelope.versionId,
      message: "Please account for the revised timing.",
    });
  });

  it("reuses the same idempotency key after an ambiguous engagement failure", async () => {
    const keys: string[] = [];
    let attempt = 0;
    const fetcher = (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("response lost"))
        : Promise.resolve(Response.json({ ok: true, data: {} }));
    };
    const handlers = createQuoteV2PublicHandlers({
      token: "secret-token",
      fetcher: fetcher as typeof fetch,
    });
    const body = {
      quoteId: fixture().quoteId,
      versionId: fixture().versionId,
      event: "visible" as const,
      visibleMs: 1_500,
    };

    await expect(handlers.recordVisibleEngagement(body)).resolves.toMatchObject(
      {
        ok: false,
        retryable: true,
      },
    );
    await expect(handlers.recordVisibleEngagement(body)).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    expect(keys[0]).toMatch(/^quote-v2:engagement:/u);
    expect(keys[1]).toBe(keys[0]);
  });

  it("preserves an expired-update note and idempotency key across an ambiguous retry", async () => {
    const calls: Array<{ key: string; body: unknown }> = [];
    let attempt = 0;
    const fetcher = (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({
        key: new Headers(init?.headers).get("idempotency-key") ?? "",
        body: parsedRequestBody(init),
      });
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("response lost"))
        : Promise.resolve(
            Response.json({ ok: true, responseId: "response-1" }),
          );
    };
    const handlers = createQuoteV2PublicHandlers({
      token: "secret-token",
      fetcher: fetcher as typeof fetch,
    });
    const body = {
      quoteId: fixture().quoteId,
      versionId: fixture().versionId,
      message: "Please retain the revised delivery note.",
    };

    await expect(handlers.requestUpdatedProposal(body)).resolves.toMatchObject({
      ok: false,
      retryable: true,
    });
    await expect(handlers.requestUpdatedProposal(body)).resolves.toMatchObject({
      ok: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).toMatch(/^quote-v2:refresh:/u);
    expect(calls[1]?.key).toBe(calls[0]?.key);
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(calls[1]?.body).toEqual(body);
  });

  it("explains immutable lifecycle and document-specific consent without overstating ranges", () => {
    const envelope = fixture();
    expect(quoteV2ConsentSummary("fixed_quote")).toContain("firm total");
    expect(quoteV2ConsentSummary("estimate")).toContain("non-binding");
    expect(quoteV2ConsentSummary("range")).toContain("non-binding price range");
    expect(
      quoteV2ReadOnlyMessage({
        ...envelope,
        lifecycleState: "superseded",
        displayState: "Superseded",
        allowedActions: ["view", "pdf"],
      }),
    ).toContain("newer version");
    expect(
      quoteV2ReadOnlyMessage({
        ...envelope,
        lifecycleState: "expired",
        displayState: "Expired",
        allowedActions: ["view", "pdf"],
      }),
    ).toContain("read-only");
    expect(
      quoteV2ReadOnlyMessage({
        ...envelope,
        lifecycleState: "issued",
        displayState: "Expired · View only",
        allowedActions: ["view", "pdf", "refresh"],
      }),
    ).toBeNull();
  });

  it("accepts only an exact, sanitized appointment projection and explains each public status", () => {
    const envelope = fixture();
    const appointment = {
      id: "bb5fb953-7c36-4bbd-a079-dfff27f69b8b",
      status: "confirmed" as const,
      startAt: "2026-11-01T05:30:00.000Z",
      endAt: "2026-11-01T07:30:00.000Z",
      timezone: "America/New_York",
      durationMinutes: 120,
      promisedArrivalWindow: {
        startAt: "2026-11-01T05:30:00.000Z",
        endAt: "2026-11-01T06:30:00.000Z",
      },
    };
    const booked: QuoteV2PublicEnvelope = {
      ...envelope,
      allowedActions: ["view", "pdf"],
      acceptedResponseId: "cf17d936-f53a-4e3a-84e6-40b076f18c83",
      acceptedAppointmentId: appointment.id,
      appointment,
    };
    expect(isQuoteV2PublicEnvelope(booked)).toBe(true);
    expect(quoteV2ReadOnlyMessage(booked)).toContain(
      "confirmed appointment details",
    );
    for (const [status, message] of [
      ["requested", "awaiting final confirmation"],
      ["canceled", "no longer active"],
      ["completed", "Service completed"],
    ] as const) {
      expect(
        quoteV2ReadOnlyMessage({
          ...booked,
          appointment: { ...appointment, status },
        }),
      ).toContain(message);
    }
    expect(
      isQuoteV2PublicEnvelope({
        ...booked,
        acceptedAppointmentId: "c7b478e5-c698-474f-88c6-8fccab4d45f1",
      }),
    ).toBe(false);
    expect(
      isQuoteV2PublicEnvelope({
        ...booked,
        appointment: { ...appointment, status: "no_show" },
      }),
    ).toBe(false);
    expect(
      isQuoteV2PublicEnvelope({
        ...booked,
        appointment: { ...appointment, timezone: "Mars/Base" },
      }),
    ).toBe(false);
  });

  it("labels cross-midnight and DST appointment ranges without an ambiguous end date", () => {
    const overnight = formatQuoteV2AppointmentWindow(
      "2026-09-04T03:00:00.000Z",
      "2026-09-04T05:00:00.000Z",
      "America/New_York",
    );
    expect(overnight).toMatchObject({
      startDate: "Thursday, Sep 3, 2026",
      startTime: "11:00 PM EDT",
      endDate: "Friday, Sep 4, 2026",
      endTime: "1:00 AM EDT",
      spansLocalDates: true,
    });

    const dstFallback = formatQuoteV2AppointmentWindow(
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T07:30:00.000Z",
      "America/New_York",
    );
    expect(dstFallback).toMatchObject({
      startDate: "Sunday, Nov 1, 2026",
      startTime: "1:30 AM EDT",
      endDate: "Sunday, Nov 1, 2026",
      endTime: "2:30 AM EST",
      spansLocalDates: false,
    });
  });

  it("renders the mobile-first, accessible, semantic V2 surface behind a narrow legacy-safe branch", () => {
    const component = source(
      "apps/site/src/app/quote/[token]/QuoteV2CustomerProposal.tsx",
    );
    const model = source(
      "apps/site/src/app/quote/[token]/quote-v2-customer-model.ts",
    );
    const theme = source(
      "apps/site/src/app/quote/[token]/QuoteV2CustomerProposal.module.css",
    );
    const page = source("apps/site/src/app/quote/[token]/page.tsx");

    for (const text of [
      "Approve &amp; continue",
      "Request changes",
      "Request updated proposal",
      "This version will stay read-only",
      "Decline proposal",
      "Select proposal options",
      "Scope, inclusions &amp; exclusions",
      "Payment &amp; scheduling",
      "Terms &amp; change rules",
      "three recommended",
    ]) {
      const combined = `${component}\n${model}`;
      expect(combined.toLowerCase()).toContain(text.toLowerCase());
    }
    expect(component).toContain('name="quoteId"');
    expect(component).toContain('name="versionId"');
    expect(component).toContain("value={changeMessage}");
    expect(component).toContain("value={refreshMessage}");
    expect(component).toContain("requestUpdatedProposal");
    expect(component).toContain("value={declineNotes}");
    expect(component).toContain('aria-live="polite"');
    expect(component).toContain("aria-invalid=");
    expect(component).toContain("min-h-11");
    expect(component).toContain(
      'globalThis.document.visibilityState !== "visible"',
    );
    expect(component).toContain("recordVisibleEngagement");
    expect(component).toContain("overflow-x-clip");
    expect(component).toContain('data-availability-state="empty"');
    expect(component).toContain('data-availability-state="unavailable"');
    expect(component).toContain("<time dateTime={startAt}>");
    expect(component).toContain("label.spansLocalDates");
    expect(component).toContain("Promised arrival window");
    expect(component).toContain("Scheduled service time");
    expect(component).toContain("not a separate arrival window");
    expect(component).toContain("data-appointment-status={appointment.status}");
    const autoAvailabilityStart = component.indexOf(
      'availability.kind !== "idle"',
    );
    const autoAvailabilityEnd = component.indexOf(
      "function openPanel",
      autoAvailabilityStart,
    );
    expect(
      component.slice(autoAvailabilityStart, autoAvailabilityEnd),
    ).not.toContain('setAvailability({ kind: "loading" })');
    expect(component).toContain("var(--quote-");
    expect(component).not.toContain("bg-white");
    expect(component).not.toContain("text-slate");
    expect(component).not.toContain("primary-950");
    expect(theme).toContain("@media (prefers-color-scheme: dark)");
    expect(theme).toContain("@media (prefers-reduced-motion: reduce)");
    expect(page).toContain("normalizeQuoteV2PublicPayload(data)");
    expect(page).toContain('loadedQuote.kind === "v2"');
    expect(page).toContain("<QuoteV2CustomerProposal");
    expect(page).toContain('referrer: "no-referrer"');
    expect(page).toContain('dynamic = "force-dynamic"');
    expect(page).toContain("revalidate = 0");
  });
});

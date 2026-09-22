import { jest } from "@jest/globals";
import {
  inspectOpenAiAdsConfiguration,
  OPENAI_ADS_MAX_EVENT_AGE_MS,
  OPENAI_ADS_TIMEOUT_MS,
  parseOpenAiAdsEvent,
  sendOpenAiAdsConversion,
  type OpenAiAdsEvent,
} from "@/lib/openai-ads";
import { processOpenAiAdsConversionOutbox } from "@/lib/openai-ads-outbox";
import { planOutboxOutcomeFinalization } from "@/lib/outbox-finalization";

const environment = {
  OPENAI_ADS_ENABLED: "1",
  OPENAI_ADS_PIXEL_ID: "test_pixel",
  OPENAI_ADS_CONVERSIONS_API_KEY: "test-secret-must-stay-server-side",
};
const consentId = "734281d8-ddf8-4489-a659-24c05df7b7e2";
const now = new Date("2026-09-15T12:00:00Z");
const event: OpenAiAdsEvent = {
  id: "booking:appointment-123",
  type: "appointment_scheduled",
  timestamp_ms: now.getTime(),
  action_source: "web",
  source_url: "https://stonegate.example/book",
  oppref: "original_opaque_reference",
  user: {
    obref: "original-browser-reference",
    emails_sha256: ["a".repeat(64)],
  },
  data: { type: "customer_action" },
};

describe("OpenAI conversion delivery", () => {
  it("sends the exact event with a stable ID, correct auth, fixed endpoint, and redirects disabled", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ accepted_events: 1 })));
    expect(
      await sendOpenAiAdsConversion(event, {
        environment: {
          ...environment,
          OPENAI_ADS_API_BASE_URL: "https://untrusted.example",
        },
        fetchImpl,
      }),
    ).toEqual({ ok: true });
    const [url, request] = fetchImpl.mock.calls[0]!;
    if (!(url instanceof URL)) throw new Error("Expected provider URL");
    expect(url.toString()).toBe(
      "https://bzr.openai.com/v1/events?pid=test_pixel",
    );
    expect(request?.redirect).toBe("error");
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.headers).toMatchObject({
      Authorization: `Bearer ${environment.OPENAI_ADS_CONVERSIONS_API_KEY}`,
    });
    if (typeof request?.body !== "string")
      throw new Error("Expected JSON request body");
    expect(JSON.parse(request.body) as unknown).toEqual({
      validate_only: false,
      integration_source: "stonegateos",
      events: [event],
    });
  });

  it("supports validation without recording a conversion", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ accepted_events: 1 })));
    await sendOpenAiAdsConversion(event, {
      environment,
      fetchImpl,
      validateOnly: true,
    });
    const body = fetchImpl.mock.calls[0]![1]?.body;
    if (typeof body !== "string") throw new Error("Expected JSON request body");
    expect(JSON.parse(body) as unknown).toMatchObject({ validate_only: true });
  });

  it.each([
    { OPENAI_ADS_ENABLED: "0" },
    { OPENAI_ADS_CONVERSIONS_API_KEY: "" },
    { OPENAI_ADS_PIXEL_ID: "invalid/id" },
    { E2E_RUN_ID: "hermetic-audit" },
    { NODE_ENV: "production", E2E_RUN_ID: "partial-sentinel" },
    {
      NODE_ENV: "production",
      E2E_RUN_ID: "hermetic-audit",
      TEAM_CRM_AUDIT_MODE: "1",
    },
    { TEAM_KILL_EXTERNAL_SENDS: "true" },
    { TEAM_KILL_OUTBOX_DISPATCH: "1" },
  ])(
    "never calls the provider when disabled, misconfigured, killed, or in controlled tests: %j",
    async (overrides) => {
      const fetchImpl = jest.fn<typeof fetch>();
      const result = await sendOpenAiAdsConversion(event, {
        environment: { ...environment, ...overrides },
        fetchImpl,
      });
      expect(result).toMatchObject({ ok: false, retryable: true });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(
        environment.OPENAI_ADS_CONVERSIONS_API_KEY,
      );
    },
  );

  it("exposes safe configuration metadata without a secret", () => {
    const configuration = inspectOpenAiAdsConfiguration(environment);
    expect(configuration).toMatchObject({
      configured: true,
      enabled: true,
      pixelId: "test_pixel",
    });
    expect(JSON.stringify(configuration)).not.toContain(
      environment.OPENAI_ADS_CONVERSIONS_API_KEY,
    );
  });

  it.each([401, 403, 408, 425, 429, 500, 503])(
    "retries HTTP %i using only a sanitized error code",
    async (status) => {
      const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
        new Response("email@example.test secret token", {
          status,
          headers: { "retry-after": "120" },
        }),
      );
      expect(
        await sendOpenAiAdsConversion(event, { environment, fetchImpl }),
      ).toEqual({
        ok: false,
        retryable: true,
        code: `openai_ads_http_${status}`,
        retryAfterMs: 120_000,
      });
    },
  );

  it.each([400, 404, 413, 422])(
    "quarantines permanent HTTP %i failures",
    async (status) => {
      const fetchImpl = jest
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("sensitive rejected payload", { status }),
        );
      expect(
        await sendOpenAiAdsConversion(event, { environment, fetchImpl }),
      ).toEqual({
        ok: false,
        retryable: false,
        code: `openai_ads_http_${status}`,
      });
    },
  );

  it.each(["{}", '{"accepted_events":0}', "not-json"])(
    "does not mark an ambiguous success response as delivered: %s",
    async (body) => {
      const fetchImpl = jest
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body));
      expect(
        await sendOpenAiAdsConversion(event, { environment, fetchImpl }),
      ).toEqual({
        ok: false,
        retryable: true,
        code: "openai_ads_acknowledgement_invalid",
      });
    },
  );

  it("bounds provider time with an abort and never reports exception contents", async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn<typeof fetch>().mockImplementation(
        (_url, request) =>
          new Promise((_resolve, reject) => {
            request?.signal?.addEventListener(
              "abort",
              () =>
                reject(new Error("secret credential in provider exception")),
              { once: true },
            );
          }),
      );
      const delivery = sendOpenAiAdsConversion(event, {
        environment,
        fetchImpl,
      });
      await jest.advanceTimersByTimeAsync(OPENAI_ADS_TIMEOUT_MS);
      expect(await delivery).toEqual({
        ok: false,
        retryable: true,
        code: "openai_ads_timeout",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("requires a source URL for web events and refuses raw identifiers", () => {
    expect(
      parseOpenAiAdsEvent({ ...event, source_url: "not a URL" }),
    ).toBeNull();
    expect(parseOpenAiAdsEvent({ ...event, source_url: undefined })).toBeNull();
    expect(
      parseOpenAiAdsEvent({ ...event, user: { email: "person@example.test" } }),
    ).toBeNull();
    expect(
      parseOpenAiAdsEvent({
        ...event,
        user: { emails_sha256: ["person@example.test"] },
      }),
    ).toBeNull();
    expect(
      parseOpenAiAdsEvent({
        ...event,
        source_url: "https://secret:password@example.test/book",
      }),
    ).toBeNull();
    expect(
      parseOpenAiAdsEvent({
        ...event,
        type: "lead_created",
        action_source: "phone_call",
        source_url: undefined,
      }),
    ).not.toBeNull();
  });
});

describe("durable OpenAI conversion retries", () => {
  it("suppresses a revoked grant even when its booking arrives after the opt-out", async () => {
    const send = jest.fn<typeof sendOpenAiAdsConversion>();
    const isConsentRevoked = jest
      .fn<(id: string) => Promise<boolean>>()
      .mockResolvedValue(true);
    expect(
      await processOpenAiAdsConversionOutbox(
        { event, consentId },
        { now, send, isConsentRevoked },
      ),
    ).toMatchObject({
      status: "quarantined",
      error: "openai_ads_consent_revoked",
    });
    expect(isConsentRevoked).toHaveBeenCalledWith(consentId);
    expect(send).not.toHaveBeenCalled();
  });

  it("defers safely when the durable consent check is unavailable", async () => {
    const send = jest.fn<typeof sendOpenAiAdsConversion>();
    const isConsentRevoked = jest
      .fn<(id: string) => Promise<boolean>>()
      .mockRejectedValue(new Error("database unavailable"));
    expect(
      await processOpenAiAdsConversionOutbox(
        { event, consentId },
        { now, send, isConsentRevoked },
      ),
    ).toMatchObject({ status: "retry", error: "openai_ads_delivery_error" });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not deliver records without a consent identity", async () => {
    const send = jest.fn<typeof sendOpenAiAdsConversion>();
    expect(
      await processOpenAiAdsConversionOutbox({ event }, { now, send }),
    ).toMatchObject({
      status: "quarantined",
      error: "openai_ads_consent_missing",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("retains unexpected adapter failures without recording sensitive exception details", async () => {
    const send = jest
      .fn<typeof sendOpenAiAdsConversion>()
      .mockRejectedValue(new Error("sensitive request details"));
    const outcome = await processOpenAiAdsConversionOutbox(
      { event, consentId },
      { now, send, isConsentRevoked: () => Promise.resolve(false) },
    );
    expect(outcome).toMatchObject({
      status: "retry",
      error: "openai_ads_delivery_error",
    });
    expect(JSON.stringify(outcome)).not.toContain("sensitive");
  });
  it("retains auth failures beyond the generic outbox attempt limit", async () => {
    const send = jest.fn<typeof sendOpenAiAdsConversion>().mockResolvedValue({
      ok: false,
      retryable: true,
      code: "openai_ads_http_401",
    });
    const outcome = await processOpenAiAdsConversionOutbox(
      { event, consentId },
      { now, send, isConsentRevoked: () => Promise.resolve(false) },
    );
    const finalized = planOutboxOutcomeFinalization(
      { attempts: 99 },
      outcome,
      now,
    );
    expect(finalized.processedAt).toBeUndefined();
    expect(finalized.quarantinedAt).toBeUndefined();
    expect(finalized.nextAttemptAt).toEqual(
      new Date(now.getTime() + 60 * 60_000),
    );
    expect(finalized.lastError).toBe("openai_ads_http_401");
    expect(send).toHaveBeenCalledWith(event);
  });

  it("marks only provider acceptance as processed", async () => {
    const send = jest
      .fn<typeof sendOpenAiAdsConversion>()
      .mockResolvedValue({ ok: true });
    expect(
      await processOpenAiAdsConversionOutbox(
        { event, consentId },
        { now, send, isConsentRevoked: () => Promise.resolve(false) },
      ),
    ).toEqual({ status: "processed" });
  });

  it("quarantines permanently rejected conversions without discarding them", async () => {
    const send = jest.fn<typeof sendOpenAiAdsConversion>().mockResolvedValue({
      ok: false,
      retryable: false,
      code: "openai_ads_http_400",
    });
    const outcome = await processOpenAiAdsConversionOutbox(
      { event, consentId },
      { now, send, isConsentRevoked: () => Promise.resolve(false) },
    );
    const finalized = planOutboxOutcomeFinalization(
      { attempts: 0 },
      outcome,
      now,
    );
    expect(finalized.processedAt).toBeUndefined();
    expect(finalized.quarantinedAt).toEqual(now);
    expect(finalized.lastError).toBe("openai_ads_http_400");
  });

  it.each([
    { timestamp_ms: now.getTime() - OPENAI_ADS_MAX_EVENT_AGE_MS - 1 },
    { timestamp_ms: now.getTime() + 11 * 60_000 },
    { id: "" },
  ])(
    "quarantines expired or invalid records before any provider call: %j",
    async (overrides) => {
      const send = jest.fn<typeof sendOpenAiAdsConversion>();
      expect(
        await processOpenAiAdsConversionOutbox(
          { event: { ...event, ...overrides } },
          { now, send, isConsentRevoked: () => Promise.resolve(false) },
        ),
      ).toMatchObject({ status: "quarantined" });
      expect(send).not.toHaveBeenCalled();
    },
  );
});

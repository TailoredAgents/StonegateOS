import {
  createTwilioProviderCall,
  createTwilioProviderMessage,
  deleteTwilioProviderRecording,
  downloadTwilioProviderRecording,
  fetchTwilioProviderMedia,
  listTwilioProviderRecordings,
} from "@/lib/twilio-provider";

const accountSid = `AC${"0".repeat(32)}`;
const callSid = `CA${"1".repeat(32)}`;
const messageSid = `SM${"2".repeat(32)}`;
const recordingSid = `RE${"3".repeat(32)}`;
const mediaSid = `ME${"4".repeat(32)}`;
const mediaMessageSid = `MM${"5".repeat(32)}`;
const requestKey = "11111111-1111-4111-8111-111111111111";
const eventKey = "22222222-2222-4222-8222-222222222222";
const operationKey = "33333333-3333-4333-8333-333333333333";
const environment = {
  E2E_RUN_ID: "twilio-provider-adapter",
  TWILIO_ACCOUNT_SID: accountSid,
  TWILIO_AUTH_TOKEN: "private-test-token",
  TWILIO_FROM: "+15555550101",
  TWILIO_API_BASE_URL: "http://127.0.0.1:4010",
  TWILIO_WEBHOOK_PUBLIC_BASE_URL: "http://127.0.0.1:3001",
};
const callInput = {
  to: "+15555550102",
  requestUrl: `http://127.0.0.1:3001/api/webhooks/twilio/connect?requestKey=${requestKey}`,
  statusCallbackUrl: `http://127.0.0.1:3001/api/webhooks/twilio/call-status?leg=agent&requestKey=${requestKey}`,
};

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function options(fetchImpl: typeof fetch, timeoutMs?: number) {
  return { environment, fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) };
}

describe("central Twilio production adapter", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("accepts only structurally valid message and call receipts", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(responseJson({ sid: messageSid }, 201))
      .mockResolvedValueOnce(
        responseJson({ sid: callSid }, 201),
      ) as typeof fetch;

    await expect(
      createTwilioProviderMessage(
        { to: "+15555550103", body: "synthetic message" },
        options(fetchImpl),
      ),
    ).resolves.toEqual({ ok: true, messageSid });
    await expect(
      createTwilioProviderCall(callInput, options(fetchImpl)),
    ).resolves.toEqual({ ok: true, callSid });

    const firstRequest = (fetchImpl as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(firstRequest[0]).toContain("/Messages.json");
    const headers = firstRequest[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toMatch(/^Basic /u);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("fails before fetch on missing, partial, unsafe, or invalid input", async () => {
    const fetchImpl = jest.fn() as typeof fetch;
    await expect(
      createTwilioProviderMessage(
        { to: "+15555550103", body: "synthetic" },
        { environment: {}, fetchImpl },
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "not_configured",
      certainty: "not_applied",
    });
    await expect(
      createTwilioProviderMessage(
        { to: "+15555550103", body: "synthetic" },
        {
          environment: {
            ...environment,
            TWILIO_AUTH_TOKEN: undefined,
          },
          fetchImpl,
        },
      ),
    ).resolves.toMatchObject({ ok: false, code: "invalid_configuration" });
    await expect(
      createTwilioProviderCall(
        { ...callInput, to: "not-a-phone" },
        options(fetchImpl),
      ),
    ).resolves.toMatchObject({ ok: false, code: "invalid_input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces the server-side external-send kill switch before provider work", async () => {
    const fetchImpl = jest.fn() as typeof fetch;
    const disabledEnvironment = {
      ...environment,
      TEAM_KILL_EXTERNAL_SENDS: "1",
    };
    await expect(
      createTwilioProviderMessage(
        { to: "+15555550103", body: "synthetic" },
        { environment: disabledEnvironment, fetchImpl },
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "operation_disabled",
      certainty: "not_applied",
      retryable: true,
    });
    await expect(
      createTwilioProviderCall(callInput, {
        environment: disabledEnvironment,
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "operation_disabled",
      certainty: "not_applied",
      retryable: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {
      requestUrl: `https://attacker.example/api/webhooks/twilio/connect?requestKey=${requestKey}`,
    },
    {
      requestUrl: `http://127.0.0.1:3001/api/webhooks/twilio/private?requestKey=${requestKey}`,
    },
    {
      requestUrl: `http://user:secret@127.0.0.1:3001/api/webhooks/twilio/connect?requestKey=${requestKey}`,
    },
    {
      requestUrl: `http://127.0.0.1:3001/api/webhooks/twilio/connect?requestKey=${requestKey}#private`,
    },
    {
      requestUrl: `http://127.0.0.1:3001/api/webhooks/twilio/connect?requestKey=${requestKey}&to=%2B15555550100`,
    },
    {
      statusCallbackUrl: `http://127.0.0.1:3001/api/webhooks/twilio/call-status?leg=agent&requestKey=${requestKey}&taskId=private`,
    },
  ])("rejects an unbound provider callback URL %j", async (override) => {
    const fetchImpl = jest.fn() as typeof fetch;
    await expect(
      createTwilioProviderCall(
        { ...callInput, ...override },
        options(fetchImpl),
      ),
    ).resolves.toMatchObject({ ok: false, code: "invalid_input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("binds escalation callbacks to both the event and exact operation attempt", async () => {
    const escalationInput = {
      to: "+15555550102",
      requestUrl: `http://127.0.0.1:3001/api/webhooks/twilio/escalate?eventKey=${eventKey}&operationKey=${operationKey}`,
      statusCallbackUrl: `http://127.0.0.1:3001/api/webhooks/twilio/call-status?leg=agent&mode=sales_escalation&eventKey=${eventKey}&operationKey=${operationKey}`,
    };
    const accepted = jest.fn(() =>
      Promise.resolve(responseJson({ sid: callSid }, 201)),
    ) as typeof fetch;
    await expect(
      createTwilioProviderCall(escalationInput, options(accepted)),
    ).resolves.toEqual({ ok: true, callSid });

    for (const unsafe of [
      {
        ...escalationInput,
        requestUrl: `http://127.0.0.1:3001/api/webhooks/twilio/escalate?eventKey=${eventKey}`,
      },
      {
        ...escalationInput,
        statusCallbackUrl: `http://127.0.0.1:3001/api/webhooks/twilio/call-status?leg=agent&mode=sales_escalation&eventKey=${eventKey}`,
      },
    ]) {
      const neverCalled = jest.fn() as typeof fetch;
      await expect(
        createTwilioProviderCall(unsafe, options(neverCalled)),
      ).resolves.toMatchObject({ ok: false, code: "invalid_input" });
      expect(neverCalled).not.toHaveBeenCalled();
    }
  });

  it("allows public HTTPS media only outside controlled runs and never allows public HTTP", async () => {
    const receipt = jest.fn(() =>
      Promise.resolve(responseJson({ sid: messageSid }, 201)),
    ) as typeof fetch;
    const ordinaryEnvironment = {
      ...environment,
      E2E_RUN_ID: undefined,
      TWILIO_API_BASE_URL: "https://api.twilio.com",
    };
    await expect(
      createTwilioProviderMessage(
        {
          to: "+15555550103",
          body: "synthetic",
          mediaUrls: ["https://storage.example.test/object?signature=safe"],
        },
        { environment: ordinaryEnvironment, fetchImpl: receipt },
      ),
    ).resolves.toEqual({ ok: true, messageSid });

    const productionLoopbackMedia = jest.fn() as typeof fetch;
    await expect(
      createTwilioProviderMessage(
        {
          to: "+15555550103",
          body: "synthetic",
          mediaUrls: ["http://127.0.0.1:4011/private.jpg"],
        },
        {
          environment: {
            ...ordinaryEnvironment,
            NODE_ENV: "production",
            TWILIO_WEBHOOK_PUBLIC_BASE_URL: "https://api.example.test",
          },
          fetchImpl: productionLoopbackMedia,
        },
      ),
    ).resolves.toMatchObject({ ok: false, code: "invalid_input" });
    expect(productionLoopbackMedia).not.toHaveBeenCalled();

    const neverCalled = jest.fn() as typeof fetch;
    for (const mediaUrl of [
      "http://storage.example.test/object",
      "https://storage.example.test/object?signature=audit",
      "https://user:secret@storage.example.test/object",
      "https://storage.example.test/object#private",
    ]) {
      await expect(
        createTwilioProviderMessage(
          { to: "+15555550103", body: "synthetic", mediaUrls: [mediaUrl] },
          options(neverCalled),
        ),
      ).resolves.toMatchObject({ ok: false, code: "invalid_input" });
    }
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it("caps outbound provider media at ten URLs before the provider boundary", async () => {
    const tenMedia = Array.from(
      { length: 10 },
      (_, index) => `http://127.0.0.1:4011/media-${index}.jpg`,
    );
    const accepted = jest.fn(() =>
      Promise.resolve(responseJson({ sid: messageSid }, 201)),
    ) as typeof fetch;
    await expect(
      createTwilioProviderMessage(
        { to: "+15555550103", body: "synthetic", mediaUrls: tenMedia },
        options(accepted),
      ),
    ).resolves.toEqual({ ok: true, messageSid });
    const acceptedMock = accepted as jest.MockedFunction<typeof fetch>;
    const requestBody = acceptedMock.mock.calls[0]?.[1]?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") {
      throw new Error("expected_url_encoded_twilio_request");
    }
    const body = new URLSearchParams(requestBody);
    expect(body.getAll("MediaUrl")).toHaveLength(10);

    const rejected = jest.fn() as typeof fetch;
    await expect(
      createTwilioProviderMessage(
        {
          to: "+15555550103",
          body: "synthetic",
          mediaUrls: [...tenMedia, "http://127.0.0.1:4011/media-10.jpg"],
        },
        options(rejected),
      ),
    ).resolves.toMatchObject({ ok: false, code: "invalid_input" });
    expect(rejected).not.toHaveBeenCalled();
  });

  it("supports ordinary and dual-sentinel production without permitting a partial sentinel or public audit provider", async () => {
    const ordinaryFetch = jest.fn(() =>
      Promise.resolve(responseJson({ sid: messageSid }, 201)),
    ) as typeof fetch;
    await expect(
      createTwilioProviderMessage(
        { to: "+15555550103", body: "synthetic" },
        {
          environment: {
            ...environment,
            NODE_ENV: "production",
            E2E_RUN_ID: undefined,
            TWILIO_API_BASE_URL: "https://api.twilio.com",
            TWILIO_WEBHOOK_PUBLIC_BASE_URL: "https://api.example.test",
          },
          fetchImpl: ordinaryFetch,
        },
      ),
    ).resolves.toEqual({ ok: true, messageSid });

    const controlledFetch = jest.fn(() =>
      Promise.resolve(responseJson({ sid: messageSid }, 201)),
    ) as typeof fetch;
    await expect(
      createTwilioProviderMessage(
        { to: "+15555550103", body: "synthetic" },
        {
          environment: {
            ...environment,
            NODE_ENV: "production",
            TEAM_CRM_AUDIT_MODE: "1",
          },
          fetchImpl: controlledFetch,
        },
      ),
    ).resolves.toEqual({ ok: true, messageSid });

    for (const unsafeEnvironment of [
      { ...environment, NODE_ENV: "production" },
      {
        ...environment,
        NODE_ENV: "production",
        E2E_RUN_ID: undefined,
        TEAM_CRM_AUDIT_MODE: undefined,
      },
      {
        ...environment,
        NODE_ENV: "production",
        TEAM_CRM_AUDIT_MODE: "1",
        E2E_RUN_ID: undefined,
      },
      {
        ...environment,
        NODE_ENV: "production",
        TEAM_CRM_AUDIT_MODE: "true",
      },
      {
        ...environment,
        NODE_ENV: "production",
        TEAM_CRM_AUDIT_MODE: "1",
        TWILIO_API_BASE_URL: "https://api.twilio.com",
      },
    ]) {
      const neverCalled = jest.fn() as typeof fetch;
      await expect(
        createTwilioProviderMessage(
          { to: "+15555550103", body: "synthetic" },
          { environment: unsafeEnvironment, fetchImpl: neverCalled },
        ),
      ).resolves.toMatchObject({
        ok: false,
        code: "invalid_configuration",
        certainty: "not_applied",
      });
      expect(neverCalled).not.toHaveBeenCalled();
    }
  });

  it.each([
    [400, "provider_rejected", "not_applied", false],
    [429, "rate_limited", "not_applied", true],
    [503, "provider_failed", "uncertain", true],
  ] as const)(
    "classifies effectful HTTP %s without reading its body",
    async (status, code, certainty, retryable) => {
      const cancel = jest.fn(() => Promise.resolve());
      const fetchImpl = jest.fn(() =>
        Promise.resolve({
          ok: false,
          status,
          body: { cancel },
        } as unknown as Response),
      ) as typeof fetch;
      await expect(
        createTwilioProviderCall(callInput, options(fetchImpl)),
      ).resolves.toMatchObject({
        ok: false,
        status,
        code,
        certainty,
        retryable,
      });
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects malformed and oversized 2xx receipts as uncertain", async () => {
    const malformed = jest.fn(() =>
      Promise.resolve(
        new Response("{broken", {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as typeof fetch;
    await expect(
      createTwilioProviderMessage(
        { to: "+15555550103", body: "synthetic" },
        options(malformed),
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "malformed_response",
      certainty: "uncertain",
    });

    const oversized = jest.fn(() =>
      Promise.resolve(
        new Response("{}", {
          status: 201,
          headers: {
            "content-type": "application/json",
            "content-length": "1000001",
          },
        }),
      ),
    ) as typeof fetch;
    await expect(
      createTwilioProviderCall(callInput, options(oversized)),
    ).resolves.toMatchObject({
      ok: false,
      code: "response_too_large",
      certainty: "uncertain",
    });
  });

  it("bounds provider time and treats timeout/transport as uncertain effects", async () => {
    const timeoutFetch = jest.fn(
      (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    ) as typeof fetch;
    await expect(
      createTwilioProviderCall(callInput, options(timeoutFetch, 100)),
    ).resolves.toMatchObject({
      ok: false,
      code: "timeout",
      certainty: "uncertain",
      retryable: true,
    });

    const transportFetch = jest.fn(() =>
      Promise.reject(new Error("private transport detail")),
    ) as typeof fetch;
    await expect(
      createTwilioProviderCall(callInput, options(transportFetch)),
    ).resolves.toMatchObject({
      ok: false,
      code: "transport_error",
      detail: "twilio_transport_error",
      certainty: "uncertain",
    });
  });

  it("distinguishes a legitimate empty recording list from unavailable or malformed data", async () => {
    const empty = jest.fn(() =>
      Promise.resolve(responseJson({ recordings: [], next_page_uri: null })),
    ) as typeof fetch;
    await expect(
      listTwilioProviderRecordings(callSid, options(empty)),
    ).resolves.toEqual({ ok: true, recordings: [], empty: true });

    const unavailable = jest.fn(() =>
      Promise.resolve(responseJson({ code: 20500 }, 503)),
    ) as typeof fetch;
    await expect(
      listTwilioProviderRecordings(callSid, options(unavailable)),
    ).resolves.toMatchObject({
      ok: false,
      code: "provider_failed",
      retryable: true,
    });

    const malformed = jest.fn(() =>
      Promise.resolve(responseJson({ recordings: [{ sid: "REbad" }] })),
    ) as typeof fetch;
    await expect(
      listTwilioProviderRecordings(callSid, options(malformed)),
    ).resolves.toMatchObject({ ok: false, code: "malformed_response" });
  });

  it("does not require a sender number for recording cleanup", async () => {
    const cleanupEnvironment = { ...environment, TWILIO_FROM: undefined };
    const list = jest.fn(() =>
      Promise.resolve(responseJson({ recordings: [], next_page_uri: null })),
    ) as typeof fetch;
    await expect(
      listTwilioProviderRecordings(callSid, {
        environment: cleanupEnvironment,
        fetchImpl: list,
      }),
    ).resolves.toEqual({ ok: true, recordings: [], empty: true });

    const remove = jest.fn(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    ) as typeof fetch;
    await expect(
      deleteTwilioProviderRecording(recordingSid, {
        environment: cleanupEnvironment,
        fetchImpl: remove,
      }),
    ).resolves.toMatchObject({ ok: true, deleted: true });
  });

  it("bounds Twilio media and strips credentials from approved redirects", async () => {
    const ordinaryEnvironment = {
      ...environment,
      E2E_RUN_ID: undefined,
      TWILIO_API_BASE_URL: "https://api.twilio.com",
    };
    const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${mediaMessageSid}/Media/${mediaSid}`;
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://media.twiliocdn.com/private.png" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(png, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ) as typeof fetch;
    await expect(
      fetchTwilioProviderMedia(mediaUrl, {
        environment: ordinaryEnvironment,
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      ok: true,
      declaredContentType: "image/png",
    });
    const fetchMock = fetchImpl as jest.MockedFunction<typeof fetch>;
    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const redirectedHeaders = new Headers(
      fetchMock.mock.calls[1]?.[1]?.headers,
    );
    expect(firstHeaders.get("Authorization")).toMatch(/^Basic /u);
    expect(redirectedHeaders.get("Authorization")).toBeNull();

    const forbiddenRedirect = jest.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://credential-sink.example/media" },
        }),
      ),
    ) as typeof fetch;
    await expect(
      fetchTwilioProviderMedia(mediaUrl, {
        environment: ordinaryEnvironment,
        fetchImpl: forbiddenRedirect,
      }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_input" });

    const oversized = jest.fn(() =>
      Promise.resolve(
        new Response("x", {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(10 * 1024 * 1024 + 1),
          },
        }),
      ),
    ) as typeof fetch;
    await expect(
      fetchTwilioProviderMedia(mediaUrl, {
        environment: ordinaryEnvironment,
        fetchImpl: oversized,
      }),
    ).resolves.toMatchObject({ ok: false, code: "response_too_large" });
  });

  it("downloads only bounded audio with an allowed content type", async () => {
    const success = jest.fn(() =>
      Promise.resolve(
        new Response(Buffer.from("synthetic-audio"), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        }),
      ),
    ) as typeof fetch;
    await expect(
      downloadTwilioProviderRecording(recordingSid, options(success)),
    ).resolves.toMatchObject({
      ok: true,
      contentType: "audio/wav",
      filename: "call.wav",
    });

    const oversized = jest.fn(() =>
      Promise.resolve(
        new Response("x", {
          status: 200,
          headers: {
            "content-type": "audio/wav",
            "content-length": String(25 * 1024 * 1024 + 1),
          },
        }),
      ),
    ) as typeof fetch;
    await expect(
      downloadTwilioProviderRecording(recordingSid, options(oversized)),
    ).resolves.toMatchObject({ ok: false, code: "response_too_large" });
  });

  it("defines 404 delete as idempotent absence but never succeeds provider failure", async () => {
    const absent = jest.fn(() =>
      Promise.resolve(responseJson({ code: 20404 }, 404)),
    ) as typeof fetch;
    await expect(
      deleteTwilioProviderRecording(recordingSid, options(absent)),
    ).resolves.toEqual({
      ok: true,
      deleted: false,
      alreadyAbsent: true,
      status: 404,
    });

    const providerFailure = jest.fn(() =>
      Promise.resolve(responseJson({ code: 20500 }, 503)),
    ) as typeof fetch;
    await expect(
      deleteTwilioProviderRecording(recordingSid, options(providerFailure)),
    ).resolves.toMatchObject({
      ok: false,
      code: "provider_failed",
      certainty: "uncertain",
      retryable: true,
    });
  });

  it("does not log credentials, recipients, content, URLs, errors, or SIDs", async () => {
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const info = jest
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const error = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchImpl = jest.fn(() =>
      Promise.reject(new Error("private-error-marker")),
    ) as typeof fetch;
    await createTwilioProviderMessage(
      {
        to: "+15555550103",
        body: "private-message-marker",
        mediaUrls: ["http://127.0.0.1:4011/private-marker.jpg"],
      },
      options(fetchImpl),
    );
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

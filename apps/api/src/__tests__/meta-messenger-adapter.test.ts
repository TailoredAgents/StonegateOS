import { sendDmMessage } from "@/lib/messaging";

const ORIGINAL_ENV = { ...process.env };

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function configureMetaE2E(): void {
  process.env["NODE_ENV"] = "test";
  process.env["E2E_RUN_ID"] = "meta-adapter-test";
  process.env["FACEBOOK_GRAPH_API_BASE_URL"] = "http://127.0.0.1:4013";
  process.env["FB_MESSENGER_ACCESS_TOKEN"] = "e2e-meta-system-token";
  delete process.env["DM_WEBHOOK_URL"];
}

afterEach(() => {
  jest.restoreAllMocks();
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("Meta Messenger production adapter", () => {
  it("uses the validated provider for page-token lookup and Messenger send", async () => {
    configureMetaE2E();
    const requests: string[] = [];
    jest.spyOn(global, "fetch").mockImplementation((input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requests.push(url);
      if (url.includes("/v24.0/page-adapter-one?")) {
        return Promise.resolve(
          jsonResponse(200, { access_token: "e2e-page-token" }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, { message_id: "mid.adapter.1" }),
      );
    });

    const result = await sendDmMessage(
      "recipient-adapter-one",
      "E2E message",
      { dmProvider: "facebook", dmPageId: "page-adapter-one" },
      null,
      { idempotencyKey: "dispatch-adapter-one" },
    );

    expect(result).toMatchObject({
      ok: true,
      provider: "facebook",
      providerMessageId: "mid.adapter.1",
      providerOperationIds: ["mid.adapter.1"],
      deliveryCertainty: "accepted",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatch(
      /^http:\/\/127\.0\.0\.1:4013\/v24\.0\/page-adapter-one\?/u,
    );
    expect(requests[1]).toMatch(
      /^http:\/\/127\.0\.0\.1:4013\/v24\.0\/me\/messages\?/u,
    );
  });

  it("does not report false success for an empty or malformed send receipt", async () => {
    configureMetaE2E();
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: "e2e-page-token" }),
      )
      .mockResolvedValueOnce(jsonResponse(200, {}));

    const result = await sendDmMessage(
      "recipient-adapter-empty",
      "E2E message",
      { dmProvider: "facebook", dmPageId: "page-adapter-empty" },
    );

    expect(result).toMatchObject({
      ok: false,
      provider: "facebook",
      providerMessageId: null,
      providerOperationIds: [],
      deliveryCertainty: "uncertain",
      detail: "facebook_dm_response_missing_message_id",
    });
  });

  it("distinguishes provider rejection from transport uncertainty", async () => {
    configureMetaE2E();
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: "e2e-page-token" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(403, { error: { code: 200, message: "denied" } }),
      );

    const result = await sendDmMessage(
      "recipient-adapter-denied",
      "E2E message",
      { dmProvider: "facebook", dmPageId: "page-adapter-denied" },
    );

    expect(result).toMatchObject({
      ok: false,
      deliveryCertainty: "not_sent",
      detail: "facebook_dm_failed:403",
    });
  });

  it("returns all accepted operation IDs when later media fan-out fails", async () => {
    configureMetaE2E();
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: "e2e-page-token" }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { message_id: "mid.text" }))
      .mockResolvedValueOnce(jsonResponse(200, { message_id: "mid.media.1" }))
      .mockResolvedValueOnce(
        jsonResponse(503, { error: { code: 2, message: "unavailable" } }),
      );

    const result = await sendDmMessage(
      "recipient-adapter-partial",
      "E2E message",
      { dmProvider: "facebook", dmPageId: "page-adapter-partial" },
      ["https://example.test/one.jpg", "https://example.test/two.jpg"],
    );

    expect(result).toMatchObject({
      ok: false,
      provider: "facebook",
      providerOperationIds: ["mid.text", "mid.media.1"],
      providerMessageId: "mid.media.1",
      deliveryCertainty: "uncertain",
      detail: "dm_partial_delivery:facebook_dm_failed:503",
    });
  });

  it("fails closed before fetch when an E2E run lacks a loopback Graph base", async () => {
    configureMetaE2E();
    delete process.env["FACEBOOK_GRAPH_API_BASE_URL"];
    const providerFetch = jest.spyOn(global, "fetch");

    const result = await sendDmMessage(
      "recipient-adapter-unsafe",
      "E2E message",
      { dmProvider: "facebook", dmPageId: "page-adapter-unsafe" },
    );

    expect(result).toMatchObject({
      ok: false,
      deliveryCertainty: "not_sent",
      detail: "facebook_dm_token_error",
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

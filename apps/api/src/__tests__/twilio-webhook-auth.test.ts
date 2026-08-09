import { createHmac } from "node:crypto";
import {
  createTwilioWebhookSignature,
  getTwilioWebhookPublicBaseUrl,
  verifyTwilioWebhookRequest,
} from "@/lib/twilio-webhook-auth";

const AUTH_TOKEN = "twilio-webhook-test-token";
const PUBLIC_BASE = "https://api.example.test";

function formData(entries: Array<[string, string]>): FormData {
  const form = new FormData();
  for (const [name, value] of entries) form.append(name, value);
  return form;
}

function signedPost(input: {
  path?: string;
  entries: Array<[string, string]>;
  internalOrigin?: string;
  signatureUrl?: string;
  signature?: string;
  extraHeaders?: Record<string, string>;
}): Request {
  const path = input.path ?? "/api/webhooks/twilio/sms?kind=inbound";
  const body = new URLSearchParams(input.entries);
  const signatureForm = formData(input.entries);
  const signatureUrl = input.signatureUrl ?? `${PUBLIC_BASE}${path}`;
  const signature =
    input.signature ??
    createTwilioWebhookSignature({
      authToken: AUTH_TOKEN,
      externalUrl: signatureUrl,
      formData: signatureForm,
    });
  return new Request(
    `${input.internalOrigin ?? "http://internal-api:3001"}${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
        ...input.extraHeaders,
      },
      body,
    },
  );
}

const environment = {
  NODE_ENV: "production",
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_WEBHOOK_PUBLIC_BASE_URL: PUBLIC_BASE,
};

describe("Twilio webhook signature authentication", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("matches Twilio's published HMAC-SHA1 example", () => {
    const signature = createTwilioWebhookSignature({
      authToken: "12345",
      externalUrl: "https://example.com/myapp.php?foo=1&bar=2",
      formData: formData([
        ["Digits", "1234"],
        ["To", "+18005551212"],
        ["From", "+14158675310"],
        ["Caller", "+14158675310"],
        ["CallSid", "CA1234567890ABCDE"],
      ]),
    });

    expect(signature).toBe("L/OH5YylLD5NRKLltdqwSvS0BnU=");
  });

  it("accepts a valid form signature and returns the body without consuming it twice", async () => {
    const request = signedPost({
      entries: [
        ["From", "+15555550101"],
        ["Body", "synthetic inbound message"],
        ["MessageSid", "SM00000000000000000000000000000001"],
      ],
    });

    const result = await verifyTwilioWebhookRequest(request, environment);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.externalUrl).toBe(
      `${PUBLIC_BASE}/api/webhooks/twilio/sms?kind=inbound`,
    );
    expect(result.formData.get("Body")).toBe("synthetic inbound message");
  });

  it("sorts and deduplicates repeated values exactly like twilio-node", async () => {
    const path = "/api/webhooks/twilio/sms?source=fixture";
    const entries: Array<[string, string]> = [
      ["MediaUrl", "https://media.example.test/b"],
      ["To", "+15555550102"],
      ["MediaUrl", "https://media.example.test/a"],
      ["MediaUrl", "https://media.example.test/a"],
    ];
    const expectedData =
      `${PUBLIC_BASE}${path}` +
      "MediaUrlhttps://media.example.test/a" +
      "MediaUrlhttps://media.example.test/b" +
      "To+15555550102";
    const expected = createHmac("sha1", AUTH_TOKEN)
      .update(Buffer.from(expectedData, "utf8"))
      .digest("base64");

    expect(
      createTwilioWebhookSignature({
        authToken: AUTH_TOKEN,
        externalUrl: `${PUBLIC_BASE}${path}`,
        formData: formData(entries),
      }),
    ).toBe(expected);
    const result = await verifyTwilioWebhookRequest(
      signedPost({ path, entries, signature: expected }),
      environment,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.formData.getAll("MediaUrl")).toEqual([
        "https://media.example.test/b",
        "https://media.example.test/a",
        "https://media.example.test/a",
      ]);
    }
  });

  it("authenticates GET query parameters as part of the exact external URL", async () => {
    const path = "/api/webhooks/twilio/notice?kind=outbound&sequence=1";
    const signature = createTwilioWebhookSignature({
      authToken: AUTH_TOKEN,
      externalUrl: `${PUBLIC_BASE}${path}`,
    });
    const request = new Request(`http://internal-api:3001${path}`, {
      headers: { "X-Twilio-Signature": signature },
    });

    await expect(
      verifyTwilioWebhookRequest(request, environment),
    ).resolves.toMatchObject({
      ok: true,
      externalUrl: `${PUBLIC_BASE}${path}`,
    });

    const tampered = new Request(
      "http://internal-api:3001/api/webhooks/twilio/notice?kind=inbound&sequence=1",
      { headers: { "X-Twilio-Signature": signature } },
    );
    const tamperedResult = await verifyTwilioWebhookRequest(
      tampered,
      environment,
    );
    expect(tamperedResult.ok).toBe(false);
    if (!tamperedResult.ok) expect(tamperedResult.response.status).toBe(403);
  });

  it("rejects missing, bad, and form-tampered signatures", async () => {
    const missing = signedPost({ entries: [["From", "+15555550101"]] });
    missing.headers.delete("X-Twilio-Signature");
    const missingResult = await verifyTwilioWebhookRequest(
      missing,
      environment,
    );
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.response.status).toBe(403);

    const badResult = await verifyTwilioWebhookRequest(
      signedPost({
        entries: [["From", "+15555550101"]],
        signature: "not-a-valid-signature",
      }),
      environment,
    );
    expect(badResult.ok).toBe(false);
    if (!badResult.ok) expect(badResult.response.status).toBe(403);

    const originalEntries: Array<[string, string]> = [
      ["From", "+15555550101"],
      ["Body", "original"],
    ];
    const originalSignature = createTwilioWebhookSignature({
      authToken: AUTH_TOKEN,
      externalUrl: `${PUBLIC_BASE}/api/webhooks/twilio/sms?kind=inbound`,
      formData: formData(originalEntries),
    });
    const tamperedResult = await verifyTwilioWebhookRequest(
      signedPost({
        entries: [
          ["From", "+15555550101"],
          ["Body", "tampered"],
        ],
        signature: originalSignature,
      }),
      environment,
    );
    expect(tamperedResult.ok).toBe(false);
    if (!tamperedResult.ok) expect(tamperedResult.response.status).toBe(403);
  });

  it("ignores forwarded-host spoofing and only accepts the configured public base", async () => {
    const valid = await verifyTwilioWebhookRequest(
      signedPost({
        entries: [["From", "+15555550101"]],
        extraHeaders: {
          Host: "attacker.example",
          "X-Forwarded-Host": "attacker.example",
          "X-Forwarded-Proto": "http",
        },
      }),
      environment,
    );
    expect(valid.ok).toBe(true);

    const spoofSigned = await verifyTwilioWebhookRequest(
      signedPost({
        entries: [["From", "+15555550101"]],
        signatureUrl:
          "http://attacker.example/api/webhooks/twilio/sms?kind=inbound",
        extraHeaders: { "X-Forwarded-Host": "attacker.example" },
      }),
      environment,
    );
    expect(spoofSigned.ok).toBe(false);
  });

  it("returns safe 400 and 503 failures for malformed forms and unavailable configuration", async () => {
    const malformed = new Request(
      "http://internal-api:3001/api/webhooks/twilio/sms",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Twilio-Signature": "synthetic",
        },
        body: "{}",
      },
    );
    const malformedResult = await verifyTwilioWebhookRequest(
      malformed,
      environment,
    );
    expect(malformedResult.ok).toBe(false);
    if (!malformedResult.ok) expect(malformedResult.response.status).toBe(400);

    const request = signedPost({ entries: [["From", "+15555550101"]] });
    const missingConfig = await verifyTwilioWebhookRequest(request, {
      NODE_ENV: "production",
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    });
    expect(missingConfig.ok).toBe(false);
    if (!missingConfig.ok) expect(missingConfig.response.status).toBe(503);

    const insecureConfig = await verifyTwilioWebhookRequest(
      signedPost({ entries: [["From", "+15555550101"]] }),
      {
        NODE_ENV: "production",
        TWILIO_AUTH_TOKEN: AUTH_TOKEN,
        TWILIO_WEBHOOK_PUBLIC_BASE_URL: "http://api.example.test",
      },
    );
    expect(insecureConfig.ok).toBe(false);
    if (!insecureConfig.ok) expect(insecureConfig.response.status).toBe(503);
  });

  it("bounds URL-encoded bodies and rejects multipart before parsing", async () => {
    const oversized = new Request(
      "http://internal-api:3001/api/webhooks/twilio/sms",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Signature": "synthetic",
        },
        body: `Body=${"x".repeat(256 * 1024 + 1)}`,
      },
    );
    const oversizedResult = await verifyTwilioWebhookRequest(
      oversized,
      environment,
    );
    expect(oversizedResult.ok).toBe(false);
    if (!oversizedResult.ok) expect(oversizedResult.response.status).toBe(400);

    const multipart = new Request(
      "http://internal-api:3001/api/webhooks/twilio/sms",
      {
        method: "POST",
        headers: {
          "Content-Type": "multipart/form-data; boundary=synthetic",
          "X-Twilio-Signature": "synthetic",
        },
        body: "--synthetic--",
      },
    );
    const multipartResult = await verifyTwilioWebhookRequest(
      multipart,
      environment,
    );
    expect(multipartResult.ok).toBe(false);
    if (!multipartResult.ok) expect(multipartResult.response.status).toBe(400);
  });

  it("does not leak tokens, signatures, query values, or form values in rejection logs", async () => {
    const secretSignature = "private-signature-marker";
    const privatePhone = "+15555550999";
    await verifyTwilioWebhookRequest(
      signedPost({
        path: "/api/webhooks/twilio/connect?requestKey=private-query-marker",
        entries: [["From", privatePhone]],
        signature: secretSignature,
      }),
      environment,
    );

    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).toContain("invalid_signature");
    expect(serialized).not.toContain(AUTH_TOKEN);
    expect(serialized).not.toContain(secretSignature);
    expect(serialized).not.toContain(privatePhone);
    expect(serialized).not.toContain("private-query-marker");
  });
});

describe("Twilio webhook public base configuration", () => {
  it("preserves the explicit externally configured port and rejects unsafe production bases", () => {
    expect(
      getTwilioWebhookPublicBaseUrl({
        NODE_ENV: "production",
        TWILIO_WEBHOOK_PUBLIC_BASE_URL: "https://Api.Example.test:8443/",
      }),
    ).toBe("https://api.example.test:8443");

    for (const value of [
      "",
      "not-a-url",
      "http://api.example.test",
      "https://user:secret@api.example.test",
      "https://api.example.test/base",
      "https://api.example.test?token=value",
      "https://127.0.0.1:3001",
    ]) {
      expect(() =>
        getTwilioWebhookPublicBaseUrl({
          NODE_ENV: "production",
          TWILIO_WEBHOOK_PUBLIC_BASE_URL: value,
        }),
      ).toThrow("twilio_webhook_configuration_unavailable");
    }
  });

  it("permits only dual-sentinel loopback in controlled production runs", () => {
    expect(
      getTwilioWebhookPublicBaseUrl({
        NODE_ENV: "production",
        E2E_RUN_ID: "production-twilio-audit",
        TEAM_CRM_AUDIT_MODE: "1",
        TWILIO_WEBHOOK_PUBLIC_BASE_URL: "http://127.0.0.1:3001",
      }),
    ).toBe("http://127.0.0.1:3001");

    for (const sentinels of [
      { E2E_RUN_ID: "production-twilio-audit" },
      { TEAM_CRM_AUDIT_MODE: "1" },
      {
        E2E_RUN_ID: "production-twilio-audit",
        TEAM_CRM_AUDIT_MODE: "true",
      },
    ]) {
      expect(() =>
        getTwilioWebhookPublicBaseUrl({
          NODE_ENV: "production",
          TWILIO_WEBHOOK_PUBLIC_BASE_URL: "http://127.0.0.1:3001",
          ...sentinels,
        }),
      ).toThrow("twilio_webhook_configuration_unavailable");
    }

    expect(() =>
      getTwilioWebhookPublicBaseUrl({
        NODE_ENV: "production",
        E2E_RUN_ID: "production-twilio-audit",
        TEAM_CRM_AUDIT_MODE: "1",
        TWILIO_WEBHOOK_PUBLIC_BASE_URL: "https://api.example.test",
      }),
    ).toThrow("twilio_webhook_configuration_unavailable");
  });

  it("never permits credentialed, pathful, fragmented, or public HTTP bases outside production", () => {
    for (const value of [
      "http://api.example.test",
      "https://user:secret@api.example.test",
      "https://api.example.test/base",
      "https://api.example.test#private",
      "https://api.example.test?private=value",
    ]) {
      expect(() =>
        getTwilioWebhookPublicBaseUrl({
          NODE_ENV: "test",
          TWILIO_WEBHOOK_PUBLIC_BASE_URL: value,
        }),
      ).toThrow("twilio_webhook_configuration_unavailable");
    }
  });
});

import type { NextRequest } from "next/server";
import type { DatabaseClient } from "@/db";
import { jest } from "@jest/globals";

const mockGetDb = jest.fn();
const actualDatabase = await import("@/db");
jest.unstable_mockModule("@/db", () => ({
  ...actualDatabase,
  getDb: mockGetDb,
}));

const {
  isOpenAiAdsConsentRevoked,
  OPENAI_ADS_CONSENT_REVOKED_EVENT,
  openAiAdsConsentRevocationId,
  recordOpenAiAdsConsentRevocation,
} = await import("@/lib/openai-ads-consent");
const { OPTIONS, POST } = await import(
  "../../app/api/public/openai/ads/consent/route"
);

const consentId = "d378c93b-3a8f-432b-ad15-77a9c32f3191";
const origin = "https://stonegate.example";
const originalOrigins = process.env["CORS_ALLOW_ORIGINS"];

function request(
  body: unknown,
  options: { origin?: string; ip?: string; raw?: string } = {},
): NextRequest {
  return new Request("https://api.example/api/public/openai/ads/consent", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: options.origin ?? origin,
      "x-forwarded-for": options.ip ?? "192.0.2.1",
    },
    body: options.raw ?? JSON.stringify(body),
  }) as NextRequest;
}

function database() {
  const rows = new Map<string, Record<string, unknown>>();
  const values = jest.fn((row: Record<string, unknown>) => ({
    onConflictDoNothing: jest.fn(() => {
      if (!rows.has(String(row.id))) rows.set(String(row.id), row);
      return Promise.resolve();
    }),
  }));
  const result = {
    insert: jest.fn(() => ({ values })),
    select: jest.fn(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([...rows.values()]) }),
      }),
    })),
  };
  return {
    rows,
    values,
    raw: result,
    client: result as unknown as Pick<DatabaseClient, "select" | "insert">,
  };
}

describe("durable OpenAI Ads consent revocation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env["CORS_ALLOW_ORIGINS"] = origin;
  });

  afterAll(() => {
    if (originalOrigins === undefined) delete process.env["CORS_ALLOW_ORIGINS"];
    else process.env["CORS_ALLOW_ORIGINS"] = originalOrigins;
  });

  it("persists an opaque terminal marker idempotently and detects it after reload", async () => {
    const db = database();
    expect(await isOpenAiAdsConsentRevoked(consentId, db.client)).toBe(false);
    await recordOpenAiAdsConsentRevocation(consentId, db.client);
    await recordOpenAiAdsConsentRevocation(consentId.toUpperCase(), db.client);
    expect(db.rows.size).toBe(1);
    const stored = [...db.rows.values()][0]!;
    expect(stored).toMatchObject({
      type: OPENAI_ADS_CONSENT_REVOKED_EVENT,
      payload: { consentId },
    });
    expect(stored.processedAt).toBeInstanceOf(Date);
    expect(await isOpenAiAdsConsentRevoked(consentId, db.client)).toBe(true);
    expect(openAiAdsConsentRevocationId(consentId)).toBe(
      openAiAdsConsentRevocationId(consentId.toUpperCase()),
    );
    expect(
      openAiAdsConsentRevocationId("9cdccbef-2fbc-43f9-b323-c715ac918ad1"),
    ).not.toBe(stored.id);
  });

  it("accepts revocation without exposing the consent ID or contact information", async () => {
    const db = database();
    mockGetDb.mockReturnValue(db.client);
    const result = await POST(request({ consentId, consent: false }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("access-control-allow-origin")).toBe(origin);
    expect(db.rows.size).toBe(1);
  });

  it.each([
    { consentId, consent: true },
    { consentId: "not-a-uuid", consent: false },
    { consentId, consent: false, email: "person@example.test" },
  ])("rejects invalid requests without touching storage: %j", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("rejects foreign origins and ambiguous or oversized JSON before storage", async () => {
    expect(
      (
        await POST(
          request(
            { consentId, consent: false },
            { origin: "https://untrusted.example" },
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          request(null, {
            raw: `{"consentId":"${consentId}","consent":true,"consent":false}`,
          }),
        )
      ).status,
    ).toBe(400);
    expect((await POST(request(null, { raw: "x".repeat(513) }))).status).toBe(
      413,
    );
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("only enables CORS for trusted origin preflights", () => {
    expect(OPTIONS(request(null)).status).toBe(204);
    expect(
      OPTIONS(request(null, { origin: "https://untrusted.example" })).status,
    ).toBe(403);
  });

  it("returns a retryable response if durable storage fails", async () => {
    mockGetDb.mockImplementation(() => {
      throw new Error("sensitive connection details");
    });
    const result = await POST(request({ consentId, consent: false }));
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      ok: false,
      error: "consent_persistence_failed",
    });
  });

  it("rate-limits repeated writes without bypassing the body or origin checks", async () => {
    const db = database();
    mockGetDb.mockReturnValue(db.client);
    for (let index = 0; index < 120; index += 1)
      expect(
        (
          await POST(
            request({ consentId, consent: false }, { ip: "192.0.2.55" }),
          )
        ).status,
      ).toBe(200);
    const result = await POST(
      request({ consentId, consent: false }, { ip: "192.0.2.55" }),
    );
    expect(result.status).toBe(429);
    expect(result.headers.get("retry-after")).toBe("60");
  });
});

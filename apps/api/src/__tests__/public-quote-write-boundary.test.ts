import { NextRequest } from "next/server";
import { POST as decideQuote } from "../../app/api/public/quotes/[token]/route";
import { POST as requestQuoteChange } from "../../app/api/public/quotes/[token]/changes/route";

const QUOTE_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "public-capability-token";
const IDEMPOTENCY_KEY = "quote-public-action:1234567890";

function request(path: string, body: unknown): NextRequest {
  return new NextRequest(`https://api.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": IDEMPOTENCY_KEY,
    },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ token: TOKEN }) };

describe("public quote write boundary", () => {
  it("requires the displayed quote identity and revision for a decision", async () => {
    const response = await decideQuote(
      request(`/api/public/quotes/${TOKEN}`, { decision: "accepted" }),
      context,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_payload",
    });
  });

  it("requires the displayed quote identity and revision for a change request", async () => {
    const response = await requestQuoteChange(
      request(`/api/public/quotes/${TOKEN}/changes`, {
        reason: "Scope changed",
      }),
      context,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_payload",
    });
  });

  it("rejects broadened decision payloads instead of ignoring extra fields", async () => {
    const response = await decideQuote(
      request(`/api/public/quotes/${TOKEN}`, {
        quoteId: QUOTE_ID,
        expectedRevision: 2,
        decision: "accepted",
        admin: true,
      }),
      context,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_payload",
    });
  });

  it("rejects oversized change-request bodies before opening the database", async () => {
    const response = await requestQuoteChange(
      request(`/api/public/quotes/${TOKEN}/changes`, {
        quoteId: QUOTE_ID,
        expectedRevision: 2,
        reason: "Other",
        message: "x".repeat(5_000),
      }),
      context,
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "body_too_large",
    });
  });
});

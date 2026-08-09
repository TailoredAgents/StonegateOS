jest.mock("nanoid", () => ({ nanoid: jest.fn(() => "test-public-token") }));

import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as intakeLead } from "../../app/api/web/lead-intake/route";
import { POST as holdQuote } from "../../app/api/public/quotes/[token]/hold/route";
import { POST as bookQuote } from "../../app/api/public/quotes/[token]/book/route";

const ROOT = path.resolve(__dirname, "../../../..");
const source = (relativePath: string): string =>
  readFileSync(path.join(ROOT, relativePath), "utf8");
const stableKey = "public-integrity-key-1234567890";

function jsonRequest(url: string, body: string, headers = {}): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

describe("public lead and quote booking integrity", () => {
  it("requires a stable intake operation key before reading the body", async () => {
    const response = await intakeLead(
      jsonRequest("http://localhost:3001/api/web/lead-intake", "not-json"),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "idempotency_key_required",
    });
  });

  it("bounds intake JSON and rejects ambiguous or unknown fields", async () => {
    const duplicate = await intakeLead(
      jsonRequest(
        "http://localhost:3001/api/web/lead-intake",
        '{"name":"First","name":"Second"}',
        { "idempotency-key": stableKey },
      ),
    );
    expect(duplicate.status).toBe(400);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_body",
    });

    const unknown = await intakeLead(
      jsonRequest(
        "http://localhost:3001/api/web/lead-intake",
        JSON.stringify({ unexpected: true }),
        { "idempotency-key": `${stableKey}:unknown` },
      ),
    );
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({
      error: "invalid_payload",
    });

    const oversized = await intakeLead(
      jsonRequest(
        "http://localhost:3001/api/web/lead-intake",
        JSON.stringify({ notes: "x".repeat(17 * 1024) }),
        { "idempotency-key": `${stableKey}:oversized` },
      ),
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      ok: false,
      error: "body_too_large",
    });
  });

  it("requires keys and strict bounded bodies before quote scheduling reads", async () => {
    const context = { params: Promise.resolve({ token: "test-token" }) };
    const noKey = await holdQuote(
      jsonRequest("http://localhost/hold", "not-json"),
      context,
    );
    expect(noKey.status).toBe(422);

    const ambiguousHold = await holdQuote(
      jsonRequest(
        "http://localhost/hold",
        '{"quoteId":"00000000-0000-4000-8000-000000000001","quoteId":"00000000-0000-4000-8000-000000000002"}',
        { "idempotency-key": `${stableKey}:hold` },
      ),
      context,
    );
    expect(ambiguousHold.status).toBe(400);
    await expect(ambiguousHold.json()).resolves.toMatchObject({
      error: "invalid_body",
    });

    const ambiguousBook = await bookQuote(
      jsonRequest(
        "http://localhost/book",
        '{"holdId":"00000000-0000-4000-8000-000000000001","holdId":"00000000-0000-4000-8000-000000000002"}',
        { "idempotency-key": `${stableKey}:book` },
      ),
      context,
    );
    expect(ambiguousBook.status).toBe(400);
    await expect(ambiguousBook.json()).resolves.toMatchObject({
      error: "invalid_body",
    });
  });

  it("keeps internal appointment identifiers and raw IPs out of analytics", () => {
    const intake = source("apps/api/app/api/web/lead-intake/route.ts");
    expect(intake).not.toContain("appointment_id:");
    expect(intake).not.toMatch(/new lead[\s\S]{0,300}\bip,/u);
    expect(intake).toContain("intakeOperationKeyHash: operationKeyHash");
    expect(intake).toContain("intakeRequestHash: requestHash");
    const requestHashStart = intake.indexOf("const requestHash = sha256(");
    const requestHashEnd = intake.indexOf(
      "const db = getDb();",
      requestHashStart,
    );
    expect(requestHashStart).toBeGreaterThanOrEqual(0);
    expect(requestHashEnd).toBeGreaterThan(requestHashStart);
    expect(intake.slice(requestHashStart, requestHashEnd)).not.toContain(
      "referrer",
    );
    expect(intake).toContain("intakeResponse: response");
  });

  it("binds quote, revision, hold, pipeline, audit, and replay evidence", () => {
    const scheduling = source("apps/api/src/lib/quote-scheduling.ts");
    const publicPage = source("apps/site/src/app/quote/[token]/page.tsx");
    const migration = source(
      "apps/api/src/db/migrations/0097_public_lead_quote_booking_integrity.sql",
    );
    expect(scheduling).toContain("eq(quotes.revision, current.revision)");
    expect(scheduling).toContain("eq(appointmentHolds.fullQuoteId");
    expect(scheduling).toContain('stage: "won"');
    expect(scheduling).toContain('action: "quote.public_booked"');
    expect(scheduling).toContain('action: "book"');
    expect(publicPage).toContain('name="expectedRevision"');
    expect(publicPage).toContain('"Idempotency-Key": `${idempotencyKey}:hold`');
    expect(publicPage).toContain('"Idempotency-Key": `${idempotencyKey}:book`');
    expect(migration).toContain("appointment_holds_full_quote_id_quotes_id_fk");
    expect(migration).toContain("'decision', 'refresh', 'hold', 'book'");
  });
});

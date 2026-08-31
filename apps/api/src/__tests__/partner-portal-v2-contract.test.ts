import { createHash } from "node:crypto";
import {
  createPortalV2ErrorResponse,
  createPortalV2IdempotencyErrorResponse,
  createPortalV2MoneyDto,
  createPortalV2StrongEtag,
  createPortalV2UnexpectedErrorResponse,
  decodePortalV2Cursor,
  encodePortalV2Cursor,
  evaluatePortalV2RevisionPrecondition,
  hashPortalV2IdempotencyKey,
  isPortalV2Rfc3339,
  normalizePortalV2Timezone,
  parsePortalV2IdempotencyKey,
  parsePortalV2IfMatch,
  parsePortalV2MoneyDto,
  parsePortalV2Pagination,
  parsePortalV2Rfc3339,
  readPortalV2CorrelationId,
  resolvePortalV2CorrelationId,
  toPortalV2Rfc3339,
  type PortalV2ErrorHttpResponse,
} from "@/lib/portal-v2-contract";

const CORRELATION_ID = "dbaf4dd3-64b0-487f-8d67-1b9db7f02a12";

type CursorPayload = Readonly<{
  accountId: string;
  filterHash: string;
  anchor: Readonly<{ at: string; id: string }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (!isRecord(value) || !isRecord(value["anchor"])) return false;
  return (
    Object.keys(value).sort().join(",") === "accountId,anchor,filterHash" &&
    typeof value["accountId"] === "string" &&
    typeof value["filterHash"] === "string" &&
    Object.keys(value["anchor"]).sort().join(",") === "at,id" &&
    typeof value["anchor"]["at"] === "string" &&
    typeof value["anchor"]["id"] === "string"
  );
}

function cursorPayload(): CursorPayload {
  return {
    accountId: "55f64d58-0d21-4978-a0e1-4fd47c95b85b",
    filterHash: "a".repeat(64),
    anchor: {
      at: "2026-08-30T15:00:00.000Z",
      id: "85442620-26ae-450b-8d17-46e8f6b15093",
    },
  };
}

describe("portal V2 safe errors and correlation", () => {
  it("reuses only bounded safe correlation IDs", () => {
    expect(
      readPortalV2CorrelationId(
        new Headers({ "x-correlation-id": ` ${CORRELATION_ID} ` }),
      ),
    ).toBe(CORRELATION_ID);
    expect(
      resolvePortalV2CorrelationId("unsafe,reflected", () => CORRELATION_ID),
    ).toBe(CORRELATION_ID);
    expect(() => resolvePortalV2CorrelationId(null, () => "short")).toThrow(
      TypeError,
    );
  });

  it("builds a stable error body with matching headers and recovery actions", () => {
    const response = createPortalV2ErrorResponse(
      "slot_unavailable",
      CORRELATION_ID,
      {
        fieldErrors: { serviceWindow: "Choose another available time." },
        alternatives: [
          {
            action: "choose_another_time",
            label: "See nearby times",
            href: "/partners/book?nearby=1",
          },
        ],
      },
    );
    expect(response).toEqual({
      status: 409,
      headers: {
        "Cache-Control": "no-store",
        "x-correlation-id": CORRELATION_ID,
      },
      body: {
        ok: false,
        error: "slot_unavailable",
        message: "That service time is no longer available.",
        correlationId: CORRELATION_ID,
        retryable: false,
        fieldErrors: { serviceWindow: "Choose another available time." },
        alternatives: [
          {
            action: "choose_another_time",
            label: "See nearby times",
            href: "/partners/book?nearby=1",
          },
        ],
      },
    });
    expect(Object.isFrozen(response.body.alternatives)).toBe(true);
  });

  it("never reflects unknown exception text", () => {
    const secret = "database password appeared in exception";
    const response = createPortalV2UnexpectedErrorResponse(
      CORRELATION_ID,
      new Error(secret),
    );
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(response.body).toMatchObject({
      error: "internal_error",
      retryable: true,
      correlationId: CORRELATION_ID,
    });
    expect(() =>
      createPortalV2ErrorResponse("invalid_fields", CORRELATION_ID, {
        alternatives: [
          {
            action: "unsafe_redirect",
            label: "Continue",
            href: "//attacker.example/collect",
          },
        ],
      }),
    ).toThrow(TypeError);
  });
});

describe("portal V2 cursor and pagination boundaries", () => {
  it("round-trips a canonical endpoint-scoped cursor", () => {
    const encoded = encodePortalV2Cursor({
      kind: "bookings.history",
      limit: 25,
      payload: cursorPayload(),
    });
    const decoded = decodePortalV2Cursor(encoded, {
      expectedKind: "bookings.history",
      validatePayload: isCursorPayload,
    });
    expect(decoded).toEqual({
      version: 1,
      kind: "bookings.history",
      limit: 25,
      payload: cursorPayload(),
    });
    expect(
      decodePortalV2Cursor(encoded, {
        expectedKind: "properties.list",
        validatePayload: isCursorPayload,
      }),
    ).toBeNull();
  });

  it("rejects noncanonical, malformed, oversized, and invalid-payload cursors", () => {
    const noncanonical = Buffer.from(
      JSON.stringify({
        version: 1,
        payload: cursorPayload(),
        limit: 25,
        kind: "bookings.history",
      }),
      "utf8",
    ).toString("base64url");
    expect(
      decodePortalV2Cursor(noncanonical, {
        expectedKind: "bookings.history",
        validatePayload: isCursorPayload,
      }),
    ).toBeNull();
    expect(
      decodePortalV2Cursor("x".repeat(2_049), {
        expectedKind: "bookings.history",
        validatePayload: isCursorPayload,
      }),
    ).toBeNull();
    expect(() =>
      encodePortalV2Cursor({
        kind: "bookings.history",
        limit: 25,
        payload: { oversized: "x".repeat(2_000) },
      }),
    ).toThrow(TypeError);
  });

  it("uses a cursor-bound limit and rejects duplicate or mismatched limits", () => {
    const cursor = encodePortalV2Cursor({
      kind: "bookings.history",
      limit: 50,
      payload: cursorPayload(),
    });
    expect(
      parsePortalV2Pagination(new URLSearchParams({ cursor }), {
        cursorKind: "bookings.history",
        validateCursorPayload: isCursorPayload,
      }),
    ).toMatchObject({ ok: true, limit: 50 });
    const mismatched = parsePortalV2Pagination(
      new URLSearchParams(`cursor=${cursor}&limit=25`),
      {
        cursorKind: "bookings.history",
        validateCursorPayload: isCursorPayload,
      },
    );
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.fieldErrors["cursor"]).toContain("page size");
    }
    const duplicated = parsePortalV2Pagination(
      new URLSearchParams("limit=10&limit=20"),
      {
        cursorKind: "bookings.history",
        validateCursorPayload: isCursorPayload,
      },
    );
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(typeof duplicated.fieldErrors["limit"]).toBe("string");
    }
    expect(() =>
      parsePortalV2Pagination(new URLSearchParams(), {
        cursorKind: "INVALID KIND",
        validateCursorPayload: isCursorPayload,
      }),
    ).toThrow(TypeError);
  });
});

describe("portal V2 idempotency contract", () => {
  const key = "booking:3f243f38-1e7b-4eac-9300-84489fd37d15";

  it("normalizes a valid key and returns only its SHA-256 fingerprint", () => {
    const parsed = parsePortalV2IdempotencyKey(` ${key} `);
    const expected = createHash("sha256").update(key, "utf8").digest("hex");
    expect(parsed).toEqual({ ok: true, present: true, keyHash: expected });
    expect(hashPortalV2IdempotencyKey(key)).toBe(expected);
    expect(JSON.stringify(parsed)).not.toContain(key);
  });

  it("distinguishes missing optional, missing required, and invalid keys", () => {
    expect(parsePortalV2IdempotencyKey(null, { required: false })).toEqual({
      ok: true,
      present: false,
      keyHash: null,
    });
    const required = parsePortalV2IdempotencyKey(null);
    expect(required).toEqual({ ok: false, reason: "required" });
    expect(parsePortalV2IdempotencyKey("too-short")).toEqual({
      ok: false,
      reason: "invalid",
    });
    const response = createPortalV2IdempotencyErrorResponse(
      required as Extract<typeof required, { ok: false }>,
      CORRELATION_ID,
    );
    expect(response).toMatchObject({
      status: 400,
      body: { error: "idempotency_key_required" },
    });
  });
});

describe("portal V2 strong revision preconditions", () => {
  const revision = "2026-08-30T15:00:00.123456Z";

  it("creates deterministic non-reversible strong ETags and parses tag lists", () => {
    const etag = createPortalV2StrongEtag(revision);
    expect(etag).toMatch(/^"portal-v2-[A-Za-z0-9_-]{43}"$/u);
    expect(etag).not.toContain(revision);
    expect(createPortalV2StrongEtag(revision)).toBe(etag);
    const other = createPortalV2StrongEtag(`${revision}:other`);
    expect(parsePortalV2IfMatch(`${other}, ${etag}`)).toEqual({
      ok: true,
      kind: "tags",
      tags: [other, etag],
    });
    expect(parsePortalV2IfMatch(`W/${etag}`)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("returns 428, 400, or 412 with the current ETag and safe recovery", () => {
    const cases: Array<{
      ifMatch: string | null;
      status: number;
      error: string;
    }> = [
      { ifMatch: null, status: 428, error: "if_match_required" },
      { ifMatch: "*", status: 400, error: "invalid_if_match" },
      {
        ifMatch: createPortalV2StrongEtag("stale"),
        status: 412,
        error: "revision_mismatch",
      },
    ];
    for (const testCase of cases) {
      const result = evaluatePortalV2RevisionPrecondition({
        ifMatch: testCase.ifMatch,
        currentRevision: revision,
        correlationId: CORRELATION_ID,
      });
      expect(result.ok).toBe(false);
      const response = (result as Extract<typeof result, { ok: false }>)
        .response;
      expect(response).toMatchObject({
        status: testCase.status,
        headers: {
          ETag: createPortalV2StrongEtag(revision),
          "x-correlation-id": CORRELATION_ID,
        },
        body: {
          error: testCase.error,
          retryable: false,
          alternatives: [{ action: "refresh" }],
        },
      });
    }
  });

  it("accepts the exact strong tag and only accepts wildcard when explicit", () => {
    expect(
      evaluatePortalV2RevisionPrecondition({
        ifMatch: createPortalV2StrongEtag(revision),
        currentRevision: revision,
        correlationId: CORRELATION_ID,
      }),
    ).toEqual({ ok: true, currentEtag: createPortalV2StrongEtag(revision) });
    expect(
      evaluatePortalV2RevisionPrecondition({
        ifMatch: "*",
        currentRevision: revision,
        correlationId: CORRELATION_ID,
        allowWildcard: true,
      }).ok,
    ).toBe(true);
  });
});

describe("portal V2 time, timezone, and money DTOs", () => {
  it("accepts strict RFC3339 instants and emits canonical UTC milliseconds", () => {
    const parsed = parsePortalV2Rfc3339("2026-08-30T11:30:15.123456-04:00");
    expect(parsed?.toISOString()).toBe("2026-08-30T15:30:15.123Z");
    expect(toPortalV2Rfc3339(parsed!)).toBe("2026-08-30T15:30:15.123Z");
    expect(isPortalV2Rfc3339("2026-08-30T15:30:15Z")).toBe(true);
    expect(isPortalV2Rfc3339("2026-02-30T15:30:15Z")).toBe(false);
    expect(isPortalV2Rfc3339("2026-08-30T15:30:15")).toBe(false);
    expect(isPortalV2Rfc3339("2026-08-30T15:30:15+14:01")).toBe(false);
    expect(isPortalV2Rfc3339("9999-12-31T23:59:59-14:00")).toBe(false);
  });

  it("canonicalizes IANA timezones and rejects offsets or unknown zones", () => {
    expect(normalizePortalV2Timezone(" america/new_york ")).toBe(
      "America/New_York",
    );
    expect(normalizePortalV2Timezone("UTC")).toBe("UTC");
    expect(normalizePortalV2Timezone("-04:00")).toBeNull();
    expect(normalizePortalV2Timezone("Mars/Olympus_Mons")).toBeNull();
  });

  it("uses explicit integer USD minor units without floating-point amounts", () => {
    const dto = createPortalV2MoneyDto(12_345);
    expect(dto).toEqual({ amountMinor: 12_345, currency: "USD", minorUnit: 2 });
    expect(parsePortalV2MoneyDto(dto)).toEqual(dto);
    expect(() => createPortalV2MoneyDto(12.34)).toThrow(TypeError);
    expect(
      parsePortalV2MoneyDto({ amountMinor: 12_345, currency: "USD" }),
    ).toBeNull();
  });

  it("keeps the HTTP error descriptor transport-neutral", () => {
    const response: PortalV2ErrorHttpResponse = createPortalV2ErrorResponse(
      "service_unavailable",
      CORRELATION_ID,
      { retryAfterSeconds: 30 },
    );
    expect(response.headers["Retry-After"]).toBe("30");
  });
});

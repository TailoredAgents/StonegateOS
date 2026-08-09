import {
  buildConversationJsonl,
  hasConversationExportContent,
  isConversationMessageExportEligible,
  parseConversationExportQuery,
  readConversationExportConfirmation,
  readConversationExportFinalization,
  type ConversationExportLimits,
  type ConversationExportSourceRow,
} from "@/lib/conversation-export";
import {
  canonicalConversationExportQuery,
  ConversationExportBodyTimeoutError,
  finalizeSiteConversationExport,
  isSameOriginConversationExportRequest,
  parseConversationExportError,
  parseConversationExportFinalizationAck,
  parseConversationExportReceipt,
  readBoundedExportResponse,
  SITE_CONVERSATION_EXPORT_MAX_BODY_BYTES,
  SITE_CONVERSATION_EXPORT_MAX_BYTES,
  SITE_CONVERSATION_EXPORT_MAX_LINE_BYTES,
  SITE_CONVERSATION_EXPORT_MAX_MESSAGES,
  SITE_CONVERSATION_EXPORT_MAX_THREADS,
  validateConversationJsonl,
} from "../../../site/src/app/team/lib/conversation-export";

const correlationId = "11111111-1111-4111-8111-111111111111";
const receiptId = "22222222-2222-4222-8222-222222222222";

function receiptHeaders(input: {
  rows: number;
  messages: number;
  bytes: number;
}): Headers {
  return new Headers({
    "content-type": "application/x-ndjson; charset=utf-8",
    "content-disposition":
      'attachment; filename="stonegate-conversations-2026-08-08.jsonl"',
    "content-length": String(input.bytes),
    "x-export-format-version": "1",
    "x-export-receipt-id": receiptId,
    "x-export-row-count": String(input.rows),
    "x-export-thread-count": String(input.rows),
    "x-export-message-count": String(input.messages),
    "x-export-byte-count": String(input.bytes),
    "x-export-maximum-messages": String(SITE_CONVERSATION_EXPORT_MAX_MESSAGES),
    "x-export-maximum-threads": String(SITE_CONVERSATION_EXPORT_MAX_THREADS),
    "x-export-maximum-body-bytes": String(
      SITE_CONVERSATION_EXPORT_MAX_BODY_BYTES,
    ),
    "x-export-maximum-line-bytes": String(
      SITE_CONVERSATION_EXPORT_MAX_LINE_BYTES,
    ),
    "x-export-maximum-bytes": String(SITE_CONVERSATION_EXPORT_MAX_BYTES),
    "x-export-truncated": "false",
    "x-export-audit-state": "prepared",
    "x-audit-correlation-id": correlationId,
  });
}

describe("conversation export query and eligibility", () => {
  it("uses one exact trailing 30-day window ending at request time", () => {
    const result = parseConversationExportQuery(
      new URLSearchParams(),
      new Date("2026-08-08T15:30:00.000Z"),
    );
    expect(result).toMatchObject({
      ok: true,
      query: { days: 30, channel: null },
    });
    if (result.ok) {
      expect(result.query.fromInclusive.toISOString()).toBe(
        "2026-07-09T15:30:00.000Z",
      );
      expect(result.query.toExclusive.toISOString()).toBe(
        "2026-08-08T15:30:00.000Z",
      );
    }
  });

  it("rejects unknown, repeated, malformed, and overbroad filters", () => {
    for (const query of [
      "batch=500",
      "days=30&days=7",
      "days=31",
      "days=30.0",
      "channel=unknown",
    ]) {
      expect(
        parseConversationExportQuery(new URLSearchParams(query)),
      ).toMatchObject({ ok: false });
      expect(
        canonicalConversationExportQuery(new URLSearchParams(query)),
      ).toMatchObject({ ok: false });
    }
    expect(
      canonicalConversationExportQuery(
        new URLSearchParams("days=7&channel=SMS"),
      ),
    ).toEqual({ ok: true, query: "days=7&channel=sms" });
  });

  it("exports inbound and delivered/sent outbound messages only", () => {
    expect(
      isConversationMessageExportEligible({
        direction: "inbound",
        deliveryStatus: "failed",
        draft: false,
      }),
    ).toBe(true);
    expect(
      isConversationMessageExportEligible({
        direction: "outbound",
        deliveryStatus: "delivered",
        draft: false,
      }),
    ).toBe(true);
    for (const input of [
      { direction: "internal", deliveryStatus: "delivered", draft: false },
      { direction: "outbound", deliveryStatus: "failed", draft: false },
      { direction: "outbound", deliveryStatus: "queued", draft: false },
      { direction: "outbound", deliveryStatus: "sent", draft: true },
    ]) {
      expect(isConversationMessageExportEligible(input)).toBe(false);
    }
  });

  it("uses the same explicit ASCII-whitespace definition at build time", () => {
    expect(hasConversationExportContent(" \t\n\v\f\r")).toBe(false);
    expect(hasConversationExportContent("\u00a0")).toBe(true);
    expect(
      buildConversationJsonl([
        { threadKey: "x", role: "user", content: " \t\n\v\f\r" },
      ]),
    ).toMatchObject({ ok: false, reason: "invalid_row" });
  });

  it("accepts only exact bounded confirmation and finalization bodies", async () => {
    await expect(
      readConversationExportConfirmation(
        new Request("https://api.example.test/export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmed: true }),
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      readConversationExportConfirmation(
        new Request("https://api.example.test/export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmed: true, extra: true }),
        }),
      ),
    ).resolves.toBe(false);

    await expect(
      readConversationExportFinalization(
        new Request("https://api.example.test/export", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            correlationId,
            exportId: receiptId,
            outcome: "released",
            reason: null,
          }),
        }),
        correlationId,
      ),
    ).resolves.toEqual({
      correlationId,
      exportId: receiptId,
      outcome: "released",
      reason: null,
    });
    await expect(
      readConversationExportFinalization(
        new Request("https://api.example.test/export", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            correlationId,
            exportId: null,
            outcome: "released",
            reason: null,
          }),
        }),
        correlationId,
      ),
    ).resolves.toBeNull();
  });
});

describe("bounded privacy-minimal conversation JSONL", () => {
  const rows: ConversationExportSourceRow[] = [
    {
      threadKey: "private-thread-a",
      role: "user",
      content: "Hello\n\u0000 😀",
    },
    {
      threadKey: "private-thread-a",
      role: "assistant",
      content: 'Reply with "care"',
    },
    {
      threadKey: "private-thread-b",
      role: "user",
      content: "Second conversation",
    },
  ];

  it("preserves required content while emitting only role/content JSON", () => {
    const result = buildConversationJsonl(rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({
      rowCount: 2,
      threadCount: 2,
      messageCount: 3,
      byteCount: result.bytes.byteLength,
    });
    expect(result.text).not.toContain("private-thread");
    expect(result.text).not.toContain("phone");
    expect(result.text.split("\n")).toHaveLength(3);
    const parsed = result.text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      parsed.every((line) => Object.keys(line).join() === "messages"),
    ).toBe(true);
    expect(
      (parsed[0]?.["messages"] as Array<Record<string, unknown>>)[0],
    ).toEqual({ role: "user", content: "Hello\n\u0000 😀" });
  });

  it("returns an empty, valid, exactly counted export", () => {
    expect(buildConversationJsonl([])).toMatchObject({
      ok: true,
      text: "",
      rowCount: 0,
      threadCount: 0,
      messageCount: 0,
      byteCount: 0,
    });
  });

  it("fails rather than truncating every configured boundary", () => {
    const base: ConversationExportLimits = {
      maximumMessages: 3,
      maximumThreads: 2,
      maximumBodyBytes: 100,
      maximumLineBytes: 500,
      maximumBytes: 1_000,
    };
    expect(
      buildConversationJsonl([...rows, rows[0]!], {
        ...base,
        maximumMessages: 3,
      }),
    ).toMatchObject({ ok: false, reason: "message_limit" });
    expect(
      buildConversationJsonl(rows, { ...base, maximumThreads: 1 }),
    ).toMatchObject({ ok: false, reason: "thread_limit" });
    expect(
      buildConversationJsonl(rows, { ...base, maximumBodyBytes: 3 }),
    ).toMatchObject({ ok: false, reason: "body_limit" });
    expect(
      buildConversationJsonl(rows, { ...base, maximumLineBytes: 20 }),
    ).toMatchObject({ ok: false, reason: "line_limit" });
    expect(
      buildConversationJsonl(rows, { ...base, maximumBytes: 20 }),
    ).toMatchObject({ ok: false, reason: "byte_limit" });
    expect(
      buildConversationJsonl([
        { threadKey: "x", role: "user", content: "\ud800" },
      ]),
    ).toMatchObject({ ok: false, reason: "invalid_row" });
  });
});

describe("Site conversation export receipt boundary", () => {
  it("validates exact receipt counts, bytes, JSONL, and privacy shape", () => {
    const built = buildConversationJsonl([
      { threadKey: "a", role: "user", content: "Hello" },
      { threadKey: "a", role: "assistant", content: "Hi" },
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const headers = receiptHeaders({
      rows: built.rowCount,
      messages: built.messageCount,
      bytes: built.byteCount,
    });
    const receipt = parseConversationExportReceipt(headers, correlationId);
    expect(receipt).not.toBeNull();
    expect(receipt && validateConversationJsonl(built.bytes, receipt)).toBe(
      true,
    );

    headers.set("x-export-message-count", "3");
    expect(
      parseConversationExportReceipt(headers, correlationId),
    ).not.toBeNull();
    const mismatched = parseConversationExportReceipt(headers, correlationId);
    expect(
      mismatched && validateConversationJsonl(built.bytes, mismatched),
    ).toBe(false);
    headers.set("content-disposition", 'attachment; filename="../../x.jsonl"');
    expect(parseConversationExportReceipt(headers, correlationId)).toBeNull();
  });

  it("rejects extra identity fields even when JSON and byte counts are valid", () => {
    const text =
      '{"messages":[{"role":"user","content":"Hi","phone":"+1555"}]}\n';
    const bytes = new TextEncoder().encode(text);
    const receipt = parseConversationExportReceipt(
      receiptHeaders({ rows: 1, messages: 1, bytes: bytes.byteLength }),
      correlationId,
    );
    expect(receipt).not.toBeNull();
    expect(receipt && validateConversationJsonl(bytes, receipt)).toBe(false);
  });

  it("rejects malformed Unicode after decoding an otherwise valid JSON line", () => {
    const text = '{"messages":[{"role":"user","content":"\\ud800"}]}\n';
    const bytes = new TextEncoder().encode(text);
    const receipt = parseConversationExportReceipt(
      receiptHeaders({ rows: 1, messages: 1, bytes: bytes.byteLength }),
      correlationId,
    );
    expect(receipt).not.toBeNull();
    expect(receipt && validateConversationJsonl(bytes, receipt)).toBe(false);
  });

  it("reads the full bounded body before release and rejects length mismatch", async () => {
    const body = new TextEncoder().encode("bounded");
    const response = new Response(body, {
      headers: { "content-length": String(body.byteLength) },
    });
    await expect(
      readBoundedExportResponse(response, body.byteLength, body.byteLength),
    ).resolves.toEqual(body);

    const mismatch = new Response(body, {
      headers: { "content-length": String(body.byteLength + 1) },
    });
    await expect(
      readBoundedExportResponse(mismatch, body.byteLength + 1, body.byteLength),
    ).resolves.toBeNull();
  });

  it("enforces same-origin POST context and strict correlated errors", () => {
    expect(
      isSameOriginConversationExportRequest({
        url: "https://site.example.test/api/team/inbox/export",
        headers: new Headers({
          origin: "https://site.example.test",
          "sec-fetch-site": "same-origin",
        }),
      }),
    ).toBe(true);
    expect(
      isSameOriginConversationExportRequest({
        url: "https://site.example.test/api/team/inbox/export",
        headers: new Headers({ origin: "https://evil.example.test" }),
      }),
    ).toBe(false);

    const headers = new Headers({
      "content-type": "application/json",
      "x-audit-correlation-id": correlationId,
    });
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        error: "forbidden",
        message: "Export denied.",
        correlationId,
        supportId: correlationId,
        retryable: false,
      }),
    );
    expect(parseConversationExportError(bytes, headers, correlationId)).toEqual(
      {
        error: "forbidden",
        message: "Export denied.",
        correlationId,
        supportId: correlationId,
        retryable: false,
      },
    );
    expect(
      parseConversationExportError(
        new TextEncoder().encode(
          JSON.stringify({
            error: "forbidden",
            message: "Export denied.",
            correlationId: receiptId,
            supportId: receiptId,
            retryable: false,
          }),
        ),
        headers,
        correlationId,
      ),
    ).toBeNull();
  });

  it("validates the exact finalization acknowledgement", () => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-audit-correlation-id": correlationId,
    });
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        ok: true,
        correlationId,
        exportId: receiptId,
        outcome: "released",
        idempotent: false,
      }),
    );
    expect(
      parseConversationExportFinalizationAck(bytes, headers, {
        correlationId,
        exportId: receiptId,
        outcome: "released",
      }),
    ).toEqual({
      correlationId,
      exportId: receiptId,
      outcome: "released",
      idempotent: false,
    });
  });

  it("recovers a committed release when the first acknowledgement is lost", async () => {
    const invoke = jest
      .fn<Promise<Response>, [Record<string, unknown>]>()
      .mockRejectedValueOnce(new TypeError("response_lost_after_commit"))
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: true,
            correlationId,
            exportId: receiptId,
            outcome: "released",
            idempotent: true,
          },
          {
            headers: { "x-audit-correlation-id": correlationId },
          },
        ),
      );

    await expect(
      finalizeSiteConversationExport({
        correlationId,
        exportId: receiptId,
        outcome: "released",
        reason: null,
        deadlineAt: Date.now() + 1_000,
        invoke,
      }),
    ).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ correlationId });
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({ correlationId });
    expect(invoke.mock.calls[1]?.[0]?.["body"]).toBe(
      invoke.mock.calls[0]?.[0]?.["body"],
    );
    expect(JSON.parse(String(invoke.mock.calls[0]?.[0]?.["body"]))).toEqual({
      correlationId,
      exportId: receiptId,
      outcome: "released",
      reason: null,
    });
  });

  it("requires idempotency after observing a malformed successful acknowledgement", async () => {
    const invoke = jest
      .fn<Promise<Response>, [Record<string, unknown>]>()
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: true,
            correlationId,
            exportId: receiptId,
            outcome: "released",
          },
          {
            headers: { "x-audit-correlation-id": correlationId },
          },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: true,
            correlationId,
            exportId: receiptId,
            outcome: "released",
            idempotent: false,
          },
          {
            headers: { "x-audit-correlation-id": correlationId },
          },
        ),
      );

    await expect(
      finalizeSiteConversationExport({
        correlationId,
        exportId: receiptId,
        outcome: "released",
        reason: null,
        deadlineAt: Date.now() + 1_000,
        invoke,
      }),
    ).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("accepts an exact first-commit receipt when the initial transport failed before arrival", async () => {
    const invoke = jest
      .fn<Promise<Response>, [Record<string, unknown>]>()
      .mockRejectedValueOnce(new TypeError("connection_not_established"))
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: true,
            correlationId,
            exportId: receiptId,
            outcome: "released",
            idempotent: false,
          },
          {
            headers: { "x-audit-correlation-id": correlationId },
          },
        ),
      );

    await expect(
      finalizeSiteConversationExport({
        correlationId,
        exportId: receiptId,
        outcome: "released",
        reason: null,
        deadlineAt: Date.now() + 1_000,
        invoke,
      }),
    ).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("cancels a body that cannot complete before the absolute deadline", async () => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setTimeout(() => controller.close(), 100);
        },
        cancel() {
          if (timer) clearTimeout(timer);
          return new Promise<void>(() => {
            // Prove that a hostile/non-settling cancellation cannot extend the
            // absolute body deadline.
          });
        },
      }),
    );
    await expect(
      readBoundedExportResponse(response, 10, undefined, {
        deadlineAt: Date.now() + 1,
      }),
    ).rejects.toBeInstanceOf(ConversationExportBodyTimeoutError);
  });
});

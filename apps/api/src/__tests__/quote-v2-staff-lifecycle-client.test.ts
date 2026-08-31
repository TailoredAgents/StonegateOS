import {
  QuoteV2StaffClient,
  type QuoteV2ClientError,
} from "../../../site/src/app/team/lib/quote-v2-client";

const QUOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const CHANGE_ID = "33333333-3333-4333-8333-333333333333";
const REPLACEMENT_ID = "44444444-4444-4444-8444-444444444444";
const RESPONSE_ID = "55555555-5555-4555-8555-555555555555";

function jsonResponse(
  data: Record<string, unknown>,
  correlation = "corr-test",
) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": correlation,
    },
  });
}

type RecordingFetch = typeof fetch & { calls: Parameters<typeof fetch>[] };

function fetcherReturning(...responses: Response[]): RecordingFetch {
  const calls: Parameters<typeof fetch>[] = [];
  let responseIndex = 0;
  const fetcher = ((...args: Parameters<typeof fetch>): Promise<Response> => {
    calls.push(args);
    const response = responses[responseIndex];
    responseIndex += 1;
    if (!response) {
      return Promise.reject(new Error("No recorded response remains."));
    }
    return Promise.resolve(response);
  }) as RecordingFetch;
  fetcher.calls = calls;
  return fetcher;
}

function requestBody(fetcher: RecordingFetch, call = 0) {
  const [, init] = fetcher.calls[call]!;
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON request body.");
  }
  return {
    init,
    headers: new Headers(init?.headers),
    body: JSON.parse(init.body) as Record<string, unknown>,
  };
}

describe("Quote V2 staff lifecycle client", () => {
  it("records acceptance against the exact version with CAS, evidence, and a verified receipt", async () => {
    const fetcher = fetcherReturning(
      jsonResponse({
        quoteId: QUOTE_ID,
        versionId: VERSION_ID,
        responseId: RESPONSE_ID,
        decision: "accepted",
        quoteRevision: 8,
      }),
    );
    const client = new QuoteV2StaffClient({ fetcher });

    await expect(
      client.recordStaffDecision({
        quoteId: QUOTE_ID,
        versionId: VERSION_ID,
        quoteRevision: 7,
        decision: "accepted",
        source: "phone",
        notes: "The client approved on the recorded call.",
        signer: {
          name: "Avery Client",
          title: "Facilities Director",
          company: "Avery Industries",
        },
        selectedOptionIds: ["opt-a", "opt-a", "opt-b"],
        consentVersion: "fixed_quote-consent-v1",
        notifyCustomer: true,
        idempotencyKey: "quote-v2:staff-decision:one",
        correlationId: "quote-v2:staff-decision-correlation:one",
      }),
    ).resolves.toEqual({
      quoteId: QUOTE_ID,
      versionId: VERSION_ID,
      responseId: RESPONSE_ID,
      decision: "accepted",
      quoteRevision: 8,
      correlationId: "corr-test",
    });

    expect(fetcher.calls[0]?.[0]).toBe(
      `/api/team/quotes/v2/quotes/${QUOTE_ID}/decisions`,
    );
    expect(fetcher.calls[0]?.[1]).toMatchObject({
      method: "POST",
      cache: "no-store",
    });
    const request = requestBody(fetcher);
    expect(request.headers.get("If-Match")).toBe("7");
    expect(request.headers.get("Idempotency-Key")).toBe(
      "quote-v2:staff-decision:one",
    );
    expect(request.headers.get("x-correlation-id")).toBe(
      "quote-v2:staff-decision-correlation:one",
    );
    expect(request.body).toEqual({
      confirmation: "record_quote_v2_decision",
      quoteId: QUOTE_ID,
      versionId: VERSION_ID,
      quoteRevision: 7,
      decision: "accepted",
      source: "phone",
      notes: "The client approved on the recorded call.",
      signer: {
        name: "Avery Client",
        title: "Facilities Director",
        company: "Avery Industries",
        authorityAffirmed: true,
      },
      selectedOptionIds: ["opt-a", "opt-b"],
      consentVersion: "fixed_quote-consent-v1",
      consentAffirmed: true,
      notifyCustomer: true,
    });
  });

  it("resolves the exact change request by revision or unchanged reopen", async () => {
    const fetcher = fetcherReturning(
      jsonResponse({
        quoteId: QUOTE_ID,
        changeRequestId: CHANGE_ID,
        sourceVersionId: VERSION_ID,
        resultingVersionId: REPLACEMENT_ID,
        resolution: "revision",
        quoteRevision: 10,
      }),
      jsonResponse({
        quoteId: QUOTE_ID,
        changeRequestId: CHANGE_ID,
        sourceVersionId: VERSION_ID,
        resultingVersionId: VERSION_ID,
        resolution: "reopen_unchanged",
        quoteRevision: 11,
      }),
    );
    const client = new QuoteV2StaffClient({ fetcher });

    await client.resolveChangeRequest({
      quoteId: QUOTE_ID,
      changeRequestId: CHANGE_ID,
      quoteVersionId: VERSION_ID,
      quoteRevision: 9,
      resolution: "revision",
      replacementVersionId: REPLACEMENT_ID,
      resolutionNote: "Issued the corrected scope.",
      notifyCustomer: false,
      idempotencyKey: "quote-v2:change-resolution:one",
    });
    await client.resolveChangeRequest({
      quoteId: QUOTE_ID,
      changeRequestId: CHANGE_ID,
      quoteVersionId: VERSION_ID,
      quoteRevision: 10,
      resolution: "reopen_unchanged",
      resolutionNote: "Confirmed the existing scope remains correct.",
      notifyCustomer: true,
      idempotencyKey: "quote-v2:change-resolution:two",
    });

    expect(fetcher.calls[0]?.[0]).toBe(
      `/api/team/quotes/v2/quotes/${QUOTE_ID}/change-requests/${CHANGE_ID}/resolve`,
    );
    expect(requestBody(fetcher, 0).body).toEqual(
      expect.objectContaining({
        quoteId: QUOTE_ID,
        quoteVersionId: VERSION_ID,
        resolution: "revision",
        replacementVersionId: REPLACEMENT_ID,
      }),
    );
    expect(requestBody(fetcher, 1).body).toEqual(
      expect.objectContaining({
        quoteId: QUOTE_ID,
        quoteVersionId: VERSION_ID,
        resolution: "reopen_unchanged",
        notifyCustomer: true,
      }),
    );
    expect(requestBody(fetcher, 1).body).not.toHaveProperty(
      "replacementVersionId",
    );
  });

  it("uses distinct confirmed void and archive commands with exact current-version CAS", async () => {
    const fetcher = fetcherReturning(
      jsonResponse({
        quoteId: QUOTE_ID,
        versionId: VERSION_ID,
        state: "voided",
        quoteRevision: 4,
      }),
      jsonResponse({
        quoteId: QUOTE_ID,
        versionId: VERSION_ID,
        state: "archived",
        quoteRevision: 5,
      }),
    );
    const client = new QuoteV2StaffClient({ fetcher });
    const common = {
      quoteId: QUOTE_ID,
      versionId: VERSION_ID,
      reason: "The project record is complete.",
      notifyCustomer: false,
    };

    await client.voidQuote({
      ...common,
      quoteRevision: 3,
      idempotencyKey: "quote-v2:void-quote:one",
    });
    await client.archiveQuote({
      ...common,
      quoteRevision: 4,
      idempotencyKey: "quote-v2:archive-quote:one",
    });

    expect(fetcher.calls[0]?.[0]).toBe(
      `/api/team/quotes/v2/quotes/${QUOTE_ID}/void`,
    );
    expect(requestBody(fetcher, 0).body).toEqual({
      confirmation: "void_quote_v2",
      versionId: VERSION_ID,
      quoteRevision: 3,
      reason: "The project record is complete.",
      notifyCustomer: false,
    });
    expect(fetcher.calls[1]?.[0]).toBe(
      `/api/team/quotes/v2/quotes/${QUOTE_ID}/archive`,
    );
    expect(requestBody(fetcher, 1).body).toEqual({
      confirmation: "archive_quote_v2",
      versionId: VERSION_ID,
      quoteRevision: 4,
      reason: "The project record is complete.",
      notifyCustomer: false,
    });
  });

  it("fails closed when a successful response cannot be bound to the command", async () => {
    const fetcher = fetcherReturning(
      jsonResponse({
        quoteId: QUOTE_ID,
        versionId: REPLACEMENT_ID,
        responseId: RESPONSE_ID,
        decision: "declined",
        quoteRevision: 8,
      }),
    );
    const client = new QuoteV2StaffClient({ fetcher });

    let capturedError: unknown;
    try {
      await client.recordStaffDecision({
        quoteId: QUOTE_ID,
        versionId: VERSION_ID,
        quoteRevision: 7,
        decision: "declined",
        source: "email",
        notes: "Client declined by email.",
        signer: { name: "Avery Client" },
        category: "timing",
        notifyCustomer: false,
        idempotencyKey: "quote-v2:staff-decision:bad-receipt",
      });
    } catch (error) {
      capturedError = error;
    }
    const clientError = capturedError as QuoteV2ClientError;
    expect(clientError.detail.code).toBe("unverified_receipt");
  });
});

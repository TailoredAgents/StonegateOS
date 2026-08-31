import { NextRequest } from "next/server";
import { PartnerPortalSchedulingError } from "@/lib/partner-portal-v2-scheduling/errors";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockRequirePartnerCapability = jest.fn<
  Promise<unknown>,
  [unknown, unknown]
>();
const mockRequirePartnerSchedulingActor = jest.fn<
  unknown,
  [unknown, unknown]
>();
const mockCreatePartnerBookingDraft = jest.fn<Promise<unknown>, [unknown]>();
const mockCreatePartnerRescheduleDraft = jest.fn<Promise<unknown>, [unknown]>();
const mockCreateOrReplacePartnerHold = jest.fn<Promise<unknown>, [unknown]>();
const mockGetPartnerDraftAvailability = jest.fn<Promise<unknown>, [unknown]>();
const mockReleasePartnerHold = jest.fn<Promise<unknown>, [unknown]>();
const mockReschedulePartnerBooking = jest.fn<Promise<unknown>, [unknown]>();
const mockSubmitPartnerBookingDraft = jest.fn<Promise<unknown>, [unknown]>();
const mockUpdatePartnerBookingDraft = jest.fn<Promise<unknown>, [unknown]>();
const mockValidateAndSavePartnerBookingDraft = jest.fn<
  Promise<unknown>,
  [unknown]
>();
const mockParsePartnerDraftMutation = jest.fn<unknown, [unknown, unknown?]>();
const mockRequirePartnerArrivalWindowId = jest.fn<unknown, [unknown]>();
const mockRequirePortalUuid = jest.fn<unknown, [unknown, unknown?]>();

mockModule("@/lib/partner-account-authorization", () => ({
  requirePartnerCapability: mockRequirePartnerCapability,
}));

mockModule("@/lib/partner-portal-v2-scheduling", () => ({
  createPartnerBookingDraft: mockCreatePartnerBookingDraft,
  createPartnerRescheduleDraft: mockCreatePartnerRescheduleDraft,
  createOrReplacePartnerHold: mockCreateOrReplacePartnerHold,
  getPartnerDraftAvailability: mockGetPartnerDraftAvailability,
  getPartnerBookingDraft: jest.fn(),
  PartnerPortalSchedulingError,
  parsePartnerDraftMutation: mockParsePartnerDraftMutation,
  releasePartnerHold: mockReleasePartnerHold,
  reschedulePartnerBooking: mockReschedulePartnerBooking,
  requirePartnerArrivalWindowId: mockRequirePartnerArrivalWindowId,
  requirePartnerSchedulingActor: mockRequirePartnerSchedulingActor,
  requirePortalUuid: mockRequirePortalUuid,
  submitPartnerBookingDraft: mockSubmitPartnerBookingDraft,
  updatePartnerBookingDraft: mockUpdatePartnerBookingDraft,
  validateAndSavePartnerBookingDraft: mockValidateAndSavePartnerBookingDraft,
}));

const { POST: createDraft } = await import(
  "../../app/api/portal/v2/booking-drafts/route"
);
const { PATCH: updateDraft } = await import(
  "../../app/api/portal/v2/booking-drafts/[draftId]/route"
);
const { GET: getAvailability } = await import(
  "../../app/api/portal/v2/booking-drafts/[draftId]/availability/route"
);
const { DELETE: releaseHold, POST: createHold } = await import(
  "../../app/api/portal/v2/booking-drafts/[draftId]/hold/route"
);
const { POST: submitDraft } = await import(
  "../../app/api/portal/v2/booking-drafts/[draftId]/submit/route"
);
const { POST: validateDraft } = await import(
  "../../app/api/portal/v2/booking-drafts/[draftId]/validate/route"
);
const { POST: createRescheduleDraft } = await import(
  "../../app/api/portal/v2/jobs/[jobId]/reschedule-draft/route"
);
const { POST: submitReschedule } = await import(
  "../../app/api/portal/v2/jobs/[jobId]/reschedule/route"
);

const CORRELATION_ID = "portal-scheduling-test-0001";
const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const HOLD_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING_ID = "33333333-3333-4333-8333-333333333333";
const ETAG = '"portal-v2-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"';

function draft() {
  return {
    id: DRAFT_ID,
    state: "draft",
    revision: 1,
    etag: ETAG,
  };
}

describe("partner portal V2 scheduling route contracts", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockRequirePartnerCapability.mockResolvedValue({
      ok: true,
      principal: { accountId: "account" },
    });
    mockRequirePartnerSchedulingActor.mockReturnValue({ accountId: "account" });
    mockParsePartnerDraftMutation.mockImplementation((value) => value);
    mockRequirePartnerArrivalWindowId.mockImplementation((value) => value);
    mockRequirePortalUuid.mockImplementation((value) => value);
  });

  it("preserves precise authorization failure codes", async () => {
    mockRequirePartnerCapability.mockResolvedValue({
      ok: false,
      status: 401,
      error: "session_expired",
    });
    const request = new NextRequest(
      "http://localhost/api/portal/v2/booking-drafts",
      {
        method: "POST",
        headers: { "x-correlation-id": CORRELATION_ID },
      },
    );

    const response = await createDraft(request);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body["error"]).toBe("session_expired");
  });

  it("rejects draft creation without an Idempotency-Key before reading the body", async () => {
    const request = new NextRequest(
      "http://localhost/api/portal/v2/booking-drafts",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": CORRELATION_ID,
        },
        body: "not-json",
      },
    );

    const response = await createDraft(request);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toEqual(
      expect.objectContaining({
        ok: false,
        error: "idempotency_key_required",
        correlationId: CORRELATION_ID,
        retryable: false,
      }),
    );
    expect(mockCreatePartnerBookingDraft).not.toHaveBeenCalled();
  });

  it("persists only an idempotency hash and returns no-store ETag metadata", async () => {
    mockCreatePartnerBookingDraft.mockResolvedValue({
      draft: draft(),
      replayed: false,
    });
    const rawKey = "portal-draft-attempt-00000001";
    const request = new NextRequest(
      "http://localhost/api/portal/v2/booking-drafts",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": rawKey,
          "x-correlation-id": CORRELATION_ID,
        },
        body: JSON.stringify({ description: "Remove desks" }),
      },
    );

    const response = await createDraft(request);
    const body = await response.text();

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBe(ETAG);
    expect(body).not.toContain(rawKey);
    const createInput = mockCreatePartnerBookingDraft.mock.calls[0]?.[0] as
      | { idempotencyKeyHash?: unknown }
      | undefined;
    expect(createInput?.idempotencyKeyHash).toEqual(
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
  });

  it("passes the strong If-Match precondition into atomic autosave", async () => {
    mockUpdatePartnerBookingDraft.mockResolvedValue({
      ...draft(),
      revision: 2,
    });
    const request = new NextRequest(
      `http://localhost/api/portal/v2/booking-drafts/${DRAFT_ID}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "if-match": ETAG,
          "x-correlation-id": CORRELATION_ID,
        },
        body: JSON.stringify({ description: "Updated scope" }),
      },
    );

    const response = await updateDraft(request, {
      params: Promise.resolve({ draftId: DRAFT_ID }),
    });

    expect(response.status).toBe(200);
    expect(mockUpdatePartnerBookingDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: DRAFT_ID,
        ifMatch: ETAG,
        correlationId: CORRELATION_ID,
      }),
    );
  });

  it("passes bounded RFC3339 availability ranges and exposes the draft ETag", async () => {
    mockGetPartnerDraftAvailability.mockResolvedValue({
      draft: draft(),
      windows: [],
    });
    const from = "2026-09-01T12:00:00.000Z";
    const to = "2026-09-03T12:00:00.000Z";
    const request = new NextRequest(
      `http://localhost/api/portal/v2/booking-drafts/${DRAFT_ID}/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { headers: { "x-correlation-id": CORRELATION_ID } },
    );

    const response = await getAvailability(request, {
      params: Promise.resolve({ draftId: DRAFT_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(ETAG);
    expect(mockGetPartnerDraftAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: DRAFT_ID,
        rangeStartAt: new Date(from),
        rangeEndAt: new Date(to),
      }),
    );
  });

  it("binds a hold to the hashed idempotency key and draft revision", async () => {
    mockCreateOrReplacePartnerHold.mockResolvedValue({
      hold: { id: HOLD_ID, draftId: DRAFT_ID },
      replayed: false,
    });
    const rawKey = "portal-hold-attempt-00000001";
    const request = new NextRequest(
      `http://localhost/api/portal/v2/booking-drafts/${DRAFT_ID}/hold`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": rawKey,
          "if-match": ETAG,
          "x-correlation-id": CORRELATION_ID,
        },
        body: JSON.stringify({ windowId: "2026-09-01:0800" }),
      },
    );

    const response = await createHold(request, {
      params: Promise.resolve({ draftId: DRAFT_ID }),
    });

    expect(response.status).toBe(201);
    const holdInput = mockCreateOrReplacePartnerHold.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(holdInput).toEqual(
      expect.objectContaining({
        draftId: DRAFT_ID,
        windowId: "2026-09-01:0800",
        ifMatch: ETAG,
        correlationId: CORRELATION_ID,
      }),
    );
    const holdIdempotencyHash = holdInput?.["idempotencyKeyHash"];
    if (typeof holdIdempotencyHash !== "string") {
      throw new TypeError("Expected the hold idempotency hash.");
    }
    expect(holdIdempotencyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(holdInput)).not.toContain(rawKey);
  });

  it("rejects internal planned-start input at the public hold boundary", async () => {
    const request = new NextRequest(
      `http://localhost/api/portal/v2/booking-drafts/${DRAFT_ID}/hold`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "portal-hold-attempt-00000002",
          "if-match": ETAG,
          "x-correlation-id": CORRELATION_ID,
        },
        body: JSON.stringify({ startAt: "2026-09-01T12:30:00.000Z" }),
      },
    );

    const response = await createHold(request, {
      params: Promise.resolve({ draftId: DRAFT_ID }),
    });

    expect(response.status).toBe(400);
    expect(mockCreateOrReplacePartnerHold).not.toHaveBeenCalled();
  });

  it("releases only the account-scoped draft hold selected in the query", async () => {
    mockReleasePartnerHold.mockResolvedValue({ released: true });
    const request = new NextRequest(
      `http://localhost/api/portal/v2/booking-drafts/${DRAFT_ID}/hold?holdId=${HOLD_ID}`,
      {
        method: "DELETE",
        headers: { "x-correlation-id": CORRELATION_ID },
      },
    );

    const response = await releaseHold(request, {
      params: Promise.resolve({ draftId: DRAFT_ID }),
    });

    expect(response.status).toBe(200);
    expect(mockReleasePartnerHold).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: DRAFT_ID, holdId: HOLD_ID }),
    );
  });

  it("validates and saves against the caller's strong draft revision", async () => {
    mockValidateAndSavePartnerBookingDraft.mockResolvedValue({
      draft: { ...draft(), revision: 2 },
      validation: { valid: true, ready: true, fieldErrors: {} },
    });
    const request = new NextRequest(
      `http://localhost/api/portal/v2/booking-drafts/${DRAFT_ID}/validate`,
      {
        method: "POST",
        headers: {
          "if-match": ETAG,
          "x-correlation-id": CORRELATION_ID,
        },
      },
    );

    const response = await validateDraft(request, {
      params: Promise.resolve({ draftId: DRAFT_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(ETAG);
    expect(mockValidateAndSavePartnerBookingDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: DRAFT_ID,
        ifMatch: ETAG,
        correlationId: CORRELATION_ID,
      }),
    );
  });

  it("submits the held slot with idempotency, revision, and job location", async () => {
    mockSubmitPartnerBookingDraft.mockResolvedValue({
      booking: { id: BOOKING_ID, draftId: DRAFT_ID },
      replayed: false,
    });
    const rawKey = "portal-submit-attempt-00000001";
    const request = new NextRequest(
      `http://localhost/api/portal/v2/booking-drafts/${DRAFT_ID}/submit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": rawKey,
          "if-match": ETAG,
          "x-correlation-id": CORRELATION_ID,
        },
        body: JSON.stringify({ holdId: HOLD_ID }),
      },
    );

    const response = await submitDraft(request, {
      params: Promise.resolve({ draftId: DRAFT_ID }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(
      `/api/portal/v2/jobs/${BOOKING_ID}`,
    );
    const submitInput = mockSubmitPartnerBookingDraft.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(submitInput).toEqual(
      expect.objectContaining({
        draftId: DRAFT_ID,
        holdId: HOLD_ID,
        ifMatch: ETAG,
        correlationId: CORRELATION_ID,
      }),
    );
    const submitIdempotencyHash = submitInput?.["idempotencyKeyHash"];
    if (typeof submitIdempotencyHash !== "string") {
      throw new TypeError("Expected the submit idempotency hash.");
    }
    expect(submitIdempotencyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(submitInput)).not.toContain(rawKey);
  });

  it("accepts an explicit review request without fabricating a hold", async () => {
    mockSubmitPartnerBookingDraft.mockResolvedValue({
      booking: { id: BOOKING_ID, draftId: DRAFT_ID },
      replayed: false,
    });
    const request = new NextRequest(
      `http://localhost/api/portal/v2/booking-drafts/${DRAFT_ID}/submit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "portal-review-submit-00000001",
          "if-match": ETAG,
          "x-correlation-id": CORRELATION_ID,
        },
        body: JSON.stringify({ submissionMode: "review" }),
      },
    );

    const response = await submitDraft(request, {
      params: Promise.resolve({ draftId: DRAFT_ID }),
    });

    expect(response.status).toBe(201);
    expect(mockSubmitPartnerBookingDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: DRAFT_ID,
        holdId: null,
        ifMatch: ETAG,
      }),
    );
  });

  it("creates a job-bound reschedule draft with job revision and idempotency", async () => {
    mockCreatePartnerRescheduleDraft.mockResolvedValue({
      draft: { ...draft(), rescheduleFromJobId: BOOKING_ID },
      replayed: false,
    });
    const rawKey = "portal-reschedule-draft-00000001";
    const request = new NextRequest(
      `http://localhost/api/portal/v2/jobs/${BOOKING_ID}/reschedule-draft`,
      {
        method: "POST",
        headers: {
          "idempotency-key": rawKey,
          "if-match": ETAG,
          "x-correlation-id": CORRELATION_ID,
        },
      },
    );

    const response = await createRescheduleDraft(request, {
      params: Promise.resolve({ jobId: BOOKING_ID }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe(ETAG);
    expect(response.headers.get("location")).toBe(
      `/api/portal/v2/booking-drafts/${DRAFT_ID}`,
    );
    const createInput = mockCreatePartnerRescheduleDraft.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(createInput).toEqual(
      expect.objectContaining({
        jobId: BOOKING_ID,
        ifMatch: ETAG,
        correlationId: CORRELATION_ID,
      }),
    );
    expect(createInput?.["idempotencyKeyHash"]).toEqual(
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
    expect(JSON.stringify(createInput)).not.toContain(rawKey);
  });

  it("atomically submits a held reschedule and distinguishes review mode", async () => {
    mockReschedulePartnerBooking.mockResolvedValue({
      result: {
        mode: "review",
        jobId: BOOKING_ID,
        requestId: "44444444-4444-4444-8444-444444444444",
        etag: ETAG,
      },
      replayed: false,
    });
    const rawKey = "portal-reschedule-submit-00000001";
    const request = new NextRequest(
      `http://localhost/api/portal/v2/jobs/${BOOKING_ID}/reschedule`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": rawKey,
          "if-match": ETAG,
          "x-correlation-id": CORRELATION_ID,
        },
        body: JSON.stringify({
          draftId: DRAFT_ID,
          holdId: HOLD_ID,
          draftEtag: ETAG,
        }),
      },
    );

    const response = await submitReschedule(request, {
      params: Promise.resolve({ jobId: BOOKING_ID }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(ETAG);
    expect(body["reschedule"]).toEqual(
      expect.objectContaining({ mode: "review", jobId: BOOKING_ID }),
    );
    const submitInput = mockReschedulePartnerBooking.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(submitInput).toEqual(
      expect.objectContaining({
        jobId: BOOKING_ID,
        draftId: DRAFT_ID,
        holdId: HOLD_ID,
        jobIfMatch: ETAG,
        draftIfMatch: ETAG,
        correlationId: CORRELATION_ID,
      }),
    );
    expect(submitInput?.["idempotencyKeyHash"]).toEqual(
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
    expect(JSON.stringify(submitInput)).not.toContain(rawKey);
  });

  it("requires the reschedule draft revision before dispatching a mutation", async () => {
    const request = new NextRequest(
      `http://localhost/api/portal/v2/jobs/${BOOKING_ID}/reschedule`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "portal-reschedule-submit-00000002",
          "if-match": ETAG,
          "x-correlation-id": CORRELATION_ID,
        },
        body: JSON.stringify({ draftId: DRAFT_ID, holdId: HOLD_ID }),
      },
    );

    const response = await submitReschedule(request, {
      params: Promise.resolve({ jobId: BOOKING_ID }),
    });

    expect(response.status).toBe(400);
    expect(mockReschedulePartnerBooking).not.toHaveBeenCalled();
  });
});

import { NextRequest } from "next/server";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const BUSINESS_DATE = "2026-08-26";
const expectAnyDate: unknown = expect.any(Date);

const mockRequirePermission = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockReadPayload = jest.fn();
const mockParse = jest.fn();
const mockValidateDate = jest.fn();
const mockReadDay = jest.fn();
const mockSaveDay = jest.fn();
const mockBegin = jest.fn();
const mockClaim = jest.fn();
const mockComplete = jest.fn();
const mockSettle = jest.fn();

let transactionCount = 0;
const transaction = { name: "transaction" };
const mockDb = {
  transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => {
    transactionCount += 1;
    return work(transaction);
  }),
};
const mockGetDb = jest.fn(() => mockDb);

class MockTeamMutationFailure extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.code = code;
    this.status = options.status ?? (code === "invalid" ? 422 : 500);
    this.retryable = options.retryable ?? false;
  }
}

jest.mock("@/db", () => ({ getDb: mockGetDb }));

jest.mock("@/lib/bounded-json-request", () => ({
  BoundedJsonRequestError: class BoundedJsonRequestError extends Error {},
  readBoundedJsonRequest: mockReadPayload,
}));

jest.mock("@/lib/daily-ad-spend", () => ({
  parseDailyAdSpendSaveInput: mockParse,
  readDailyAdSpendDay: mockReadDay,
  saveDailyAdSpendDay: mockSaveDay,
  validateDailyAdBusinessDate: mockValidateDate,
}));

jest.mock("@/lib/expense-feature-flags", () => ({
  isExpenseAdSpendEnabled: mockFeatureEnabled,
}));

jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));

jest.mock("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: mockClaim,
  completeTeamMutationIdempotency: mockComplete,
  settleTeamMutationIdempotencyFailure: mockSettle,
  teamMutationIdempotencyReplayResponse: jest.fn(
    (replay: { result: unknown; status: number }) =>
      Response.json(replay.result, {
        status: replay.status,
        headers: { "idempotency-replayed": "true" },
      }),
  ),
}));

jest.mock("@/lib/team-mutation", () => ({
  beginTeamMutation: mockBegin,
  TeamMutationFailure: MockTeamMutationFailure,
  teamMutationExceptionResponse: jest.fn((error: unknown) => {
    const failure =
      error instanceof MockTeamMutationFailure
        ? error
        : new MockTeamMutationFailure("internal", "failed");
    return Response.json(
      {
        ok: false,
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
      { status: failure.status },
    );
  }),
  teamMutationResultResponse: jest.fn((result: unknown, status: number) =>
    Response.json(result, { status }),
  ),
  teamMutationSuccessResult: jest.fn(
    (
      mutation: {
        operationId: string;
        correlationId: string;
        actor: { id: string };
      },
      data: unknown,
      receipt: Record<string, unknown>,
    ) => ({
      ok: true,
      data,
      receipt: {
        operationId: mutation.operationId,
        correlationId: mutation.correlationId,
        actorId: mutation.actor.id,
        ...receipt,
      },
    }),
  ),
}));

function getRequest(): NextRequest {
  return new NextRequest(
    `https://api.test/api/admin/expenses/daily-ad-spend?businessDate=${BUSINESS_DATE}`,
  );
}

function mutationRequest(method: "POST" | "PUT" = "POST"): NextRequest {
  return new NextRequest("https://api.test/api/admin/expenses/daily-ad-spend", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      businessDate: BUSINESS_DATE,
      facebook: { amountCents: 1_000, version: null },
      google: { amountCents: 0, version: null },
    }),
  });
}

const parsed = {
  businessDate: BUSINESS_DATE,
  facebook: { amountCents: 1_000, version: null },
  google: { amountCents: 0, version: null },
};

const saved = {
  businessDate: BUSINESS_DATE,
  timezone: "America/New_York",
  facebook: {
    amountCents: 1_000,
    version: 1,
    expenseId: "22222222-2222-4222-8222-222222222222",
    confirmedAt: "2026-08-27T14:00:00.000Z",
  },
  google: {
    amountCents: 0,
    version: 1,
    expenseId: null,
    confirmedAt: "2026-08-27T14:00:00.000Z",
  },
  changes: [
    {
      platform: "facebook",
      kind: "posted",
      previousAmountCents: null,
      amountCents: 1_000,
      previousExpenseId: null,
      expenseId: "22222222-2222-4222-8222-222222222222",
      reversalExpenseId: null,
      version: 1,
    },
    {
      platform: "google",
      kind: "confirmed_zero",
      previousAmountCents: null,
      amountCents: 0,
      previousExpenseId: null,
      expenseId: null,
      reversalExpenseId: null,
      version: 1,
    },
  ],
};

describe("daily advertising route boundary and idempotency", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    transactionCount = 0;
    mockFeatureEnabled.mockReturnValue(true);
    mockRequirePermission.mockResolvedValue(null);
    mockValidateDate.mockReturnValue(BUSINESS_DATE);
    mockReadDay.mockResolvedValue({
      businessDate: BUSINESS_DATE,
      timezone: "America/New_York",
      facebook: null,
      google: null,
    });
    mockReadPayload.mockResolvedValue(parsed);
    mockParse.mockReturnValue(parsed);
    mockSaveDay.mockResolvedValue(saved);
    mockBegin.mockResolvedValue({
      ok: true,
      mutation: {
        actor: { id: ACTOR_ID },
        operationId: "operation-1",
        correlationId: "correlation-1",
        audit: {
          insertSuccess: jest.fn(() =>
            Promise.resolve({
              auditEventId: "audit-1",
              committedAt: "2026-08-27T14:00:00.000Z",
            }),
          ),
        },
      },
    });
    mockClaim.mockResolvedValue({
      kind: "execute",
      claim: { id: "claim-1" },
    });
    mockComplete.mockResolvedValue(undefined);
    mockSettle.mockResolvedValue(undefined);
  });

  it("requires ad_spend.write before reading the date or database", async () => {
    const denied = Response.json({ error: "forbidden" }, { status: 403 });
    mockRequirePermission.mockResolvedValueOnce(denied);
    const { GET } = await import(
      "../../app/api/admin/expenses/daily-ad-spend/route"
    );
    const request = getRequest();
    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(mockRequirePermission).toHaveBeenCalledWith(
      request,
      "ad_spend.write",
    );
    expect(mockValidateDate).not.toHaveBeenCalled();
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("requires the owner capability before reading a mutation body", async () => {
    const denied = Response.json(
      { ok: false, code: "forbidden" },
      { status: 403 },
    );
    mockBegin.mockResolvedValueOnce({ ok: false, response: denied });
    const { POST } = await import(
      "../../app/api/admin/expenses/daily-ad-spend/route"
    );
    const request = mutationRequest();
    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(mockBegin).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        principalTypes: ["human"],
        requiredPermissions: ["ad_spend.write"],
        risk: "financial",
        requiresIdempotency: true,
        auditAction: "expense.daily_ad_spend_saved",
      }),
    );
    expect(mockReadPayload).not.toHaveBeenCalled();
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("returns the durable result on retry without another transaction", async () => {
    mockClaim.mockResolvedValueOnce({
      kind: "replay",
      replay: {
        result: { ok: true, data: saved, receipt: {} },
        status: 200,
        correlationId: "original-correlation",
      },
    });
    const { POST } = await import(
      "../../app/api/admin/expenses/daily-ad-spend/route"
    );
    const response = await POST(mutationRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("idempotency-replayed")).toBe("true");
    expect(transactionCount).toBe(0);
    expect(mockSaveDay).not.toHaveBeenCalled();
  });

  it("co-commits the two-platform save, audit, and idempotency receipt", async () => {
    const { PUT } = await import(
      "../../app/api/admin/expenses/daily-ad-spend/route"
    );
    const response = await PUT(mutationRequest("PUT"));
    const body = (await response.json()) as {
      ok: boolean;
      data?: typeof saved;
      receipt?: unknown;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data?.facebook.amountCents).toBe(1_000);
    expect(body.data?.google.amountCents).toBe(0);
    expect(body.receipt).toBeDefined();
    expect(transactionCount).toBe(1);
    expect(mockSaveDay).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        ...parsed,
        actorId: ACTOR_ID,
        now: expectAnyDate,
      }),
    );
    expect(mockComplete).toHaveBeenCalledWith(
      transaction,
      expect.any(Object),
      { id: "claim-1" },
      expect.objectContaining({ ok: true }),
      200,
    );
  });

  it("fails closed when the ad-spend rollout flag is disabled", async () => {
    mockFeatureEnabled.mockReturnValueOnce(false);
    const { POST } = await import(
      "../../app/api/admin/expenses/daily-ad-spend/route"
    );
    const response = await POST(mutationRequest());
    expect(response.status).toBe(503);
    expect(mockReadPayload).not.toHaveBeenCalled();
    expect(mockGetDb).not.toHaveBeenCalled();
  });
});

import type { NextRequest } from "next/server";

const mockRequirePermission = jest.fn();
const mockGetAuditActorFromRequest = jest.fn();
const mockRecordAuditEvent = jest.fn();
const mockParseReviewQuery = jest.fn();
const mockListExactDuplicates = jest.fn();

jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));

jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: mockGetAuditActorFromRequest,
  recordAuditEvent: mockRecordAuditEvent,
}));

jest.mock("@/lib/expense-receipt-captures", () => ({
  createExpenseReceiptUploadIntent: jest.fn(),
  listExactDuplicateExpenseReceiptCaptures: mockListExactDuplicates,
  parseExactDuplicateCaptureReviewQuery: mockParseReviewQuery,
}));

jest.mock("@/lib/expense-receipt-capture-route", () => ({
  expenseReceiptCaptureErrorResponse: jest.fn((error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "capture_failed" },
      { status: 400 },
    ),
  ),
  requireExpenseCaptureActorId: jest.fn(),
}));

import { GET } from "../../app/api/admin/expenses/captures/route";

function request(query = ""): NextRequest {
  const url = new URL(
    `https://api.example.test/api/admin/expenses/captures${query}`,
  );
  const raw = new Request(url);
  Object.defineProperty(raw, "nextUrl", { value: url });
  return raw as unknown as NextRequest;
}

describe("exact duplicate receipt review route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequirePermission.mockResolvedValue(null);
    mockGetAuditActorFromRequest.mockReturnValue({
      type: "human",
      id: "11111111-1111-4111-8111-111111111111",
    });
    mockParseReviewQuery.mockReturnValue({ limit: 25, cursor: null });
    mockListExactDuplicates.mockResolvedValue({
      captures: [
        {
          capture: { id: "22222222-2222-4222-8222-222222222222" },
          submitter: {
            id: "33333333-3333-4333-8333-333333333333",
            name: "Crew member",
          },
          duplicate: {
            capture: { id: "44444444-4444-4444-8444-444444444444" },
            expense: null,
          },
        },
      ],
      page: { limit: 25, hasMore: false, nextCursor: null },
    });
    mockRecordAuditEvent.mockResolvedValue(undefined);
  });

  it("denies a crew caller before reading query data or touching the queue", async () => {
    const denial = Response.json({ error: "forbidden" }, { status: 403 });
    mockRequirePermission.mockResolvedValue(denial);
    let queryRead = false;
    const deniedRequest = Object.defineProperty({}, "nextUrl", {
      get() {
        queryRead = true;
        throw new Error("query must not be read before authorization");
      },
    }) as NextRequest;

    const response = await GET(deniedRequest);

    expect(response).toBe(denial);
    expect(mockRequirePermission).toHaveBeenCalledWith(
      deniedRequest,
      "expenses.approve",
    );
    expect(queryRead).toBe(false);
    expect(mockParseReviewQuery).not.toHaveBeenCalled();
    expect(mockListExactDuplicates).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  it("returns only the bounded exact-duplicate review queue to an approver", async () => {
    const reviewRequest = request("?limit=25");

    const response = await GET(reviewRequest);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockRequirePermission).toHaveBeenCalledWith(
      reviewRequest,
      "expenses.approve",
    );
    expect(mockParseReviewQuery).toHaveBeenCalledWith(
      reviewRequest.nextUrl.searchParams,
    );
    expect(mockListExactDuplicates).toHaveBeenCalledWith({
      limit: 25,
      cursor: null,
    });
    expect(body).toMatchObject({
      ok: true,
      reviewType: "exact_duplicates",
      captures: [
        {
          capture: { id: "22222222-2222-4222-8222-222222222222" },
          submitter: { name: "Crew member" },
          duplicate: {
            capture: { id: "44444444-4444-4444-8444-444444444444" },
          },
        },
      ],
      page: { limit: 25, hasMore: false, nextCursor: null },
    });
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "expense.receipt.exact_duplicate_queue_viewed",
        requiredPermissions: ["expenses.approve"],
        meta: { resultCount: 1, hasMore: false },
      }),
    );
  });
});

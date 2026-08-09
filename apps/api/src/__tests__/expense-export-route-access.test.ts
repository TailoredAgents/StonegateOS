import type { NextRequest } from "next/server";

const mockRequirePermission = jest.fn<
  Promise<Response | null>,
  [NextRequest, string]
>();
const mockGetDb = jest.fn(() => {
  throw new Error("database must not be reached");
});
const mockRecordAuditEvent = jest.fn();

jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));

jest.mock("@/db", () => ({
  expenses: {
    id: "expenses.id",
    amount: "expenses.amount",
    currency: "expenses.currency",
    category: "expenses.category",
    vendor: "expenses.vendor",
    memo: "expenses.memo",
    method: "expenses.method",
    source: "expenses.source",
    paidAt: "expenses.paid_at",
    coverageStartAt: "expenses.coverage_start_at",
    coverageEndAt: "expenses.coverage_end_at",
    lifecycleStatus: "expenses.lifecycle_status",
    postedAt: "expenses.posted_at",
    voidedAt: "expenses.voided_at",
    correctedAt: "expenses.corrected_at",
    createdAt: "expenses.created_at",
  },
  getDb: mockGetDb,
}));

jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: jest.fn(() => ({ id: "actor" })),
  recordAuditEvent: mockRecordAuditEvent,
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: () => true,
}));

import { GET } from "../../app/api/admin/expenses/export/route";

function request(query = ""): NextRequest {
  const url = new URL(
    `https://api.example.test/api/admin/expenses/export${query}`,
  );
  return {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers(),
  } as unknown as NextRequest;
}

describe("expense export route access boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the permission denial before filters, database reads, or audit", async () => {
    mockRequirePermission.mockResolvedValue(
      Response.json({ error: "forbidden" }, { status: 403 }),
    );

    const response = await GET(request("?limit=not-a-number"));

    expect(response.status).toBe(403);
    expect(mockRequirePermission).toHaveBeenCalledWith(
      expect.anything(),
      "expenses.export",
    );
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  it("returns a truthful 422 for list-only pagination instead of exporting", async () => {
    mockRequirePermission.mockResolvedValue(null);

    const response = await GET(request("?limit=25"));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: "invalid_filter", field: "limit" }),
    );
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });
});

import type { NextRequest } from "next/server";

const mockGetDb = jest.fn();
const mockRequirePermission = jest.fn();
const mockGetAuditActorFromRequest = jest.fn();

jest.mock("@/db", () => ({
  ...jest.requireActual<Record<string, unknown>>("@/db"),
  getDb: mockGetDb,
}));
jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: mockGetAuditActorFromRequest,
}));

import { POST } from "../../app/api/admin/expenses/queue-health/route";

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";

function request(payload: unknown): NextRequest {
  return new Request(
    "https://api.example.test/api/admin/expenses/queue-health",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  ) as NextRequest;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    deviceId: DEVICE_ID,
    queuedCount: 2,
    failedCount: 1,
    oldestQueuedAt: new Date(now - 60 * 60 * 1_000).toISOString(),
    reportedAt: new Date(now - 1_000).toISOString(),
    ...overrides,
  };
}

function databaseReturning(row: Record<string, unknown>) {
  const returning = jest.fn().mockResolvedValue([row]);
  const onConflictDoUpdate = jest.fn(() => ({ returning }));
  const values = jest.fn(() => ({ onConflictDoUpdate }));
  const insert = jest.fn(() => ({ values }));
  return { database: { insert }, insert, values, onConflictDoUpdate };
}

describe("expense queue health route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequirePermission.mockResolvedValue(null);
    mockGetAuditActorFromRequest.mockReturnValue({
      type: "human",
      id: MEMBER_ID,
      label: "Crew Member",
    });
  });

  it("requires expense submission permission before reading the report", async () => {
    const denied = Response.json({ error: "forbidden" }, { status: 403 });
    mockRequirePermission.mockResolvedValue(denied);
    const incoming = request(validPayload());

    const response = await POST(incoming);

    expect(response).toBe(denied);
    expect(mockRequirePermission).toHaveBeenCalledWith(
      incoming,
      "expenses.submit",
    );
    expect(mockGetAuditActorFromRequest).not.toHaveBeenCalled();
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("rejects receipt content and other undeclared fields before database access", async () => {
    const response = await POST(
      request(validPayload({ filename: "private-receipt.jpg" })),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("upserts only metadata for the authenticated member and returns no-store", async () => {
    const payload = validPayload();
    const reportedAt = new Date(String(payload.reportedAt));
    const oldestQueuedAt = new Date(String(payload.oldestQueuedAt));
    const result = databaseReturning({
      clientDeviceId: DEVICE_ID,
      queuedCount: 2,
      failedCount: 1,
      oldestQueuedAt,
      clientReportedAt: reportedAt,
      lastReportedAt: new Date(),
    });
    mockGetDb.mockReturnValue(result.database);

    const response = await POST(request(payload));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body["accepted"]).toBe(true);
    expect(result.insert).toHaveBeenCalledTimes(1);
    expect(result.values).toHaveBeenCalledWith(
      expect.objectContaining({
        teamMemberId: MEMBER_ID,
        clientDeviceId: DEVICE_ID,
        queuedCount: 2,
        failedCount: 1,
        oldestQueuedAt,
        clientReportedAt: reportedAt,
      }),
    );
    expect(JSON.stringify(body)).not.toContain("filename");
    expect(JSON.stringify(body)).not.toContain("receipt");
  });

  it("requires an authenticated UUID team-member actor", async () => {
    mockGetAuditActorFromRequest.mockReturnValue({
      type: "human",
      id: "owner",
      label: "Owner",
    });

    const response = await POST(request(validPayload()));

    expect(response.status).toBe(401);
    expect(mockGetDb).not.toHaveBeenCalled();
  });
});

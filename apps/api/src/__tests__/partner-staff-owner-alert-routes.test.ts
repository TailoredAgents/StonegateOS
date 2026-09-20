import { NextRequest } from "next/server";
const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  name: string,
  factory: () => Record<string, unknown>,
) => void;

const mockContext = jest.fn<Promise<unknown>, unknown[]>();
const mockBegin = jest.fn<Promise<unknown>, unknown[]>();
const mockSettings = jest.fn<Promise<unknown>, unknown[]>();
const mockOpened = jest.fn<Promise<unknown>, unknown[]>();
const mockChange = jest.fn<Promise<unknown>, unknown[]>();
const mockTest = jest.fn<Promise<unknown>, unknown[]>();
const mockClaim = jest.fn<Promise<unknown>, unknown[]>();
const mockAudit = jest.fn<Promise<unknown>, unknown[]>();
const tx = { fixture: true };
const mockDb = {
  transaction: jest.fn(
    (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  ),
};
mockModule("@/db", () => ({ getDb: () => mockDb }));
mockModule("@/lib/permissions", () => ({
  resolvePermissionContext: (...args: unknown[]) => mockContext(...args),
  permissionMatches: (value: string, required: string) =>
    value === "*" || value === required,
}));
mockModule("@/lib/partner-owner-alerts", () => ({
  ownerAlertSettingsDto: (...args: unknown[]) => mockSettings(...args),
  markOwnerAlertOpened: (...args: unknown[]) => mockOpened(...args),
  changeOwnerAlertSettings: (...args: unknown[]) => mockChange(...args),
  queueOwnerAlertTest: (...args: unknown[]) => mockTest(...args),
}));
mockModule("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: (...args: unknown[]) => mockClaim(...args),
  completeTeamMutationIdempotency: jest.fn(),
  settleTeamMutationIdempotencyFailure: jest.fn(),
  teamMutationIdempotencyReplayResponse: (replay: {
    responseStatus: number;
    responseBody: unknown;
  }) => Response.json(replay.responseBody, { status: replay.responseStatus }),
}));
mockModule("@/lib/team-mutation", () => {
  class TeamMutationFailure extends Error {
    code: string;
    status: number;
    constructor(
      code: string,
      message: string,
      options: { status?: number } = {},
    ) {
      super(message);
      this.code = code;
      this.status = options.status ?? 422;
    }
  }
  return {
    TeamMutationFailure,
    beginTeamMutation: (...args: unknown[]) => mockBegin(...args),
    teamMutationErrorResponse: (code: string, message: string) =>
      Response.json(
        { ok: false, code, message },
        { status: code === "forbidden" ? 403 : 422 },
      ),
    teamMutationExceptionResponse: (
      error: InstanceType<typeof TeamMutationFailure>,
    ) =>
      Response.json(
        { ok: false, code: error.code },
        { status: error.status ?? 500 },
      ),
    teamMutationSuccessResult: (
      _mutation: unknown,
      data: unknown,
      receipt: unknown,
    ) => ({ ok: true, data, receipt }),
    teamMutationResultResponse: (
      result: unknown,
      status: number,
      _correlation: unknown,
      headers: HeadersInit,
    ) => Response.json(result, { status, headers }),
  };
});
const { readOwnerAlertSettings, mutateOwnerAlerts } = await import(
  "@/lib/partner-owner-alert-routes"
);
const ownerId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
function request(method = "POST", body: unknown = {}) {
  return new NextRequest(
    "https://api.example.test/api/admin/partner-management/v1/owner-alerts/settings",
    {
      method,
      ...(method === "GET"
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
  );
}
function allow(role = "owner", expectedVersion: string | null = "4") {
  mockBegin.mockResolvedValue({
    ok: true,
    mutation: {
      actor: { id: ownerId, role },
      expectedVersion,
      correlationId: "owner-route-test",
      audit: { insertSuccess: mockAudit },
    },
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  allow();
  mockContext.mockResolvedValue({
    authenticated: true,
    source: "team_session",
    role: "owner",
    permissions: ["partners.accounts.read", "appointments.read"],
  });
  mockSettings.mockResolvedValue({
    ok: true,
    settings: { enabled: false, revision: 4, phoneLastFour: "0100" },
    owners: [],
    deliveryProblems: [],
  });
  mockOpened.mockResolvedValue({ opened: true });
  mockAudit.mockResolvedValue({
    auditEventId: "audit-1",
    committedAt: "2026-09-19T12:00:00Z",
  });
  mockClaim.mockResolvedValue({
    kind: "replay",
    replay: {
      responseStatus: 200,
      responseBody: { ok: true, data: { state: "queued" } },
    },
  });
});
describe("owner alert HTTP boundaries", () => {
  it.each([
    [{ authenticated: false }, 401],
    [
      {
        authenticated: true,
        source: "service",
        role: "owner",
        permissions: ["*"],
      },
      403,
    ],
    [
      {
        authenticated: true,
        source: "team_session",
        role: "owner",
        permissions: ["partners.accounts.read"],
      },
      403,
    ],
  ])(
    "denies settings reads without a human session and both read permissions",
    async (context, status) => {
      mockContext.mockResolvedValue(context);
      const response = await readOwnerAlertSettings(request("GET"));
      expect(response.status).toBe(status);
      expect(mockSettings).not.toHaveBeenCalled();
    },
  );
  it.each(["owner", "dispatcher"])(
    "passes only owner management visibility into the masked settings DTO for %s",
    async (role) => {
      mockContext.mockResolvedValue({
        authenticated: true,
        source: "team_session",
        role,
        permissions: ["*"],
      });
      const response = await readOwnerAlertSettings(request("GET"));
      expect(response.status).toBe(200);
      expect(mockSettings).toHaveBeenCalledWith(role === "owner");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("etag")).toBe('"4"');
      expect(await response.json()).toMatchObject({
        settings: { phoneLastFour: "0100" },
      });
      expect(mockOpened).not.toHaveBeenCalled();
    },
  );
  it("returns the standard mutation denial before parsing or accessing data", async () => {
    const denial = Response.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
    mockBegin.mockResolvedValue({ ok: false, response: denial });
    expect(await mutateOwnerAlerts(request(), "settings")).toBe(denial);
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockBegin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        principalTypes: ["human"],
        requiredPermissions: ["partners.accounts.read", "appointments.read"],
        requiresIdempotency: true,
      }),
    );
  });
  it("denies a nonowner mutation even when the shared read boundary allows that role", async () => {
    allow("dispatcher");
    expect(
      (await mutateOwnerAlerts(request(), "group_opened", groupId)).status,
    ).toBe(403);
    expect(mockOpened).not.toHaveBeenCalled();
  });
  it.each([null, "*"])(
    "requires a concrete settings revision before settings or external tests: %s",
    async (version) => {
      allow("owner", version);
      for (const action of ["settings", "test"] as const)
        expect((await mutateOwnerAlerts(request(), action)).status).toBe(422);
      expect(mockClaim).not.toHaveBeenCalled();
      expect(mockTest).not.toHaveBeenCalled();
    },
  );
  it("rejects arbitrary opened payloads rather than taking an owner identity from the caller", async () => {
    expect(
      (
        await mutateOwnerAlerts(
          request("POST", { ownerId }),
          "group_opened",
          groupId,
        )
      ).status,
    ).toBe(422);
    expect(mockOpened).not.toHaveBeenCalled();
    expect(
      (await mutateOwnerAlerts(request(), "group_opened", "invalid")).status,
    ).toBe(422);
    expect(mockOpened).not.toHaveBeenCalled();
  });
  it.each(["group_opened", "request_opened"] as const)(
    "marks %s through the authenticated actor and commits its audit in the same transaction",
    async (action) => {
      const response = await mutateOwnerAlerts(request(), action, groupId);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, opened: true });
      expect(mockOpened).toHaveBeenCalledWith(tx, {
        ownerId,
        ...(action === "group_opened" ? { groupId } : { bookingId: groupId }),
      });
      expect(mockAudit).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ entityId: groupId, after: { opened: true } }),
      );
      expect(mockClaim).not.toHaveBeenCalled();
      expect(mockBegin).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ risk: "normal", requiresIdempotency: false }),
      );
    },
  );
  it("replays a prior externally authorized test result without queuing another SMS", async () => {
    const response = await mutateOwnerAlerts(request(), "test");
    expect(await response.json()).toEqual({
      ok: true,
      data: { state: "queued" },
    });
    expect(mockTest).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockBegin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ risk: "external", requiresIdempotency: true }),
    );
    expect(mockClaim).toHaveBeenCalledWith(
      mockDb,
      expect.anything(),
      expect.objectContaining({
        payload: {},
        entityType: "partner_owner_alert_settings",
      }),
    );
  });
});

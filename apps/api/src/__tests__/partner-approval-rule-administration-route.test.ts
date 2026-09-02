import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockRequirePermission = jest.fn<
  Promise<Response | null>,
  [unknown, string]
>();
const mockBeginTeamMutation = jest.fn<Promise<unknown>, [unknown, unknown]>();
const mockReadBoundedJsonRequest = jest.fn<
  Promise<unknown>,
  [unknown, unknown]
>();
const mockListRules = jest.fn<Promise<unknown>, [unknown]>();
const mockListOptions = jest.fn<Promise<unknown>, [unknown]>();
const mockGetRule = jest.fn<Promise<unknown>, [unknown]>();
const mockCreateRule = jest.fn();
const mockUpdateRule = jest.fn();

mockModule("@/db", () => ({
  getDb: jest.fn(() => ({ transaction: jest.fn() })),
}));
mockModule("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
mockModule("@/lib/bounded-json-request", () => ({
  BoundedJsonRequestError: class BoundedJsonRequestError extends Error {
    readonly status = 400;
  },
  readBoundedJsonRequest: mockReadBoundedJsonRequest,
}));
mockModule("@/lib/partner-approval-rule-administration", () => ({
  createPartnerApprovalRuleAsStaff: mockCreateRule,
  getPartnerApprovalRuleForStaff: mockGetRule,
  isStaffPartnerApprovalRuleCursorPayload: jest.fn(() => true),
  listPartnerApprovalRulesForStaff: mockListRules,
  listPartnerApprovalRuleOptionsForStaff: mockListOptions,
  PARTNER_APPROVAL_RULE_CURSOR_KIND: "partner-approval-rules-staff",
  updatePartnerApprovalRuleAsStaff: mockUpdateRule,
}));
mockModule("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: jest.fn(),
  completeTeamMutationIdempotency: jest.fn(),
  settleTeamMutationIdempotencyFailure: jest.fn(),
  teamMutationIdempotencyReplayResponse: jest.fn(),
}));
mockModule("@/lib/team-mutation", () => {
  class TeamMutationFailure extends Error {}
  return {
    beginTeamMutation: mockBeginTeamMutation,
    TeamMutationFailure,
    teamMutationErrorResponse: jest.fn(
      (
        code: string,
        message: string,
        options: { status?: number; correlationId?: string } = {},
      ) =>
        Response.json(
          { ok: false, code, message },
          { status: options.status ?? 422 },
        ),
    ),
    teamMutationExceptionResponse: jest.fn(() =>
      Response.json({ ok: false, code: "internal" }, { status: 500 }),
    ),
    teamMutationResultResponse: jest.fn(),
    teamMutationSuccessResult: jest.fn(),
  };
});

const collectionRoute = await import(
  "../../app/api/admin/partner-management/v1/accounts/[accountId]/approval-rules/route"
);
const itemRoute = await import(
  "../../app/api/admin/partner-management/v1/accounts/[accountId]/approval-rules/[ruleId]/route"
);

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const RULE_ID = "22222222-2222-4222-8222-222222222222";

function request(
  path: string,
  method = "GET",
  headers?: HeadersInit,
): NextRequest {
  return new NextRequest(`https://api.test${path}`, { method, headers });
}

describe("Partner approval-rule administration route boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequirePermission.mockResolvedValue(null);
    mockListOptions.mockResolvedValue({
      services: [],
      locations: [],
      servicesTruncated: false,
      locationsTruncated: false,
    });
  });

  it("denies create before reading route params, JSON, or account state", async () => {
    const denied = Response.json({ ok: false }, { status: 403 });
    mockBeginTeamMutation.mockResolvedValue({ ok: false, response: denied });
    let paramsRead = false;
    const context = Object.defineProperty({}, "params", {
      get() {
        paramsRead = true;
        return Promise.resolve({ accountId: ACCOUNT_ID });
      },
    }) as { params: Promise<{ accountId?: string }> };

    const response = await collectionRoute.POST(
      request(
        `/api/admin/partner-management/v1/accounts/${ACCOUNT_ID}/approval-rules`,
        "POST",
      ),
      context,
    );

    expect(response).toBe(denied);
    expect(mockBeginTeamMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        principalTypes: ["human"],
        requiredPermissions: ["partners.commercial.manage"],
        risk: "financial",
        requiresIdempotency: true,
        maxAuthenticationAgeSeconds: 15 * 60,
      }),
    );
    expect(paramsRead).toBe(false);
    expect(mockReadBoundedJsonRequest).not.toHaveBeenCalled();
    expect(mockCreateRule).not.toHaveBeenCalled();
  });

  it("denies reads before resolving identifiers or account data", async () => {
    const denied = Response.json({ ok: false }, { status: 403 });
    mockRequirePermission.mockResolvedValue(denied);
    let paramsRead = false;
    const context = Object.defineProperty({}, "params", {
      get() {
        paramsRead = true;
        return Promise.resolve({ accountId: ACCOUNT_ID });
      },
    }) as { params: Promise<{ accountId?: string }> };

    const response = await collectionRoute.GET(
      request(
        `/api/admin/partner-management/v1/accounts/${ACCOUNT_ID}/approval-rules`,
      ),
      context,
    );

    expect(response).toBe(denied);
    expect(mockRequirePermission).toHaveBeenCalledWith(
      expect.anything(),
      "partners.commercial.read",
    );
    expect(paramsRead).toBe(false);
    expect(mockListRules).not.toHaveBeenCalled();
    expect(mockListOptions).not.toHaveBeenCalled();
  });

  it("returns the same opaque 404 when an account-scoped list is absent", async () => {
    mockListRules.mockResolvedValue(null);
    const response = await collectionRoute.GET(
      request(
        `/api/admin/partner-management/v1/accounts/${ACCOUNT_ID}/approval-rules`,
      ),
      { params: Promise.resolve({ accountId: ACCOUNT_ID }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        message: "The approval-rule resource was not found.",
      }),
    );
  });

  it("requires exact revision state before reading a PATCH body", async () => {
    mockBeginTeamMutation.mockResolvedValue({
      ok: true,
      mutation: {
        expectedVersion: null,
        correlationId: "approval-rule-route-test",
      },
    });
    const response = await itemRoute.PATCH(
      request(
        `/api/admin/partner-management/v1/accounts/${ACCOUNT_ID}/approval-rules/${RULE_ID}`,
        "PATCH",
        { "Idempotency-Key": "approval-rule-route-test-0001" },
      ),
      { params: Promise.resolve({ accountId: ACCOUNT_ID, ruleId: RULE_ID }) },
    );

    expect(response.status).toBe(422);
    expect(mockReadBoundedJsonRequest).not.toHaveBeenCalled();
    expect(mockUpdateRule).not.toHaveBeenCalled();
  });
});

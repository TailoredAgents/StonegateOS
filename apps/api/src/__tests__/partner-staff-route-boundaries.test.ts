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
const mockPartnerManagementListResponse = jest.fn<
  Promise<Response>,
  [unknown, string, string, boolean]
>();
const mockBeginTeamMutation = jest.fn<Promise<unknown>, [unknown, unknown]>();
const mockReadBoundedJsonRequest = jest.fn<
  Promise<unknown>,
  [unknown, unknown]
>();
const mockClaimTeamMutationIdempotency = jest.fn<
  Promise<unknown>,
  [unknown, unknown, unknown]
>();
const mockTeamMutationIdempotencyReplayResponse = jest.fn<
  Response,
  [unknown]
>();
const mockDecideAddressReview = jest.fn();
const mockInitiateAccountMerge = jest.fn();
const mockCompleteAccountMerge = jest.fn();
const mockDatabase = { transaction: jest.fn() };

mockModule("@/db", () => ({
  getDb: jest.fn(() => mockDatabase),
}));
mockModule("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
mockModule("@/lib/partner-management-route", () => ({
  partnerManagementListResponse: mockPartnerManagementListResponse,
}));
mockModule("@/lib/bounded-json-request", () => ({
  BoundedJsonRequestError: class BoundedJsonRequestError extends Error {
    readonly status = 400;
  },
  readBoundedJsonRequest: mockReadBoundedJsonRequest,
}));
mockModule("@/lib/partner-location-address-review-administration", () => ({
  decidePartnerLocationAddressReview: mockDecideAddressReview,
}));
mockModule("@/lib/partner-account-merge-administration", () => ({
  initiatePartnerAccountMergeCase: mockInitiateAccountMerge,
  completePartnerAccountMergeCase: mockCompleteAccountMerge,
}));
mockModule("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: mockClaimTeamMutationIdempotency,
  completeTeamMutationIdempotency: jest.fn(),
  settleTeamMutationIdempotencyFailure: jest.fn(),
  teamMutationIdempotencyReplayResponse:
    mockTeamMutationIdempotencyReplayResponse,
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
        options: { status?: number; fieldErrors?: unknown } = {},
      ) =>
        Response.json(
          {
            ok: false,
            code,
            message,
            fieldErrors: options.fieldErrors,
          },
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

const accountMergeListRoute = await import(
  "../../app/api/admin/partner-management/v1/account-merges/route"
);
const addressReviewDecisionRoute = await import(
  "../../app/api/admin/partner-management/v1/location-reviews/[reviewId]/decision/route"
);
const accountMergePrepareRoute = await import(
  "../../app/api/admin/partner-management/v1/accounts/[accountId]/merge/route"
);
const accountMergeCompleteRoute = await import(
  "../../app/api/admin/partner-management/v1/account-merges/[caseId]/complete/route"
);

const ACTOR_ID = "10000000-0000-4000-8000-000000000001";
const REVIEW_ID = "20000000-0000-4000-8000-000000000002";
const SOURCE_ACCOUNT_ID = "30000000-0000-4000-8000-000000000003";
const TARGET_ACCOUNT_ID = "40000000-0000-4000-8000-000000000004";
const MERGE_CASE_ID = "50000000-0000-4000-8000-000000000005";

function request(path: string, method: "GET" | "POST"): NextRequest {
  return new NextRequest(`https://api.test${path}`, { method });
}

function allowMutation(expectedVersion: string | null = "2"): void {
  mockBeginTeamMutation.mockResolvedValue({
    ok: true,
    mutation: {
      actor: { id: ACTOR_ID },
      correlationId: "partner-staff-route-test",
      expectedVersion,
      audit: { insertSuccess: jest.fn() },
    },
  });
}

function replayClaim(): void {
  mockClaimTeamMutationIdempotency.mockResolvedValue({
    kind: "replay",
    replay: { responseStatus: 200 },
  });
  mockTeamMutationIdempotencyReplayResponse.mockImplementation(
    () => new Response(null, { status: 200 }),
  );
}

describe("Partner Staff route boundaries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequirePermission.mockResolvedValue(null);
    allowMutation();
    replayClaim();
  });

  it("guards and delegates the account-merge directory as an account read", async () => {
    const denied = Response.json({ ok: false }, { status: 403 });
    mockRequirePermission.mockResolvedValueOnce(denied);
    const deniedRequest = request(
      "/api/admin/partner-management/v1/account-merges",
      "GET",
    );

    await expect(accountMergeListRoute.GET(deniedRequest)).resolves.toBe(
      denied,
    );
    expect(mockPartnerManagementListResponse).not.toHaveBeenCalled();

    const listed = Response.json({ ok: true, resource: "account-merges" });
    mockPartnerManagementListResponse.mockResolvedValueOnce(listed);
    const allowedRequest = request(
      "/api/admin/partner-management/v1/account-merges",
      "GET",
    );

    await expect(accountMergeListRoute.GET(allowedRequest)).resolves.toBe(
      listed,
    );
    expect(mockRequirePermission).toHaveBeenLastCalledWith(
      allowedRequest,
      "partners.accounts.read",
    );
    expect(mockPartnerManagementListResponse).toHaveBeenCalledWith(
      allowedRequest,
      "account-merges",
      "partners.accounts.read",
      true,
    );
  });

  it("denies an address-review decision before params or body parsing", async () => {
    const denied = Response.json({ ok: false }, { status: 403 });
    mockBeginTeamMutation.mockResolvedValueOnce({
      ok: false,
      response: denied,
    });
    let paramsRead = false;
    const context = Object.defineProperty({}, "params", {
      get() {
        paramsRead = true;
        return Promise.resolve({ reviewId: REVIEW_ID });
      },
    }) as { params: Promise<{ reviewId?: string }> };

    const response = await addressReviewDecisionRoute.POST(
      request(
        `/api/admin/partner-management/v1/location-reviews/${REVIEW_ID}/decision`,
        "POST",
      ),
      context,
    );

    expect(response).toBe(denied);
    expect(mockBeginTeamMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        principalTypes: ["human"],
        requiredPermissions: ["partners.accounts.manage"],
        risk: "destructive",
        requiresIdempotency: true,
        maxAuthenticationAgeSeconds: 15 * 60,
      }),
    );
    expect(paramsRead).toBe(false);
    expect(mockReadBoundedJsonRequest).not.toHaveBeenCalled();
  });

  it("requires an address-review revision before reading the request body", async () => {
    allowMutation(null);

    const response = await addressReviewDecisionRoute.POST(
      request(
        `/api/admin/partner-management/v1/location-reviews/${REVIEW_ID}/decision`,
        "POST",
      ),
      { params: Promise.resolve({ reviewId: REVIEW_ID }) },
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "invalid",
        fieldErrors: { version: "Refresh Address reviews." },
      }),
    );
    expect(mockReadBoundedJsonRequest).not.toHaveBeenCalled();
    expect(mockClaimTeamMutationIdempotency).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "unknown keys",
      body: {
        decision: "dismissed",
        note: "Staff evidence supports dismissal.",
        confirmation: "DISMISS ADDRESS REVIEW",
        rewriteTenant: true,
      },
    },
    {
      label: "a mismatched typed confirmation",
      body: {
        decision: "correction_required",
        note: "The unit must be corrected by the Partner.",
        confirmation: "VERIFY LOCATION",
      },
    },
    {
      label: "missing verification evidence",
      body: {
        decision: "verified",
        note: "Staff verified the location from source evidence.",
        confirmation: "VERIFY LOCATION",
      },
    },
    {
      label: "coordinates on a non-verification decision",
      body: {
        decision: "dismissed",
        note: "Staff dismissed a stale duplicate review.",
        confirmation: "DISMISS ADDRESS REVIEW",
        latitude: 33.749,
        longitude: -84.388,
        serviceAreaEligible: true,
      },
    },
  ])("rejects address decisions with $label", async ({ body }) => {
    mockReadBoundedJsonRequest.mockResolvedValueOnce(body);

    const response = await addressReviewDecisionRoute.POST(
      request(
        `/api/admin/partner-management/v1/location-reviews/${REVIEW_ID}/decision`,
        "POST",
      ),
      { params: Promise.resolve({ reviewId: REVIEW_ID }) },
    );

    expect(response.status).toBe(422);
    expect(mockClaimTeamMutationIdempotency).not.toHaveBeenCalled();
    expect(mockDecideAddressReview).not.toHaveBeenCalled();
  });

  it("claims a verified address decision idempotently with only validated fields", async () => {
    const body = {
      decision: "verified",
      note: "Staff verified the location from contract evidence.",
      confirmation: "VERIFY LOCATION",
      latitude: 33.749,
      longitude: -84.388,
      serviceAreaEligible: true,
    } as const;
    mockReadBoundedJsonRequest.mockResolvedValueOnce(body);

    const response = await addressReviewDecisionRoute.POST(
      request(
        `/api/admin/partner-management/v1/location-reviews/${REVIEW_ID}/decision`,
        "POST",
      ),
      { params: Promise.resolve({ reviewId: REVIEW_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mockClaimTeamMutationIdempotency).toHaveBeenCalledWith(
      mockDatabase,
      expect.objectContaining({ expectedVersion: "2" }),
      {
        route:
          "POST /api/admin/partner-management/v1/location-reviews/:reviewId/decision",
        entityType: "partner_location_address_review",
        entityId: REVIEW_ID,
        payload: body,
      },
    );
    expect(mockDecideAddressReview).not.toHaveBeenCalled();
  });

  const mergeRoutes = [
    {
      label: "prepare",
      path: `/api/admin/partner-management/v1/accounts/${SOURCE_ACCOUNT_ID}/merge`,
      param: "accountId",
      id: SOURCE_ACCOUNT_ID,
      post: accountMergePrepareRoute.POST as (
        request: NextRequest,
        context: { params: Promise<Record<string, string>> },
      ) => Promise<Response>,
      body: {
        targetPartnerAccountId: TARGET_ACCOUNT_ID,
        reason: "Duplicate company confirmed from contract evidence.",
        confirmation: "PREPARE PARTNER ACCOUNT MERGE",
      },
      claim: {
        route:
          "POST /api/admin/partner-management/v1/accounts/:accountId/merge",
        entityType: "partner_account",
        entityId: SOURCE_ACCOUNT_ID,
      },
    },
    {
      label: "complete",
      path: `/api/admin/partner-management/v1/account-merges/${MERGE_CASE_ID}/complete`,
      param: "caseId",
      id: MERGE_CASE_ID,
      post: accountMergeCompleteRoute.POST as (
        request: NextRequest,
        context: { params: Promise<Record<string, string>> },
      ) => Promise<Response>,
      body: {
        resolutionNote:
          "Live reconciliation confirms the source has no business bindings.",
        confirmation: "COMPLETE PARTNER ACCOUNT MERGE",
      },
      claim: {
        route:
          "POST /api/admin/partner-management/v1/account-merges/:caseId/complete",
        entityType: "partner_account_merge_case",
        entityId: MERGE_CASE_ID,
      },
    },
  ] as const;

  it.each(mergeRoutes)(
    "guards the account merge $label route before params and input",
    async ({ path, param, id, post }) => {
      const denied = Response.json({ ok: false }, { status: 403 });
      mockBeginTeamMutation.mockResolvedValueOnce({
        ok: false,
        response: denied,
      });
      let paramsRead = false;
      const context = Object.defineProperty({}, "params", {
        get() {
          paramsRead = true;
          return Promise.resolve({ [param]: id });
        },
      }) as { params: Promise<Record<string, string>> };

      await expect(post(request(path, "POST"), context)).resolves.toBe(denied);
      expect(mockBeginTeamMutation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          principalTypes: ["human"],
          requiredPermissions: ["partners.accounts.merge"],
          risk: "destructive",
          requiresIdempotency: true,
          maxAuthenticationAgeSeconds: 15 * 60,
        }),
      );
      expect(paramsRead).toBe(false);
      expect(mockReadBoundedJsonRequest).not.toHaveBeenCalled();
    },
  );

  it.each(mergeRoutes)(
    "requires the account merge $label revision before body parsing",
    async ({ path, param, id, post }) => {
      allowMutation(null);

      const response = await post(request(path, "POST"), {
        params: Promise.resolve({ [param]: id }),
      });

      expect(response.status).toBe(422);
      expect(mockReadBoundedJsonRequest).not.toHaveBeenCalled();
      expect(mockClaimTeamMutationIdempotency).not.toHaveBeenCalled();
    },
  );

  it.each(mergeRoutes)(
    "strictly validates and idempotently claims the account merge $label request",
    async ({ path, param, id, post, body, claim }) => {
      mockReadBoundedJsonRequest.mockResolvedValueOnce({
        ...body,
        automaticTenantRewrite: true,
      });
      const invalid = await post(request(path, "POST"), {
        params: Promise.resolve({ [param]: id }),
      });
      expect(invalid.status).toBe(422);
      expect(mockClaimTeamMutationIdempotency).not.toHaveBeenCalled();

      mockReadBoundedJsonRequest.mockResolvedValueOnce(body);
      const replay = await post(request(path, "POST"), {
        params: Promise.resolve({ [param]: id }),
      });

      expect(replay.status).toBe(200);
      expect(mockClaimTeamMutationIdempotency).toHaveBeenCalledWith(
        mockDatabase,
        expect.objectContaining({ expectedVersion: "2" }),
        { ...claim, payload: body },
      );
      expect(mockInitiateAccountMerge).not.toHaveBeenCalled();
      expect(mockCompleteAccountMerge).not.toHaveBeenCalled();
    },
  );
});

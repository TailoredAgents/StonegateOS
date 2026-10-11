import type { NextRequest } from "next/server";
import { jest } from "@jest/globals";

const mockBeginTeamMutation = jest.fn();
jest.unstable_mockModule("@/lib/team-mutation", () => ({
  assertTeamMutationExpectedVersion: jest.fn(),
  beginTeamMutation: mockBeginTeamMutation,
  createTeamMutationDeniedAuditWriter: jest.fn(),
  isAllowedTeamMutationOrigin: jest.fn(),
  isTeamAuthenticationRecent: jest.fn(),
  recordTeamMutationFailure: jest.fn(),
  strengthenTeamMutationPolicy: jest.fn(),
  TeamMutationFailure: class TeamMutationFailure extends Error {},
  teamMutationErrorResponse: jest.fn(),
  teamMutationExceptionResponse: jest.fn(),
  teamMutationExceptionResult: jest.fn(),
  teamMutationResultResponse: jest.fn(),
  teamMutationSuccessResponse: jest.fn(),
  teamMutationSuccessResult: jest.fn(),
}));

const { POST: recordManualPayment } = await import(
  "../../app/api/appointments/[id]/manual-payments/route"
);
const { POST: launchSquareAttempt } = await import(
  "../../app/api/appointments/[id]/payment-attempts/route"
);

function poisonedRequest(): NextRequest {
  return new Proxy({} as NextRequest, {
    get(_target, property) {
      throw new Error(`request_was_read_before_auth:${String(property)}`);
    },
  });
}

function poisonedContext(): { params: Promise<{ id: string }> } {
  return new Proxy({} as { params: Promise<{ id: string }> }, {
    get(_target, property) {
      throw new Error(`params_were_read_before_auth:${String(property)}`);
    },
  });
}

describe("appointment payment authorization runtime boundary", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["Square", launchSquareAttempt],
    ["manual", recordManualPayment],
  ])(
    "returns the verified %s denial without reading request, params, config, or DB",
    async (_name, handler) => {
      const denial = Response.json(
        {
          ok: false,
          code: "unauthorized",
          message: "Session required.",
          retryable: false,
        },
        { status: 401 },
      );
      mockBeginTeamMutation.mockResolvedValue({
        ok: false,
        response: denial,
      } as never);

      const response = await handler(poisonedRequest(), poisonedContext());

      expect(mockBeginTeamMutation).toHaveBeenCalledTimes(1);
      expect(response).toBe(denial);
      expect(response.status).toBe(401);
    },
  );
});

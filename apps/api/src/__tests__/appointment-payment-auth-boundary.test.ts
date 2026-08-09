import type { NextRequest } from "next/server";
import { POST as recordManualPayment } from "../../app/api/appointments/[id]/manual-payments/route";
import { POST as launchSquareAttempt } from "../../app/api/appointments/[id]/payment-attempts/route";
import * as teamMutation from "@/lib/team-mutation";

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
    jest.restoreAllMocks();
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
      const boundary = jest
        .spyOn(teamMutation, "beginTeamMutation")
        .mockResolvedValue({ ok: false, response: denial } as never);

      const response = await handler(poisonedRequest(), poisonedContext());

      expect(boundary).toHaveBeenCalledTimes(1);
      expect(response).toBe(denial);
      expect(response.status).toBe(401);
    },
  );
});

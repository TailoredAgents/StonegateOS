import type { ActionPolicy, MutationErrorCode } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import type { VerifiedRequestActor } from "@/lib/verified-actor-context";

const mockRequirePermission = jest.fn<
  Promise<Response | null>,
  [NextRequest, unknown, unknown?]
>();
const mockGetTeamOperationKillSwitchForRisk = jest.fn<
  | "external_sends"
  | "financial_mutations"
  | "destructive_mutations"
  | "advertising_changes"
  | "publishing"
  | "outbox_dispatch"
  | null,
  [ActionPolicy["risk"]]
>();
const mockGetVerifiedRequestActor = jest.fn<
  VerifiedRequestActor | null,
  [NextRequest]
>();

jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));

jest.mock("@/lib/team-operation-kill-switch", () => ({
  getTeamOperationKillSwitchForRisk: mockGetTeamOperationKillSwitchForRisk,
}));

jest.mock("@/lib/verified-actor-context", () => ({
  getVerifiedRequestActor: mockGetVerifiedRequestActor,
}));

import {
  assertTeamMutationExpectedVersion,
  beginTeamMutation,
  createTeamMutationDeniedAuditWriter,
  recordTeamMutationFailure,
  strengthenTeamMutationPolicy,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

const HUMAN_DESTRUCTIVE_POLICY: ActionPolicy = {
  principalTypes: ["human"],
  requiredPermissions: ["quotes.delete"],
  risk: "destructive",
  requiresIdempotency: true,
  auditAction: "instant_quote.deleted",
};

function humanActor() {
  return {
    type: "human" as const,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    role: "owner",
    label: "Verified Owner",
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    authMethod: "team_session" as const,
    assuranceLevel: "aal2" as const,
    mfaVerifiedAt: new Date().toISOString(),
  };
}

function teamRequest(
  headers: Record<string, string> = {},
): NextRequest & { json: jest.Mock } {
  const json = jest.fn();
  return {
    headers: new Headers({
      host: "api.example.test",
      origin: "https://api.example.test",
      "idempotency-key": "instant-quote-delete:stable-key",
      ...headers,
    }),
    nextUrl: new URL("https://api.example.test/api/admin/example"),
    json,
  } as unknown as NextRequest & { json: jest.Mock };
}

async function responseBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("shared /team mutation boundary", () => {
  beforeEach(() => {
    mockRequirePermission.mockReset().mockResolvedValue(null);
    mockGetTeamOperationKillSwitchForRisk.mockReset().mockReturnValue(null);
    mockGetVerifiedRequestActor.mockReset().mockReturnValue(humanActor());
  });

  it("authenticates before touching actor context or parsing input", async () => {
    const request = teamRequest({ origin: "https://attacker.example" });
    mockRequirePermission.mockResolvedValue(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );

    const result = await beginTeamMutation(request, HUMAN_DESTRUCTIVE_POLICY);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(await responseBody(result.response)).toEqual({
      ok: false,
      code: "unauthorized",
      message: "Your team session is missing, expired, or no longer active.",
      retryable: false,
    });
    expect(mockRequirePermission).toHaveBeenCalledWith(
      request,
      ["quotes.delete"],
      { mode: "all" },
    );
    expect(mockGetVerifiedRequestActor).not.toHaveBeenCalled();
    expect(request.json).not.toHaveBeenCalled();
  });

  it("converts an authorization backend failure into a retryable typed 500", async () => {
    const request = teamRequest();
    mockRequirePermission.mockRejectedValue(new Error("database unavailable"));

    const result = await beginTeamMutation(request, HUMAN_DESTRUCTIVE_POLICY);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(500);
    expect(await responseBody(result.response)).toEqual({
      ok: false,
      code: "internal",
      message: "Authorization could not be verified. Try again.",
      retryable: true,
    });
    expect(mockGetVerifiedRequestActor).not.toHaveBeenCalled();
    expect(request.json).not.toHaveBeenCalled();
  });

  it("preserves rate-limit retry guidance from the permission gate", async () => {
    mockRequirePermission.mockResolvedValue(
      Response.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": "30" } },
      ),
    );

    const result = await beginTeamMutation(
      teamRequest(),
      HUMAN_DESTRUCTIVE_POLICY,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("retry-after")).toBe("30");
    expect(await responseBody(result.response)).toEqual(
      expect.objectContaining({
        ok: false,
        code: "rate_limited",
        retryable: true,
      }),
    );
  });

  it("maps an active server kill switch to a non-retryable typed denial", async () => {
    mockRequirePermission.mockResolvedValue(
      Response.json({ error: "operation_disabled" }, { status: 503 }),
    );

    const result = await beginTeamMutation(
      teamRequest(),
      HUMAN_DESTRUCTIVE_POLICY,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    expect(await responseBody(result.response)).toEqual({
      ok: false,
      code: "forbidden",
      message: "This operation is temporarily disabled by a safety control.",
      retryable: false,
    });
  });

  it.each([
    ["external", "external_sends"],
    ["financial", "financial_mutations"],
    ["destructive", "destructive_mutations"],
  ] as const)(
    "enforces the %s risk kill switch even when its permission is not mapped",
    async (risk, category) => {
      mockGetTeamOperationKillSwitchForRisk.mockImplementation((candidate) =>
        candidate === risk ? category : null,
      );
      const request = teamRequest();
      const result = await beginTeamMutation(request, {
        ...HUMAN_DESTRUCTIVE_POLICY,
        requiredPermissions:
          risk === "external"
            ? ["partners.invite"]
            : risk === "financial"
              ? ["partners.rates"]
              : ["quotes.delete"],
        risk,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.response.status).toBe(403);
      expect(await responseBody(result.response)).toEqual({
        ok: false,
        code: "forbidden",
        message: "This operation is temporarily disabled by a safety control.",
        retryable: false,
      });
      expect(mockRequirePermission).toHaveBeenCalledTimes(1);
      expect(mockGetTeamOperationKillSwitchForRisk).toHaveBeenCalledWith(risk);
      expect(request.json).not.toHaveBeenCalled();
    },
  );

  it("can ignore one permission-derived kill switch while retaining the declared risk boundary", async () => {
    const request = teamRequest();
    const result = await beginTeamMutation(
      request,
      {
        ...HUMAN_DESTRUCTIVE_POLICY,
        requiredPermissions: ["partners.invite"],
      },
      { ignoredPermissionKillSwitches: ["external_sends"] },
    );

    expect(result.ok).toBe(true);
    expect(mockRequirePermission).toHaveBeenCalledWith(
      request,
      ["partners.invite"],
      {
        mode: "all",
        ignoredKillSwitches: ["external_sends"],
      },
    );
    expect(mockGetTeamOperationKillSwitchForRisk).toHaveBeenCalledWith(
      "destructive",
    );
  });

  it("fails closed when a server action policy has no permissions", async () => {
    const result = await beginTeamMutation(teamRequest(), {
      ...HUMAN_DESTRUCTIVE_POLICY,
      requiredPermissions: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(500);
    expect(mockRequirePermission).not.toHaveBeenCalled();
  });

  it("rejects missing, malformed, cross-host, and cross-protocol browser origins", async () => {
    for (const headers of [
      { origin: "" },
      { origin: "null" },
      { origin: "not a URL" },
      { origin: "https://attacker.example" },
      {
        origin: "http://api.example.test",
        "x-forwarded-proto": "https",
      },
    ]) {
      const result = await beginTeamMutation(
        teamRequest(headers),
        HUMAN_DESTRUCTIVE_POLICY,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
        expect(await responseBody(result.response)).toEqual(
          expect.objectContaining({ ok: false, code: "forbidden" }),
        );
      }
    }
  });

  it("lets an explicitly authorized non-browser service omit Origin", async () => {
    mockGetVerifiedRequestActor.mockReturnValue({
      type: "worker",
      id: null,
      role: null,
      label: "outbox-dispatcher",
      sessionId: null,
      authMethod: "service",
    });
    const request = teamRequest({ origin: "" });
    const policy: ActionPolicy = {
      principalTypes: ["service"],
      requiredPermissions: ["outbox.dispatch"],
      risk: "external",
      requiresIdempotency: true,
      auditAction: "outbox.dispatched",
    };

    const result = await beginTeamMutation(request, policy);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mutation.principalType).toBe("service");
  });

  it("does not let a service principal use a human-only action", async () => {
    mockGetVerifiedRequestActor.mockReturnValue({
      type: "worker",
      label: "outbox-dispatcher",
      authMethod: "service",
    });

    const result = await beginTeamMutation(
      teamRequest({ origin: "" }),
      HUMAN_DESTRUCTIVE_POLICY,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("requires and normalizes a stable key for every high-risk action", async () => {
    const missing = await beginTeamMutation(
      teamRequest({ "idempotency-key": "" }),
      HUMAN_DESTRUCTIVE_POLICY,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.response.status).toBe(422);
      expect(await responseBody(missing.response)).toEqual(
        expect.objectContaining({ code: "invalid", retryable: false }),
      );
    }

    const malformed = await beginTeamMutation(
      teamRequest({ "idempotency-key": "short" }),
      HUMAN_DESTRUCTIVE_POLICY,
    );
    expect(malformed.ok).toBe(false);

    const valid = await beginTeamMutation(
      teamRequest({
        "idempotency-key": "  instant-quote-delete:stable-key  ",
      }),
      { ...HUMAN_DESTRUCTIVE_POLICY, requiresIdempotency: false },
    );
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.mutation.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(valid.mutation)).not.toContain(
        "instant-quote-delete:stable-key",
      );
    }
  });

  it("normalizes If-Match and returns a typed conflict for stale state", async () => {
    const result = await beginTeamMutation(
      teamRequest({ "if-match": 'W/"2026-08-08T12:00:00.000Z"' }),
      HUMAN_DESTRUCTIVE_POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mutation.expectedVersion).toBe("2026-08-08T12:00:00.000Z");

    expect(() =>
      assertTeamMutationExpectedVersion(
        result.mutation,
        new Date("2026-08-08T12:00:01.000Z"),
      ),
    ).toThrow(TeamMutationFailure);
    let conflict: Response;
    try {
      assertTeamMutationExpectedVersion(
        result.mutation,
        "2026-08-08T12:00:01.000Z",
      );
      throw new Error("expected version assertion to fail");
    } catch (error) {
      conflict = teamMutationExceptionResponse(error, result.mutation);
    }
    expect(conflict.status).toBe(409);
    expect(await responseBody(conflict)).toEqual(
      expect.objectContaining({ code: "conflict", retryable: false }),
    );
  });

  it("rejects conflicting If-Match and expected-version headers", async () => {
    const result = await beginTeamMutation(
      teamRequest({
        "if-match": '"version-one"',
        "x-expected-version": "version-two",
      }),
      HUMAN_DESTRUCTIVE_POLICY,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(422);
  });

  it("writes a verified success event through the exact caller transaction", async () => {
    const result = await beginTeamMutation(
      teamRequest({ "x-correlation-id": "request-correlation-123" }),
      HUMAN_DESTRUCTIVE_POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const values = jest
      .fn<Promise<void>, [Record<string, unknown>]>()
      .mockResolvedValue(undefined);
    const insert = jest.fn<{ values: typeof values }, [unknown]>(() => ({
      values,
    }));
    const tx = { insert } as unknown as TeamMutationTransaction;
    const committedAt = new Date("2026-08-08T15:30:00.000Z");
    const audit = await result.mutation.audit.insertSuccess(tx, {
      entityType: "instant_quote",
      entityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      before: { version: "v1" },
      after: { deleted: true },
      committedAt,
    });

    expect(insert).toHaveBeenCalledTimes(1);
    const inserted = values.mock.calls[0]?.[0];
    expect(inserted).toMatchObject({
      id: audit.auditEventId,
      actorType: "human",
      actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actorRole: "owner",
      actorLabel: "Verified Owner",
      action: "instant_quote.deleted",
      entityType: "instant_quote",
      entityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      createdAt: committedAt,
    });
    expect(inserted?.["meta"]).toMatchObject({
      eventId: audit.auditEventId,
      correlationId: "request-correlation-123",
      outcome: "succeeded",
      before: { version: "v1" },
      after: { deleted: true },
    });
    const insertedMeta = inserted?.["meta"];
    if (
      typeof insertedMeta !== "object" ||
      insertedMeta === null ||
      !("idempotencyKeyHash" in insertedMeta) ||
      typeof insertedMeta.idempotencyKeyHash !== "string"
    ) {
      throw new Error("Expected a hashed idempotency key in audit metadata");
    }
    expect(insertedMeta.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(insertedMeta)).not.toContain(
      "instant-quote-delete:stable-key",
    );
    expect(audit.committedAt).toBe("2026-08-08T15:30:00.000Z");
  });

  it("records the exact data-dependent payment policy for success and denial", async () => {
    const result = await beginTeamMutation(teamRequest(), {
      principalTypes: ["human"],
      requiredPermissions: ["payments.collect"],
      risk: "financial",
      requiresIdempotency: true,
      auditAction: "appointment.final_total.updated",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const values = jest
      .fn<Promise<void>, [Record<string, unknown>]>()
      .mockResolvedValue(undefined);
    const tx = {
      insert: () => ({ values }),
    } as unknown as TeamMutationTransaction;
    const strengthened = strengthenTeamMutationPolicy(result.mutation, [
      "payments.manage",
      "payments.manage",
    ]);

    expect(strengthened.operationId).toBe(result.mutation.operationId);
    expect(strengthened.correlationId).toBe(result.mutation.correlationId);
    expect(strengthened.idempotencyKeyHash).toBe(
      result.mutation.idempotencyKeyHash,
    );
    expect(strengthened.policy.requiredPermissions).toEqual([
      "payments.collect",
      "payments.manage",
    ]);
    await strengthened.audit.insertSuccess(tx, {
      entityType: "appointment",
      entityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(values.mock.calls[0]?.[0]).toMatchObject({
      requiredPermissions: ["payments.collect", "payments.manage"],
      outcome: "succeeded",
      action: "appointment.final_total.updated",
    });
    expect(values.mock.calls[0]?.[0]?.["meta"]).toMatchObject({
      requiredPermissions: ["payments.collect", "payments.manage"],
      outcome: "succeeded",
      operationId: result.mutation.operationId,
      correlationId: result.mutation.correlationId,
    });

    const deniedWriter = createTeamMutationDeniedAuditWriter(result.mutation, [
      "payments.manage",
    ]);
    await deniedWriter(tx, {
      outcome: "denied",
      entityType: "appointment",
      entityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      code: "forbidden",
    });
    expect(values.mock.calls[1]?.[0]).toMatchObject({
      requiredPermissions: ["payments.collect", "payments.manage"],
      outcome: "denied",
      action: "appointment.final_total.updated",
    });
    expect(values.mock.calls[1]?.[0]?.["meta"]).toMatchObject({
      requiredPermissions: ["payments.collect", "payments.manage"],
      outcome: "denied",
      operationId: result.mutation.operationId,
      correlationId: result.mutation.correlationId,
    });
  });

  it("propagates an audit insertion failure so the caller transaction rolls back", async () => {
    const result = await beginTeamMutation(
      teamRequest(),
      HUMAN_DESTRUCTIVE_POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const auditFailure = new Error("audit storage unavailable");
    const tx = {
      insert: () => ({ values: () => Promise.reject(auditFailure) }),
    } as unknown as TeamMutationTransaction;

    await expect(
      result.mutation.audit.insertSuccess(tx, {
        entityType: "instant_quote",
      }),
    ).rejects.toBe(auditFailure);
  });

  it("keeps a failed action failed when its best-effort failure audit cannot be written", async () => {
    const result = await beginTeamMutation(
      teamRequest(),
      HUMAN_DESTRUCTIVE_POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const writer = jest.fn(() =>
      Promise.reject(new Error("audit storage unavailable")),
    );
    const recorded = await recordTeamMutationFailure(
      result.mutation,
      {
        entityType: "quote",
        entityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        code: "conflict",
        metadata: { reason: "stale_version" },
      },
      writer,
    );

    expect(recorded).toEqual({ recorded: false, auditEventId: null });
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer.mock.calls[0]?.[0]).toMatchObject({
      outcome: "failed",
      action: "instant_quote.deleted",
      entityType: "quote",
      entityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(JSON.stringify(writer.mock.calls[0]?.[0])).not.toContain(
      "instant-quote-delete:stable-key",
    );
  });

  it.each<[MutationErrorCode, number]>([
    ["unauthorized", 401],
    ["forbidden", 403],
    ["conflict", 409],
    ["invalid", 422],
    ["rate_limited", 429],
    ["provider_failed", 502],
    ["timeout", 504],
    ["internal", 500],
  ])("maps %s to a truthful typed HTTP %d response", async (code, status) => {
    const response = teamMutationErrorResponse(code, `test ${code}`, {
      retryable: code === "rate_limited" || code === "timeout",
    });

    expect(response.status).toBe(status);
    expect(await responseBody(response)).toEqual({
      ok: false,
      code,
      message: `test ${code}`,
      retryable: code === "rate_limited" || code === "timeout",
    });
  });
});

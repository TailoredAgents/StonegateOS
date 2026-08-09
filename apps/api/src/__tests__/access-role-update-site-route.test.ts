import type { NextRequest } from "next/server";

const mockRequireTeamPrincipal = jest.fn();
const mockCallAdminApiAs = jest.fn<
  Promise<Response>,
  [Record<string, unknown>, string, RequestInit & { timeoutMs?: number }]
>();

jest.mock("@/app/api/team/auth", () => ({
  requireTeamPrincipal: mockRequireTeamPrincipal,
}));

jest.mock("@/app/team/lib/api", () => ({ callAdminApiAs: mockCallAdminApiAs }));

import { POST } from "../../../site/src/app/api/team/access/roles/[roleId]/route";

const ROLE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const AUDIT_EVENT_ID = "44444444-4444-4444-8444-444444444444";
const EXPECTED_UPDATED_AT = "2026-08-08T12:30:00.000Z";
const UPDATED_AT = "2026-08-08T13:00:00.000Z";
const CORRELATION_ID = "access-role-update-correlation-123";
const IDEMPOTENCY_KEY = `access-role-update:${ROLE_ID}:${EXPECTED_UPDATED_AT}`;

function roleRequest(
  overrides: Record<string, string | readonly string[]> = {},
): NextRequest {
  const url = new URL(
    `https://site.example.test/api/team/access/roles/${ROLE_ID}`,
  );
  const values: Record<string, string | readonly string[]> = {
    expectedUpdatedAt: EXPECTED_UPDATED_AT,
    idempotencyKey: IDEMPOTENCY_KEY,
    name: "Office east",
    permissions: ["contacts.read"],
    slug: "office_east",
    ...overrides,
  };
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") {
      form.append(key, value);
    } else {
      for (const entry of value) form.append(key, entry);
    }
  }
  const request = new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      origin: url.origin,
      "sec-fetch-site": "same-origin",
    },
    body: form.toString(),
  });
  Object.defineProperty(request, "nextUrl", { value: url });
  return request as unknown as NextRequest;
}

function successResponse(): Response {
  return Response.json(
    {
      ok: true,
      data: {
        role: {
          id: ROLE_ID,
          name: "Office east",
          slug: "office_east",
          permissions: ["contacts.read"],
          createdAt: "2026-08-08T12:00:00.000Z",
          updatedAt: UPDATED_AT,
        },
        assignedMemberCount: 2,
        revokedSessionCount: 3,
      },
      receipt: {
        operationId: OPERATION_ID,
        correlationId: CORRELATION_ID,
        actorId: ACTOR_ID,
        committedAt: UPDATED_AT,
        auditEventId: AUDIT_EVENT_ID,
        entityType: "team_role",
        entityId: ROLE_ID,
        version: UPDATED_AT,
      },
    },
    { headers: { "x-correlation-id": CORRELATION_ID } },
  );
}

function cookieHeader(response: Response): string {
  return response.headers.get("set-cookie") ?? "";
}

describe("Site Access role update boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects a cross-origin form before authentication, body parsing, or upstream access", async () => {
    const request = roleRequest();
    request.headers.set("origin", "https://attacker.example.test");
    request.headers.set("sec-fetch-site", "cross-site");

    const response = await POST(request, {
      params: Promise.resolve({ roleId: ROLE_ID }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "forbidden",
      message:
        "The role update origin could not be verified. Nothing was changed.",
      retryable: false,
    });
    expect(request.bodyUsed).toBe(false);
    expect(mockRequireTeamPrincipal).not.toHaveBeenCalled();
    expect(mockCallAdminApiAs).not.toHaveBeenCalled();
  });

  it("denies missing access.manage before params, body parsing, or upstream access", async () => {
    mockRequireTeamPrincipal.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "forbidden" }, { status: 403 }),
    });
    const request = roleRequest();
    const context = {} as { params: Promise<{ roleId: string }> };
    Object.defineProperty(context, "params", {
      get: () => {
        throw new Error("params_must_not_be_read_before_authorization");
      },
    });

    const response = await POST(request, context);

    expect(response.status).toBe(403);
    expect(mockRequireTeamPrincipal).toHaveBeenCalledWith(request, {
      permissions: "access.manage",
      redirectTo: new URL("/team/admin/access#roles", request.url),
    });
    expect(request.bodyUsed).toBe(false);
    expect(mockCallAdminApiAs).not.toHaveBeenCalled();
  });

  it("replays the exact bounded request after an ambiguous acknowledgement and trusts only a bound receipt", async () => {
    mockRequireTeamPrincipal.mockResolvedValue({
      ok: true,
      principal: {
        memberId: ACTOR_ID,
        sessionId: "session-1",
        sessionToken: "opaque-session",
        roleSlug: "owner",
        permissions: ["access.manage"],
        name: "Owner",
      },
      role: "owner",
    });
    mockCallAdminApiAs
      .mockResolvedValueOnce(
        Response.json(
          { ok: true, committed: true, receipt: "incomplete" },
          { headers: { "x-correlation-id": CORRELATION_ID } },
        ),
      )
      .mockResolvedValueOnce(successResponse());

    const response = await POST(roleRequest(), {
      params: Promise.resolve({ roleId: ROLE_ID }),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://site.example.test/team/admin/access#roles",
    );
    expect(cookieHeader(response)).toContain("myst-flash=");
    expect(cookieHeader(response)).toContain("3%20active%20sessions");
    expect(mockCallAdminApiAs).toHaveBeenCalledTimes(2);
    const [firstPrincipal, firstPath, firstInit] =
      mockCallAdminApiAs.mock.calls[0]!;
    const [replayedPrincipal, replayedPath, replayedInit] =
      mockCallAdminApiAs.mock.calls[1]!;
    expect(replayedPrincipal).toBe(firstPrincipal);
    expect(firstPath).toBe(`/api/admin/roles/${ROLE_ID}`);
    expect(replayedPath).toBe(firstPath);
    expect(replayedInit.body).toBe(firstInit.body);
    expect(replayedInit.headers).toBe(firstInit.headers);
    expect(new Headers(firstInit.headers).get("idempotency-key")).toBe(
      IDEMPOTENCY_KEY,
    );
    expect(new Headers(firstInit.headers).get("if-match")).toBe(
      EXPECTED_UPDATED_AT,
    );
    if (typeof firstInit.body !== "string") {
      throw new Error("expected one stable JSON request body");
    }
    const parsedBody = JSON.parse(firstInit.body) as unknown;
    expect(parsedBody).toEqual({
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
      name: "Office east",
      permissions: ["contacts.read"],
      slug: "office_east",
    });
  });

  it("surfaces a canonical conflict without retrying or displaying false success", async () => {
    mockRequireTeamPrincipal.mockResolvedValue({
      ok: true,
      principal: {
        memberId: ACTOR_ID,
        sessionToken: "opaque-session",
        roleSlug: "owner",
        permissions: ["access.manage"],
        name: "Owner",
      },
      role: "owner",
    });
    mockCallAdminApiAs.mockResolvedValue(
      Response.json(
        {
          ok: false,
          code: "conflict",
          message: "The role changed after it was loaded.",
          retryable: false,
          fieldErrors: { version: "Refresh the role." },
        },
        { status: 409 },
      ),
    );

    const response = await POST(roleRequest(), {
      params: Promise.resolve({ roleId: ROLE_ID }),
    });

    expect(response.status).toBe(303);
    expect(mockCallAdminApiAs).toHaveBeenCalledTimes(1);
    expect(cookieHeader(response)).toContain("myst-flash-error=");
    expect(cookieHeader(response)).not.toMatch(/(?:^|,\s*)myst-flash=/u);
  });
});

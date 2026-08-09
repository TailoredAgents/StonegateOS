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

import { POST } from "../../../site/src/app/api/team/pipeline/presets/route";
import { DELETE } from "../../../site/src/app/api/team/pipeline/presets/[presetId]/route";

const PRESET_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const AUDIT_EVENT_ID = "44444444-4444-4444-8444-444444444444";
const CORRELATION_ID = "pipeline-preset-site-correlation-123456";
const COMMITTED_AT = "2026-08-08T12:05:00.000Z";
const IDEMPOTENCY_KEY = "pipeline-preset-operation:1234567890";

function authenticatedPrincipal() {
  return {
    ok: true,
    principal: {
      memberId: ACTOR_ID,
      sessionId: "session-1",
      sessionToken: "opaque-session",
      roleSlug: "sales",
      permissions: ["pipeline.read"],
      name: "Salesperson",
    },
    role: "sales",
  };
}

function presetRequest(
  method: "POST" | "DELETE",
  body: unknown,
  options: { crossOrigin?: boolean; ifMatch?: string } = {},
): NextRequest {
  const url = new URL(
    method === "POST"
      ? "https://site.example.test/api/team/pipeline/presets"
      : `https://site.example.test/api/team/pipeline/presets/${PRESET_ID}`,
  );
  const request = new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      origin: options.crossOrigin
        ? "https://attacker.example.test"
        : url.origin,
      "sec-fetch-site": options.crossOrigin ? "cross-site" : "same-origin",
      "idempotency-key": IDEMPOTENCY_KEY,
      ...(options.ifMatch ? { "if-match": options.ifMatch } : {}),
    },
    body: JSON.stringify(body),
  });
  Object.defineProperty(request, "nextUrl", { value: url });
  return request as unknown as NextRequest;
}

function createSuccessResponse(): Response {
  return Response.json(
    {
      ok: true,
      data: {
        preset: {
          id: PRESET_ID,
          name: "Hot inbound leads",
          q: "Avery",
          stage: "quoted",
          excludeOutbound: true,
          view: "list",
          version: 1,
          createdAt: COMMITTED_AT,
          updatedAt: COMMITTED_AT,
        },
      },
      receipt: {
        operationId: OPERATION_ID,
        correlationId: CORRELATION_ID,
        actorId: ACTOR_ID,
        committedAt: COMMITTED_AT,
        auditEventId: AUDIT_EVENT_ID,
        entityType: "team_pipeline_filter_preset",
        entityId: PRESET_ID,
        version: "1",
      },
    },
    {
      status: 201,
      headers: { "x-correlation-id": CORRELATION_ID },
    },
  );
}

describe("Site Pipeline preset boundaries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects cross-origin creation before authentication, body parsing, or upstream access", async () => {
    const request = presetRequest(
      "POST",
      {
        name: "Hot inbound leads",
        q: "Avery",
        stage: "quoted",
        excludeOutbound: true,
        view: "list",
      },
      { crossOrigin: true },
    );

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(request.bodyUsed).toBe(false);
    expect(mockRequireTeamPrincipal).not.toHaveBeenCalled();
    expect(mockCallAdminApiAs).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "forbidden",
      message:
        "The saved-filter request origin could not be verified. Nothing was changed.",
      retryable: false,
    });
  });

  it("denies a missing effective permission before parsing the body", async () => {
    mockRequireTeamPrincipal.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "forbidden" }, { status: 403 }),
    });
    const request = presetRequest("POST", {
      name: "Hot inbound leads",
      q: "Avery",
      stage: "quoted",
      excludeOutbound: true,
      view: "list",
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(request.bodyUsed).toBe(false);
    expect(mockRequireTeamPrincipal).toHaveBeenCalledWith(request, {
      permissions: "pipeline.read",
      returnJson: true,
    });
    expect(mockCallAdminApiAs).not.toHaveBeenCalled();
  });

  it("replays one exact create request until a bound canonical receipt exists", async () => {
    mockRequireTeamPrincipal.mockResolvedValue(authenticatedPrincipal());
    mockCallAdminApiAs
      .mockResolvedValueOnce(
        Response.json(
          { ok: true, committed: true, receipt: "incomplete" },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(createSuccessResponse());

    const response = await POST(
      presetRequest("POST", {
        name: "  Hot   inbound leads ",
        q: "  Avery  ",
        stage: "quoted",
        excludeOutbound: true,
        view: "list",
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("x-correlation-id")).toBe(CORRELATION_ID);
    expect(mockCallAdminApiAs).toHaveBeenCalledTimes(2);
    const first = mockCallAdminApiAs.mock.calls[0]!;
    const replay = mockCallAdminApiAs.mock.calls[1]!;
    expect(first[0]).toBe(replay[0]);
    expect(first[1]).toBe("/api/admin/crm/pipeline/presets");
    expect(replay[1]).toBe(first[1]);
    expect(replay[2].body).toBe(first[2].body);
    expect(replay[2].headers).toBe(first[2].headers);
    expect(new Headers(first[2].headers).get("idempotency-key")).toBe(
      IDEMPOTENCY_KEY,
    );
    if (typeof first[2].body !== "string") {
      throw new Error("expected one stable JSON request body");
    }
    expect(JSON.parse(first[2].body)).toEqual({
      name: "Hot inbound leads",
      q: "Avery",
      stage: "quoted",
      excludeOutbound: true,
      view: "list",
    });
  });

  it("forwards exact delete versioning and surfaces a canonical conflict without retry", async () => {
    mockRequireTeamPrincipal.mockResolvedValue(authenticatedPrincipal());
    mockCallAdminApiAs.mockResolvedValue(
      Response.json(
        {
          ok: false,
          code: "conflict",
          message: "The saved filter changed.",
          retryable: false,
          fieldErrors: { version: "Refresh saved filters." },
        },
        { status: 409 },
      ),
    );

    const response = await DELETE(
      presetRequest("DELETE", { expectedVersion: 1 }, { ifMatch: "1" }),
      { params: Promise.resolve({ presetId: PRESET_ID }) },
    );

    expect(response.status).toBe(409);
    expect(mockCallAdminApiAs).toHaveBeenCalledTimes(1);
    const [, path, init] = mockCallAdminApiAs.mock.calls[0]!;
    expect(path).toBe(`/api/admin/crm/pipeline/presets/${PRESET_ID}`);
    expect(new Headers(init.headers).get("idempotency-key")).toBe(
      IDEMPOTENCY_KEY,
    );
    expect(new Headers(init.headers).get("if-match")).toBe("1");
    expect(init.body).toBe(JSON.stringify({ expectedVersion: 1 }));
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "conflict",
      retryable: false,
    });
  });
});

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

import { POST } from "../../../site/src/app/api/team/inbox/export/route";

const correlationId = "11111111-1111-4111-8111-111111111111";
const receiptId = "22222222-2222-4222-8222-222222222222";

function exportRequest(query = "days=invalid"): NextRequest {
  const url = new URL(
    `https://site.example.test/api/team/inbox/export?${query}`,
  );
  const request = new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: url.origin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ confirmed: true }),
  });
  Object.defineProperty(request, "nextUrl", { value: url });
  return request as unknown as NextRequest;
}

function preparedExportResponse(): Response {
  const body =
    '{"messages":[{"role":"user","content":"Private customer text"}]}\n';
  const byteCount = new TextEncoder().encode(body).byteLength;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="stonegate-conversations-2026-08-08.jsonl"',
      "Content-Length": String(byteCount),
      "X-Export-Format-Version": "1",
      "X-Export-Receipt-Id": receiptId,
      "X-Export-Row-Count": "1",
      "X-Export-Thread-Count": "1",
      "X-Export-Message-Count": "1",
      "X-Export-Byte-Count": String(byteCount),
      "X-Export-Maximum-Messages": "5000",
      "X-Export-Maximum-Threads": "1000",
      "X-Export-Maximum-Body-Bytes": "32768",
      "X-Export-Maximum-Line-Bytes": "262144",
      "X-Export-Maximum-Bytes": "8388608",
      "X-Export-Truncated": "false",
      "X-Export-Audit-State": "prepared",
      "X-Audit-Correlation-Id": correlationId,
    },
  });
}

describe("Site conversation export route boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("denies a missing messages.export grant before body parsing or upstream access", async () => {
    mockRequireTeamPrincipal.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "forbidden" }, { status: 403 }),
    });
    const request = exportRequest();

    const response = await POST(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "forbidden",
      retryable: false,
    });
    expect(mockRequireTeamPrincipal).toHaveBeenCalledWith(request, {
      permissions: "messages.export",
      returnJson: true,
    });
    expect(request.bodyUsed).toBe(false);
    expect(mockCallAdminApiAs).not.toHaveBeenCalled();
  });

  it("replays the exact release operation when the committed acknowledgement is lost", async () => {
    jest
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(
        correlationId as `${string}-${string}-${string}-${string}-${string}`,
      );
    mockRequireTeamPrincipal.mockResolvedValue({
      ok: true,
      principal: {
        memberId: "member-1",
        sessionToken: "opaque-session",
        permissions: ["messages.export"],
      },
      role: "office",
    });
    mockCallAdminApiAs
      .mockResolvedValueOnce(preparedExportResponse())
      .mockRejectedValueOnce(new TypeError("response_lost_after_commit"))
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: true,
            correlationId,
            exportId: receiptId,
            outcome: "released",
            idempotent: true,
          },
          {
            headers: { "x-audit-correlation-id": correlationId },
          },
        ),
      );

    const response = await POST(exportRequest("days=7"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-export-audit-state")).toBe("released");
    expect(response.headers.get("x-export-receipt-id")).toBe(receiptId);
    await expect(response.text()).resolves.toBe(
      '{"messages":[{"role":"user","content":"Private customer text"}]}\n',
    );
    expect(mockCallAdminApiAs).toHaveBeenCalledTimes(3);

    const firstRelease = mockCallAdminApiAs.mock.calls[1];
    const replayedRelease = mockCallAdminApiAs.mock.calls[2];
    if (!firstRelease || !replayedRelease) {
      throw new Error("expected two release attempts");
    }
    const firstReleaseInit = firstRelease[2];
    const replayedReleaseInit = replayedRelease[2];
    expect(firstRelease[1]).toBe("/api/admin/inbox/export/jsonl");
    expect(replayedRelease[1]).toBe(firstRelease[1]);
    expect(replayedReleaseInit.method).toBe("PUT");
    expect(replayedReleaseInit.body).toBe(firstReleaseInit.body);
    expect(new Headers(replayedReleaseInit.headers).get("x-request-id")).toBe(
      new Headers(firstReleaseInit.headers).get("x-request-id"),
    );
    if (typeof firstReleaseInit.body !== "string") {
      throw new Error("expected a JSON release body");
    }
    expect(JSON.parse(firstReleaseInit.body)).toEqual({
      correlationId,
      exportId: receiptId,
      outcome: "released",
      reason: null,
    });
  });
});

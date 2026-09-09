import { NextRequest } from "next/server";
import { PartnerPortalSchedulingError } from "@/lib/partner-portal-v2-scheduling/errors";
import { requirePortalUuid } from "@/lib/partner-portal-v2-scheduling/domain";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  name: string,
  factory: () => Record<string, unknown>,
) => void;
const authorize = jest.fn();
const createDraft = jest.fn();
const allowedOrigin = jest.fn();
const hasRead = jest.fn();
const actor = { accountId: "account", membershipId: "membership" };
mockModule("@/lib/partner-account-authorization", () => ({
  requirePartnerCapability: authorize,
  hasPartnerCapability: hasRead,
}));
mockModule("@/lib/partner-portal-v2-security", () => ({
  isAllowedPartnerPortalMutationOrigin: allowedOrigin,
}));
mockModule("@/lib/partner-portal-v2-scheduling", () => ({
  createPartnerAdditionalServiceDraft: createDraft,
  PartnerPortalSchedulingError,
  requirePortalUuid,
  requirePartnerSchedulingActor: () => actor,
}));
mockModule("@/lib/partner-additional-service", () => ({
  getPartnerAdditionalServiceLinks: jest.fn(),
}));
const { POST } = await import(
  "../../app/api/portal/v2/jobs/[jobId]/additional-service/route"
);
const jobId = "11111111-1111-4111-8111-111111111111";
const draftId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ jobId }) };
function request(
  body: unknown = {},
  key: string | null = "additional-service-retry-001",
) {
  return new NextRequest(
    `https://portal.example/api/portal/v2/jobs/${jobId}/additional-service`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}
describe("additional service request boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    allowedOrigin.mockReturnValue(true);
    hasRead.mockReturnValue(true);
    authorize.mockResolvedValue({
      ok: true,
      principal: { capabilities: ["jobs.read", "bookings.create"] },
    });
    createDraft.mockResolvedValue({
      draft: {
        id: draftId,
        etag: '"draft:1"',
        additionalServiceFromJobId: jobId,
      },
      replayed: false,
    });
  });
  it("starts a new draft with a hashed operation key, not parent financial fields", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(201);
    expect(authorize).toHaveBeenCalledWith(
      expect.any(NextRequest),
      "bookings.create",
    );
    expect(hasRead).toHaveBeenCalledWith(expect.anything(), "jobs.read");
    expect(createDraft).toHaveBeenCalledWith({
      actor,
      jobId,
      correlationId: expect.any(String) as unknown,
      idempotencyKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown,
    });
    expect(response.headers.get("etag")).toBe('"draft:1"');
    expect(response.headers.get("location")).toBe(
      `/api/portal/v2/booking-drafts/${draftId}`,
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      ok: true,
      draft: { additionalServiceFromJobId: jobId },
    });
  });
  it("returns the original draft on retry", async () => {
    createDraft.mockResolvedValue({
      draft: { id: draftId, etag: '"draft:1"' },
      replayed: true,
    });
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      replayed: true,
      draft: { id: draftId },
    });
  });
  it("requires a scheduling identity", async () => {
    authorize.mockResolvedValue({ ok: false, status: 403, error: "forbidden" });
    expect((await POST(request(), context)).status).toBe(403);
    expect(createDraft).not.toHaveBeenCalled();
  });
  it("returns opaque not found without source read permission", async () => {
    hasRead.mockReturnValue(false);
    expect((await POST(request(), context)).status).toBe(404);
    expect(createDraft).not.toHaveBeenCalled();
  });
  it("requires origin verification", async () => {
    allowedOrigin.mockReturnValue(false);
    expect((await POST(request(), context)).status).toBe(403);
    expect(authorize).not.toHaveBeenCalled();
  });
  it("requires idempotency", async () => {
    expect((await POST(request({}, null), context)).status).toBe(400);
    expect(createDraft).not.toHaveBeenCalled();
  });
  it.each([
    { amountCents: 1 },
    { additionalServiceFromJobId: draftId },
    [],
    null,
  ])("rejects forged or ambiguous input %p", async (body) => {
    expect((await POST(request(body), context)).status).toBe(400);
    expect(createDraft).not.toHaveBeenCalled();
  });
  it("bounds the request body", async () => {
    expect(
      (await POST(request({ description: "x".repeat(300) }), context)).status,
    ).toBe(413);
    expect(createDraft).not.toHaveBeenCalled();
  });
  it("rejects malformed source IDs before database work", async () => {
    expect(
      (
        await POST(request(), {
          params: Promise.resolve({ jobId: "not-a-job" }),
        })
      ).status,
    ).toBe(422);
    expect(createDraft).not.toHaveBeenCalled();
  });
  it("preserves safe domain errors without exposing old payment details", async () => {
    createDraft.mockRejectedValue(
      new PartnerPortalSchedulingError("not_found", "The job was not found.", {
        status: 404,
      }),
    );
    const response = await POST(request(), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });
});

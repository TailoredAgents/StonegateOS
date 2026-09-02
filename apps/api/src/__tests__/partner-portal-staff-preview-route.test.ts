import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockIsAdminRequest = jest.fn<boolean, [unknown]>();
const mockRequirePermission = jest.fn<
  Promise<Response | null>,
  [unknown, string]
>();
const mockLoadPartnerStaffPreview = jest.fn<Promise<unknown>, [unknown]>();
const mockRecordAuditEvent = jest.fn<Promise<void>, [unknown]>();
const mockGetAuditActorFromRequest = jest.fn(() => ({
  type: "human" as const,
  id: "33333333-3333-4333-8333-333333333333",
  sessionId: "44444444-4444-4444-8444-444444444444",
  authMethod: "team_session" as const,
}));

mockModule("../../app/api/web/admin", () => ({
  isAdminRequest: mockIsAdminRequest,
}));
mockModule("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
mockModule("@/lib/partner-portal-staff-preview", () => ({
  loadPartnerStaffPreview: mockLoadPartnerStaffPreview,
  PARTNER_STAFF_PREVIEW_UUID_PATTERN:
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
}));
mockModule("@/lib/audit", () => ({
  getAuditActorFromRequest: mockGetAuditActorFromRequest,
  recordAuditEvent: mockRecordAuditEvent,
}));

const { GET } = await import(
  "../../app/api/admin/partners/portal-preview/[orgContactId]/route"
);

const ORG_CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const CORRELATION_ID = "staff-preview-test-0001";

function request(query = ""): NextRequest {
  return new NextRequest(
    `https://api.test/api/admin/partners/portal-preview/${ORG_CONTACT_ID}${query}`,
    { headers: { "x-correlation-id": CORRELATION_ID } },
  );
}

function context(orgContactId = ORG_CONTACT_ID) {
  return { params: Promise.resolve({ orgContactId }) };
}

const preview = {
  readOnly: true,
  previewScope: "account",
  account: {
    id: ACCOUNT_ID,
    name: "Acme Property Group",
    status: "portal_partner",
    portalAccessEnabled: true,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  },
  summary: {
    activeMemberCount: 2,
    activeLocationCount: 4,
    totalJobCount: 1,
    statusCounts: { confirmed: 1 },
    outstandingBalances: [],
  },
  jobs: [],
  page: { limit: 100, returned: 0, hasMore: false },
  selectedJob: null,
};

describe("staff Partner Portal read-only preview route", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsAdminRequest.mockReturnValue(true);
    mockRequirePermission.mockResolvedValue(null);
    mockLoadPartnerStaffPreview.mockResolvedValue({
      kind: "found",
      preview,
    });
    mockRecordAuditEvent.mockResolvedValue(undefined);
  });

  it("rejects an untrusted caller before capability resolution or data access", async () => {
    mockIsAdminRequest.mockReturnValue(false);

    const response = await GET(request(), context());

    expect(response.status).toBe(401);
    expect(mockRequirePermission).not.toHaveBeenCalled();
    expect(mockLoadPartnerStaffPreview).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("requires preview-specific access, audits an authenticated denial, and never loads data", async () => {
    mockRequirePermission.mockResolvedValue(
      Response.json({ error: "forbidden" }, { status: 403 }),
    );

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
    expect(mockRequirePermission).toHaveBeenCalledWith(
      expect.any(NextRequest),
      "partners.preview.read",
    );
    expect(mockLoadPartnerStaffPreview).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "partner_portal.staff_preview.denied",
        outcome: "denied",
        requiredPermissions: ["partners.preview.read"],
      }),
    );
  });

  it("account-binds a selected job and durably audits before returning the preview", async () => {
    const response = await GET(request(`?jobId=${JOB_ID}`), context());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(mockLoadPartnerStaffPreview).toHaveBeenCalledWith({
      orgContactId: ORG_CONTACT_ID,
      jobId: JOB_ID,
    });
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      action: "partner_portal.staff_preview.viewed",
      entityType: "partner_account",
      entityId: ACCOUNT_ID,
      outcome: "succeeded",
      requiredPermissions: ["partners.preview.read"],
      meta: {
        previewMode: "read_only",
        orgContactId: ORG_CONTACT_ID,
        jobId: JOB_ID,
      },
    });
    expect(body).toEqual(
      expect.objectContaining({
        ok: true,
        readOnly: true,
        preview,
      }),
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("returns the same tenant-safe 404 for malformed and account-invalid resources", async () => {
    const malformed = await GET(request("?jobId=not-a-job"), context());
    expect(malformed.status).toBe(404);
    await expect(malformed.json()).resolves.toEqual({
      ok: false,
      error: "not_found",
      correlationId: CORRELATION_ID,
    });
    expect(mockLoadPartnerStaffPreview).not.toHaveBeenCalled();

    mockLoadPartnerStaffPreview.mockResolvedValueOnce({ kind: "not_found" });
    const foreign = await GET(request(`?jobId=${JOB_ID}`), context());
    expect(foreign.status).toBe(404);
    await expect(foreign.json()).resolves.toEqual({
      ok: false,
      error: "not_found",
      correlationId: CORRELATION_ID,
    });
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "partner_portal.staff_preview.denied",
        outcome: "denied",
      }),
    );
  });

  it("fails closed when the successful preview audit cannot be persisted", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockRecordAuditEvent
      .mockRejectedValueOnce(new Error("audit unavailable"))
      .mockResolvedValueOnce(undefined);

    const response = await GET(request(), context());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      ok: false,
      error: "preview_unavailable",
    });
    expect(body).not.toHaveProperty("preview");
    expect(mockRecordAuditEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "partner_portal.staff_preview.failed",
        outcome: "failed",
      }),
    );
    errorSpy.mockRestore();
  });
});

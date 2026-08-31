import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockRequirePartnerCapability = jest.fn<
  Promise<unknown>,
  [unknown, string]
>();
const mockHasPartnerJobAccess = jest.fn<Promise<boolean>, [unknown, string]>();
const mockHasPartnerDraftAccess = jest.fn<
  Promise<boolean>,
  [unknown, string]
>();
const mockCreatePartnerMediaUploadIntents = jest.fn<
  Promise<unknown>,
  [unknown]
>();
const mockListPartnerMedia = jest.fn<Promise<unknown>, [unknown]>();
const mockFinalizePartnerMedia = jest.fn<Promise<unknown>, [unknown]>();
const mockSoftDeletePartnerMedia = jest.fn<Promise<unknown>, [unknown]>();

mockModule("@/lib/partner-account-authorization", () => ({
  requirePartnerCapability: mockRequirePartnerCapability,
}));
mockModule("@/lib/partner-portal-feature-flags", () => ({
  arePartnerPortalV2ReadsEnabled: () => true,
  arePartnerPortalV2WritesEnabled: () => true,
}));
mockModule("@/lib/partner-portal-v2-resource-authorization", () => ({
  hasPartnerDraftAccess: mockHasPartnerDraftAccess,
  hasPartnerJobAccess: mockHasPartnerJobAccess,
}));
mockModule("@/lib/partner-portal-v2-media", () => ({
  createPartnerMediaUploadIntents: mockCreatePartnerMediaUploadIntents,
  finalizePartnerMedia: mockFinalizePartnerMedia,
  listPartnerMedia: mockListPartnerMedia,
  softDeletePartnerMedia: mockSoftDeletePartnerMedia,
  PartnerMediaFinalizeSchema: {
    safeParse: () => ({ success: false }),
  },
  PartnerMediaUploadIntentSchema: {
    safeParse: () => ({ success: false }),
  },
  PartnerPortalMediaError: class PartnerPortalMediaError extends Error {},
}));
mockModule("@/lib/partner-portal-v2-security", () => ({
  isAllowedPartnerPortalMutationOrigin: () => true,
  isPortalV2Uuid: () => true,
}));

const { POST: createJobUploadIntent } = await import(
  "../../app/api/portal/v2/jobs/[jobId]/proof/upload-intents/route"
);
const { GET: listDraftMedia } = await import(
  "../../app/api/portal/v2/booking-drafts/[draftId]/media/route"
);
const { POST: createDraftUploadIntent } = await import(
  "../../app/api/portal/v2/booking-drafts/[draftId]/media/upload-intents/route"
);
const { POST: finalizeDraftMedia } = await import(
  "../../app/api/portal/v2/booking-drafts/[draftId]/media/[mediaId]/finalize/route"
);
const { DELETE: deleteDraftMedia } = await import(
  "../../app/api/portal/v2/booking-drafts/[draftId]/media/[mediaId]/route"
);

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const DRAFT_ID = "44444444-4444-4444-8444-444444444444";
const MEDIA_ID = "55555555-5555-4555-8555-555555555555";
const CORRELATION_ID = "scoped-resource-route-test";

describe("partner V2 scoped-resource route behavior", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockRequirePartnerCapability.mockResolvedValue({
      ok: true,
      principal: {
        accountId: ACCOUNT_ID,
        membershipId: MEMBERSHIP_ID,
        accessLevel: "scoped",
        accessScope: { locationIds: [], propertyIds: [] },
      },
    });
  });

  it("returns tenant-safe 404 before parsing or invoking media for an out-of-scope job", async () => {
    mockHasPartnerJobAccess.mockResolvedValue(false);
    const request = new NextRequest(
      `http://localhost/api/portal/v2/jobs/${JOB_ID}/proof/upload-intents`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": CORRELATION_ID,
        },
        body: "not-json",
      },
    );

    const response = await createJobUploadIntent(request, {
      params: Promise.resolve({ jobId: JOB_ID }),
    });

    expect(mockHasPartnerJobAccess).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT_ID }),
      JOB_ID,
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: "not_found",
        correlationId: CORRELATION_ID,
      }),
    );
    expect(mockCreatePartnerMediaUploadIntents).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "lists media",
      invoke: () =>
        listDraftMedia(
          new NextRequest(
            `http://localhost/api/portal/v2/booking-drafts/${DRAFT_ID}/media`,
          ),
          { params: Promise.resolve({ draftId: DRAFT_ID }) },
        ),
      service: mockListPartnerMedia,
    },
    {
      label: "creates an upload intent",
      invoke: () =>
        createDraftUploadIntent(
          new NextRequest(
            `http://localhost/api/portal/v2/booking-drafts/${DRAFT_ID}/media/upload-intents`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "not-json",
            },
          ),
          { params: Promise.resolve({ draftId: DRAFT_ID }) },
        ),
      service: mockCreatePartnerMediaUploadIntents,
    },
    {
      label: "finalizes media",
      invoke: () =>
        finalizeDraftMedia(
          new NextRequest(
            `http://localhost/api/portal/v2/booking-drafts/${DRAFT_ID}/media/${MEDIA_ID}/finalize`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "not-json",
            },
          ),
          {
            params: Promise.resolve({ draftId: DRAFT_ID, mediaId: MEDIA_ID }),
          },
        ),
      service: mockFinalizePartnerMedia,
    },
    {
      label: "deletes media",
      invoke: () =>
        deleteDraftMedia(
          new NextRequest(
            `http://localhost/api/portal/v2/booking-drafts/${DRAFT_ID}/media/${MEDIA_ID}`,
            { method: "DELETE" },
          ),
          {
            params: Promise.resolve({ draftId: DRAFT_ID, mediaId: MEDIA_ID }),
          },
        ),
      service: mockSoftDeletePartnerMedia,
    },
  ])(
    "returns tenant-safe 404 before it $label for an out-of-scope draft",
    async ({ invoke, service }) => {
      mockHasPartnerDraftAccess.mockResolvedValue(false);

      const response = await invoke();

      expect(mockHasPartnerDraftAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: ACCOUNT_ID,
          membershipId: MEMBERSHIP_ID,
        }),
        DRAFT_ID,
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ ok: false, error: "not_found" }),
      );
      expect(service).not.toHaveBeenCalled();
    },
  );
});

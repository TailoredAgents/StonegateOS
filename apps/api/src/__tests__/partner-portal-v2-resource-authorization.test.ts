import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  canAccessPartnerDraftResource,
  canAccessPartnerJobResource,
  createPartnerDraftAccessCondition,
  createPartnerJobAccessCondition,
  createPartnerLocationAccessCondition,
  createPartnerNotificationAccessCondition,
  normalizePartnerJobAccessScope,
  partnerJobAccessScopeKey,
  type PartnerDraftAuthorizationPrincipal,
  type PartnerJobAuthorizationPrincipal,
} from "@/lib/partner-portal-v2-resource-authorization";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const LOCATION_ID = "44444444-4444-4444-8444-444444444444";
const PROPERTY_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_LOCATION_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_PROPERTY_ID = "77777777-7777-4777-8777-777777777777";
const MEMBERSHIP_ID = "88888888-8888-4888-8888-888888888888";
const OTHER_MEMBERSHIP_ID = "99999999-9999-4999-8999-999999999999";
const COST_CENTER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function accountPrincipal(): PartnerDraftAuthorizationPrincipal {
  return {
    accountId: ACCOUNT_ID,
    membershipId: MEMBERSHIP_ID,
    accessLevel: "account",
    accessScope: {},
  };
}

function scopedPrincipal(
  accessScope: PartnerJobAuthorizationPrincipal["accessScope"] = {
    locationIds: [LOCATION_ID],
    propertyIds: [PROPERTY_ID],
  },
): PartnerDraftAuthorizationPrincipal {
  return {
    accountId: ACCOUNT_ID,
    membershipId: MEMBERSHIP_ID,
    accessLevel: "scoped",
    accessScope,
  };
}

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("partner V2 job resource authorization", () => {
  it("preserves account-wide access while always rejecting another account", () => {
    expect(
      canAccessPartnerJobResource(accountPrincipal(), {
        partnerAccountId: ACCOUNT_ID,
        locationId: null,
        propertyId: null,
      }),
    ).toBe(true);
    expect(
      canAccessPartnerJobResource(accountPrincipal(), {
        partnerAccountId: OTHER_ACCOUNT_ID,
        locationId: LOCATION_ID,
        propertyId: PROPERTY_ID,
      }),
    ).toBe(false);
  });

  it("treats scoped location and property grants as a union and fails closed", () => {
    const principal = scopedPrincipal();
    expect(
      canAccessPartnerJobResource(principal, {
        partnerAccountId: ACCOUNT_ID,
        locationId: LOCATION_ID,
        propertyId: OTHER_PROPERTY_ID,
      }),
    ).toBe(true);
    expect(
      canAccessPartnerJobResource(principal, {
        partnerAccountId: ACCOUNT_ID,
        locationId: OTHER_LOCATION_ID,
        propertyId: PROPERTY_ID,
      }),
    ).toBe(true);
    expect(
      canAccessPartnerJobResource(principal, {
        partnerAccountId: ACCOUNT_ID,
        locationId: OTHER_LOCATION_ID,
        propertyId: OTHER_PROPERTY_ID,
      }),
    ).toBe(false);
    expect(
      canAccessPartnerJobResource(scopedPrincipal({}), {
        partnerAccountId: ACCOUNT_ID,
        locationId: LOCATION_ID,
        propertyId: PROPERTY_ID,
      }),
    ).toBe(false);
  });

  it("normalizes membership JSON without allowing malformed IDs to widen scope", () => {
    const malformedScope = {
      locationIds: [
        LOCATION_ID.toUpperCase(),
        LOCATION_ID,
        "not-a-location",
        123,
      ],
      propertyIds: [PROPERTY_ID, ""],
      costCenterIds: [COST_CENTER_ID, "not-a-cost-center"],
    } as unknown as PartnerJobAuthorizationPrincipal["accessScope"];
    const normalized = normalizePartnerJobAccessScope(
      scopedPrincipal(malformedScope),
    );
    expect(normalized).toEqual({
      locationIds: [LOCATION_ID],
      propertyIds: [PROPERTY_ID],
      costCenterIds: [COST_CENTER_ID],
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.locationIds)).toBe(true);
    expect(
      normalizePartnerJobAccessScope(
        scopedPrincipal(
          null as unknown as PartnerJobAuthorizationPrincipal["accessScope"],
        ),
      ),
    ).toEqual({ locationIds: [], propertyIds: [], costCenterIds: [] });
    expect(
      normalizePartnerJobAccessScope(
        scopedPrincipal({ locationIds: Array(1_001).fill(LOCATION_ID) }),
      ).locationIds,
    ).toEqual([]);
  });

  it("binds cursors and caches to a deterministic current scope", () => {
    expect(
      partnerJobAccessScopeKey(
        scopedPrincipal({
          propertyIds: [PROPERTY_ID, OTHER_PROPERTY_ID],
          locationIds: [LOCATION_ID],
          costCenterIds: [COST_CENTER_ID],
        }),
      ),
    ).toBe(
      partnerJobAccessScopeKey(
        scopedPrincipal({
          locationIds: [LOCATION_ID],
          propertyIds: [OTHER_PROPERTY_ID, PROPERTY_ID],
          costCenterIds: [COST_CENTER_ID],
        }),
      ),
    );
    expect(partnerJobAccessScopeKey(accountPrincipal())).toBe("account");
    expect(partnerJobAccessScopeKey(scopedPrincipal({}))).not.toBe("account");
    expect(partnerJobAccessScopeKey(scopedPrincipal())).not.toContain(
      PROPERTY_ID,
    );
    expect(partnerJobAccessScopeKey(scopedPrincipal())).not.toContain(
      LOCATION_ID,
    );
    expect(
      partnerJobAccessScopeKey(
        scopedPrincipal({ costCenterIds: [COST_CENTER_ID] }),
      ),
    ).not.toContain(COST_CENTER_ID);
  });

  it("encodes account, job, location, and property restrictions in SQL", () => {
    const dialect = new PgDialect();
    const scoped = dialect.sqlToQuery(
      createPartnerJobAccessCondition(scopedPrincipal(), JOB_ID),
    );
    expect(scoped.sql).toContain('"partner_bookings"."partner_account_id"');
    expect(scoped.sql).toContain('"partner_bookings"."id"');
    expect(scoped.sql).toContain('"partner_account_locations"."id"');
    expect(scoped.sql).toContain('"partner_bookings"."property_id"');
    expect(scoped.sql.toLowerCase()).toContain(" or ");
    expect(scoped.params).toEqual(
      expect.arrayContaining([ACCOUNT_ID, JOB_ID, LOCATION_ID, PROPERTY_ID]),
    );

    const account = dialect.sqlToQuery(
      createPartnerJobAccessCondition(accountPrincipal(), JOB_ID),
    );
    expect(account.params).toEqual([ACCOUNT_ID, JOB_ID]);
    expect(account.sql).not.toContain('"partner_account_locations"."id"');

    const empty = dialect.sqlToQuery(
      createPartnerJobAccessCondition(scopedPrincipal({}), JOB_ID),
    );
    expect(empty.sql).toContain("false");
    expect(empty.params).toEqual(expect.arrayContaining([ACCOUNT_ID, JOB_ID]));

    const invalidJob = dialect.sqlToQuery(
      createPartnerJobAccessCondition(scopedPrincipal(), "not-a-job"),
    );
    expect(invalidJob.sql).toBe("false");
    expect(invalidJob.params).toEqual([]);
  });

  it("keeps account-only notifications while scoping every job-linked row", () => {
    const dialect = new PgDialect();
    const scoped = dialect.sqlToQuery(
      createPartnerNotificationAccessCondition(scopedPrincipal()),
    );
    expect(scoped.sql).toContain(
      '"partner_notifications"."partner_account_id"',
    );
    expect(scoped.sql).toContain(
      '"partner_notifications"."partner_booking_id" is null',
    );
    expect(scoped.sql).toContain('"partner_bookings"."partner_account_id"');
    expect(scoped.sql).toContain('"partner_account_locations"."id"');
    expect(scoped.sql).toContain('"partner_bookings"."property_id"');
    expect(scoped.params).toEqual(
      expect.arrayContaining([ACCOUNT_ID, LOCATION_ID, PROPERTY_ID]),
    );

    const emptyScope = dialect.sqlToQuery(
      createPartnerNotificationAccessCondition(scopedPrincipal({})),
    );
    expect(emptyScope.sql).toContain(
      '"partner_notifications"."partner_booking_id" is null',
    );
    expect(emptyScope.sql).toContain("false");
  });

  it("fails scoped location queries closed while preserving account access", () => {
    const dialect = new PgDialect();
    const scoped = dialect.sqlToQuery(
      createPartnerLocationAccessCondition(scopedPrincipal(), LOCATION_ID),
    );
    expect(scoped.sql).toContain(
      '"partner_account_locations"."partner_account_id"',
    );
    expect(scoped.sql).toContain('"partner_account_locations"."id"');
    expect(scoped.sql).toContain('"partner_account_locations"."property_id"');
    expect(scoped.params).toEqual(
      expect.arrayContaining([ACCOUNT_ID, LOCATION_ID, PROPERTY_ID]),
    );

    const account = dialect.sqlToQuery(
      createPartnerLocationAccessCondition(accountPrincipal(), LOCATION_ID),
    );
    expect(account.params).toEqual([ACCOUNT_ID, LOCATION_ID]);
    expect(account.sql).not.toContain(
      '"partner_account_locations"."property_id"',
    );

    const empty = dialect.sqlToQuery(
      createPartnerLocationAccessCondition(scopedPrincipal({}), LOCATION_ID),
    );
    expect(empty.sql).toContain("false");
  });
});

describe("partner V2 booking-draft resource authorization", () => {
  it("keeps locationless scoped drafts private to the current creator", () => {
    const resource = {
      partnerAccountId: ACCOUNT_ID,
      createdByMembershipId: MEMBERSHIP_ID,
      locationId: null,
      propertyId: null,
      locationActive: false,
    };
    expect(canAccessPartnerDraftResource(scopedPrincipal(), resource)).toBe(
      true,
    );
    expect(
      canAccessPartnerDraftResource(scopedPrincipal(), {
        ...resource,
        createdByMembershipId: OTHER_MEMBERSHIP_ID,
      }),
    ).toBe(false);
    expect(
      canAccessPartnerDraftResource(accountPrincipal(), {
        ...resource,
        createdByMembershipId: OTHER_MEMBERSHIP_ID,
      }),
    ).toBe(true);
    expect(
      canAccessPartnerDraftResource(
        { ...accountPrincipal(), membershipId: null },
        resource,
      ),
    ).toBe(false);
  });

  it("uses only current location/property grants after a location is selected", () => {
    const principal = scopedPrincipal();
    expect(
      canAccessPartnerDraftResource(principal, {
        partnerAccountId: ACCOUNT_ID,
        createdByMembershipId: OTHER_MEMBERSHIP_ID,
        locationId: LOCATION_ID,
        propertyId: OTHER_PROPERTY_ID,
        locationActive: true,
      }),
    ).toBe(true);
    expect(
      canAccessPartnerDraftResource(principal, {
        partnerAccountId: ACCOUNT_ID,
        createdByMembershipId: MEMBERSHIP_ID,
        locationId: OTHER_LOCATION_ID,
        propertyId: OTHER_PROPERTY_ID,
        locationActive: true,
      }),
    ).toBe(false);
    expect(
      canAccessPartnerDraftResource(principal, {
        partnerAccountId: OTHER_ACCOUNT_ID,
        createdByMembershipId: MEMBERSHIP_ID,
        locationId: LOCATION_ID,
        propertyId: PROPERTY_ID,
        locationActive: true,
      }),
    ).toBe(false);
    expect(
      canAccessPartnerDraftResource(principal, {
        partnerAccountId: ACCOUNT_ID,
        createdByMembershipId: MEMBERSHIP_ID,
        locationId: LOCATION_ID,
        propertyId: PROPERTY_ID,
        locationActive: false,
      }),
    ).toBe(false);
  });

  it("encodes creator-or-current-location scope in a fail-closed SQL predicate", () => {
    const dialect = new PgDialect();
    const scoped = dialect.sqlToQuery(
      createPartnerDraftAccessCondition(scopedPrincipal(), JOB_ID),
    );
    expect(scoped.sql).toContain(
      '"partner_booking_drafts"."partner_account_id"',
    );
    expect(scoped.sql).toContain(
      '"partner_booking_drafts"."created_by_membership_id"',
    );
    expect(scoped.sql).toContain('"partner_booking_drafts"."location_id"');
    expect(scoped.sql).toContain('"partner_account_locations"."property_id"');
    expect(scoped.params).toEqual(
      expect.arrayContaining([
        ACCOUNT_ID,
        JOB_ID,
        MEMBERSHIP_ID,
        LOCATION_ID,
        PROPERTY_ID,
      ]),
    );

    const noMembership = dialect.sqlToQuery(
      createPartnerDraftAccessCondition(
        { ...scopedPrincipal({}), membershipId: null },
        JOB_ID,
      ),
    );
    expect(noMembership.sql).toContain("false");
  });
});

describe("partner V2 job route authorization contracts", () => {
  const directSqlRoutes = [
    "app/api/portal/v2/jobs/route.ts",
    "app/api/portal/v2/jobs/[jobId]/route.ts",
    "app/api/portal/v2/jobs/[jobId]/cancel/route.ts",
    "app/api/portal/v2/jobs/[jobId]/messages/route.ts",
    "app/api/portal/v2/jobs/[jobId]/proof/packages/route.ts",
    "app/api/portal/v2/jobs/[jobId]/proof/requirements/route.ts",
    "app/api/portal/v2/jobs/[jobId]/proof/share-links/route.ts",
    "app/api/portal/v2/jobs/[jobId]/proof/share-links/[shareId]/route.ts",
  ];
  const guardedMediaRoutes = [
    "app/api/portal/v2/jobs/[jobId]/proof/route.ts",
    "app/api/portal/v2/jobs/[jobId]/proof/upload-intents/route.ts",
    "app/api/portal/v2/jobs/[jobId]/proof/[evidenceId]/route.ts",
    "app/api/portal/v2/jobs/[jobId]/proof/[evidenceId]/finalize/route.ts",
  ];
  const guardedDraftMediaRoutes = [
    "app/api/portal/v2/booking-drafts/[draftId]/media/route.ts",
    "app/api/portal/v2/booking-drafts/[draftId]/media/upload-intents/route.ts",
    "app/api/portal/v2/booking-drafts/[draftId]/media/[mediaId]/route.ts",
    "app/api/portal/v2/booking-drafts/[draftId]/media/[mediaId]/finalize/route.ts",
  ];

  it.each(directSqlRoutes)(
    "%s applies the shared scope predicate in its database boundary",
    (path) => {
      const contents = source(path);
      expect(contents).toContain("createPartnerJobAccessCondition");
      expect(contents).toContain("createPartnerJobLocationJoinCondition");
    },
  );

  it.each(guardedMediaRoutes)(
    "%s rejects an unauthorized job before calling its media/proof service",
    (path) => {
      const contents = source(path);
      expect(contents).toContain("hasPartnerJobAccess");
      expect(contents).toMatch(
        /if \(!\(await hasPartnerJobAccess\(principal, jobId\)\)\) \{/u,
      );
      expect(contents).toMatch(/"not_found",\s+404,/u);
    },
  );

  it.each(guardedDraftMediaRoutes)(
    "%s rejects unauthorized draft access with a tenant-safe response",
    (path) => {
      const contents = source(path);
      expect(contents).toContain("hasPartnerDraftAccess");
      expect(contents).toMatch(
        /if \(!\(await hasPartnerDraftAccess\(principal, draftId\)\)\) \{/u,
      );
      expect(contents).toMatch(/"not_found",\s+404,/u);
      expect(contents).toContain("principal,");
    },
  );

  it("rechecks draft scope inside each media operation", () => {
    const contents = source("src/lib/partner-portal-v2-media.ts");
    expect(contents).toContain("canAccessPartnerDraftResource");
    expect(contents.match(/lockParentForMediaMutation\(tx,/gu)).toHaveLength(4);
    expect(contents).toContain("await assertParentAvailable(tx, input)");
    expect(contents).toContain('.for("share")');
  });

  it("does not serialize raw media-asset identifiers", () => {
    const media = source("src/lib/partner-portal-v2-media.ts");
    const jobDetail = source("app/api/portal/v2/jobs/[jobId]/route.ts");
    const dtoSerializer = media.slice(
      media.indexOf("async function createMediaDto"),
      media.indexOf("export async function listPartnerMedia"),
    );
    expect(dtoSerializer).not.toContain("assetId:");
    expect(media).toContain("sanitizePartnerMediaPublicValue(");
    expect(jobDetail).not.toContain("assetId: partnerJobEvidence.mediaAssetId");
  });

  it("resolves message attachments through current ready evidence handles", () => {
    const messages = source("app/api/portal/v2/jobs/[jobId]/messages/route.ts");
    const media = source("src/lib/partner-portal-v2-media.ts");

    expect(
      messages.match(/loadReadyPartnerJobMessageAttachments\(/gu),
    ).toHaveLength(2);
    expect(messages).toContain("normalizePartnerJobMessageAttachmentIds(");
    expect(messages).toContain(
      "attachments.map((attachment) => attachment.id)",
    );
    expect(messages).not.toContain(
      'attachmentIds: Array.isArray(message.metadata?.["attachmentIds"])',
    );
    expect(media).toContain(
      "eq(partnerJobEvidence.partnerAccountId, input.accountId)",
    );
    expect(media).toContain(
      "eq(partnerJobEvidence.partnerBookingId, input.jobId)",
    );
    expect(media).toContain("isNull(partnerJobEvidence.deletedAt)");
    expect(media).toContain("isNull(mediaAssets.deletedAt)");
    expect(media).toContain('eq(mediaAssets.status, "ready")');
    expect(media).toContain("isNotNull(mediaAssets.readyAt)");
  });

  it("filters job-list scope in SQL before ordering and pagination", () => {
    const contents = source("app/api/portal/v2/jobs/route.ts");
    const authorizationIndex = contents.lastIndexOf(
      "createPartnerJobAccessCondition(principal)",
    );
    expect(authorizationIndex).toBeGreaterThan(0);
    expect(authorizationIndex).toBeLessThan(
      contents.indexOf(".orderBy(", authorizationIndex),
    );
    expect(authorizationIndex).toBeLessThan(
      contents.indexOf(".limit(pagination.limit + 1)", authorizationIndex),
    );
    expect(contents).toContain(
      "authorizationScope: partnerJobAccessScopeKey(principal)",
    );
  });

  it("applies scoped authorization to location and conversation lists", () => {
    const locations = source("app/api/portal/v2/locations/route.ts");
    const locationDetail = source(
      "app/api/portal/v2/locations/[locationId]/route.ts",
    );
    const threads = source("app/api/portal/v2/threads/route.ts");

    expect(locations).toContain(
      "createPartnerLocationAccessCondition(principal)",
    );
    expect(locations).toContain("partnerJobAccessScopeKey(principal)");
    expect(locations).toContain('principal.accessLevel !== "account"');
    expect(locationDetail).toContain(
      "createPartnerLocationAccessCondition(principal, locationId)",
    );
    expect(locationDetail).toContain(
      "await hasPartnerLocationAccess(principal, locationId)",
    );
    expect(threads).toContain("createPartnerJobAccessCondition(principal)");
    expect(threads).toContain("createPartnerJobLocationJoinCondition()");
    expect(threads).toContain(
      "accessScopeKey: partnerJobAccessScopeKey(principal)",
    );
  });

  it("applies current job scope and scope-bound cursors to notifications", () => {
    const list = source("app/api/portal/v2/notifications/route.ts");
    const read = source(
      "app/api/portal/v2/notifications/[notificationId]/read/route.ts",
    );
    const readAll = source("app/api/portal/v2/notifications/read-all/route.ts");

    for (const route of [list, read, readAll]) {
      expect(route).toContain(
        "createPartnerNotificationAccessCondition(principal)",
      );
      expect(route).toContain("createPartnerJobLocationJoinCondition()");
      expect(route).toContain("partnerJobAccessScopeKey(principal)");
      expect(route).toContain("partnerBookings.partnerAccountId");
      expect(route).toContain("partnerNotifications.partnerAccountId");
    }
    expect(list).toContain("accessScopeKey");
    expect(list).toContain(
      "pagination.cursor.payload.accessScopeKey !== accessScopeKey",
    );
    expect(list).toContain("pagination.cursor.payload.jobId !== jobId");
    expect(list).toContain(
      "eq(partnerNotifications.partnerBookingId, jobId)",
    );
    expect(list).toContain("SAFE_NOTIFICATION_ACTION_PATHS");
    expect(list).not.toContain('value?.startsWith("/partners/")');
  });

  it("requires account-wide access before mutating account proof defaults", () => {
    const proofDefaults = source(
      "app/api/portal/v2/proof-requirements/route.ts",
    );
    const patchStart = proofDefaults.indexOf("export async function PATCH");
    const accessGuard = proofDefaults.indexOf(
      'principal.accessLevel !== "account"',
      patchStart,
    );
    const bodyRead = proofDefaults.indexOf(
      "readBoundedJsonRequest(request",
      patchStart,
    );
    const transaction = proofDefaults.indexOf(
      "db.transaction(async (tx)",
      patchStart,
    );

    expect(accessGuard).toBeGreaterThan(patchStart);
    expect(accessGuard).toBeLessThan(bodyRead);
    expect(accessGuard).toBeLessThan(transaction);
    expect(proofDefaults).toContain(
      "eq(partnerAccounts.portalAccessEnabled, true)",
    );
  });

  it.each([
    [
      "app/api/portal/v2/jobs/[jobId]/cancel/route.ts",
      "readPortalV2IdempotencyKey",
    ],
    [
      "app/api/portal/v2/jobs/[jobId]/proof/packages/route.ts",
      "readPortalV2IdempotencyKey",
    ],
    [
      "app/api/portal/v2/jobs/[jobId]/proof/requirements/route.ts",
      "readBoundedJsonRequest",
    ],
    [
      "app/api/portal/v2/jobs/[jobId]/proof/share-links/route.ts",
      "readPortalV2IdempotencyKey",
    ],
  ])("%s checks current scope before parsing or replay", (path, boundary) => {
    const contents = source(path);
    const handlerStart = contents.indexOf("export async function");
    const authorizationIndex = contents.indexOf(
      "await hasPartnerJobAccess(principal, jobId)",
      handlerStart,
    );
    const boundaryIndex = contents.indexOf(boundary, authorizationIndex);
    expect(authorizationIndex).toBeGreaterThan(handlerStart);
    expect(boundaryIndex).toBeGreaterThan(authorizationIndex);
  });

  it("checks both message reads and writes before cursor/body processing", () => {
    const contents = source("app/api/portal/v2/jobs/[jobId]/messages/route.ts");
    const getStart = contents.indexOf("export async function GET");
    const postStart = contents.indexOf("export async function POST");
    const getAuthorization = contents.indexOf(
      "await hasPartnerJobAccess(principal, jobId)",
      getStart,
    );
    const postAuthorization = contents.indexOf(
      "await hasPartnerJobAccess(principal, jobId)",
      postStart,
    );
    expect(getAuthorization).toBeLessThan(
      contents.indexOf("parsePortalV2Pagination", getAuthorization),
    );
    expect(postAuthorization).toBeLessThan(
      contents.indexOf("readPortalV2IdempotencyKey", postAuthorization),
    );
  });

  it("account-binds proof shares and suppresses foreign document associations", () => {
    const createShare = source(
      "app/api/portal/v2/jobs/[jobId]/proof/share-links/route.ts",
    );
    const revokeShare = source(
      "app/api/portal/v2/jobs/[jobId]/proof/share-links/[shareId]/route.ts",
    );
    const detail = source("app/api/portal/v2/jobs/[jobId]/route.ts");
    const proof = source("app/api/portal/v2/jobs/[jobId]/proof/route.ts");

    expect(createShare).toContain(
      "partnerProofPackages.partnerAccountId,\n              partnerBookings.partnerAccountId",
    );
    expect(createShare).toContain(
      "eq(partnerDocuments.partnerAccountId, principal.accountId!)",
    );
    expect(createShare).toContain(
      "eq(partnerDocuments.partnerBookingId, jobId)",
    );
    expect(revokeShare).toContain(
      "partnerProofShareLinks.partnerAccountId,\n              partnerProofPackages.partnerAccountId",
    );
    expect(detail).toContain("authorizedDocumentIds.has(proof.pdfDocumentId)");
    expect(proof).toContain("authorizedDocumentIds.has(row.pdfDocumentId)");
  });
});

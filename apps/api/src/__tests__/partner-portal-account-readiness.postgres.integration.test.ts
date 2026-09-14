import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import {
  appointmentHolds,
  appointments,
  closeDbForTests,
  contacts,
  getDb,
  outboxEvents,
  partnerAccounts,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccountSchedulingPolicies,
  partnerApprovalRequests,
  partnerBookingDrafts,
  partnerBookings,
  partnerRoleTemplates,
  partnerUsers,
  properties,
} from "@/db";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  name: string,
  factory: () => Record<string, unknown>,
) => void;
const authorization = await import("@/lib/partner-account-authorization");
let principal: PartnerPrincipal | null = null;
let authError: Error | null = null;
// Session transport only is replaced. Membership derivation, route gates,
// provider-free address fallback and every database transaction remain real.
mockModule("@/lib/partner-account-authorization", () => ({
  ...authorization,
  requirePartnerCapability: (
    _request: NextRequest,
    capability: Parameters<typeof authorization.hasPartnerCapability>[1],
  ) => {
    if (authError) return Promise.reject(authError);
    return Promise.resolve(
      principal && authorization.hasPartnerCapability(principal, capability)
        ? { ok: true, principal }
        : { ok: false, status: 403, error: "forbidden" },
    );
  },
}));
const { GET: overview } = await import(
  "../../app/api/portal/v2/overview/route"
);
const { GET: jobs } = await import("../../app/api/portal/v2/jobs/route");
const { GET: quotes } = await import("../../app/api/portal/v2/quotes/route");
const { listCanonicalPartnerQuotes } = await import(
  "@/lib/partner-portal-v2-quotes"
);
const { GET: locations, POST: createLocation } = await import(
  "../../app/api/portal/v2/locations/route"
);
const { getPartnerPortalAvailability } = await import(
  "@/lib/partner-portal-availability"
);
const { decidePartnerApprovalRequest, getPartnerApprovalRequest } =
  await import("@/lib/partner-portal-v2-approvals");
const local =
  process.env.DATABASE_URL &&
  ["127.0.0.1", "localhost"].includes(
    new URL(process.env.DATABASE_URL).hostname,
  );
const suite = local ? describe : describe.skip;
const envKeys = [
  "NODE_ENV",
  "PARTNER_PORTAL_V2_READS_ENABLED",
  "PARTNER_PORTAL_V2_WRITES_ENABLED",
  "PARTNER_PORTAL_INTERNAL_TEST_MODE",
  "PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED",
  "MAPBOX_ACCESS_TOKEN",
];
const prior = new Map(envKeys.map((key) => [key, process.env[key]]));

async function fixture() {
  const accountId = randomUUID(),
    userId = randomUUID(),
    membershipId = randomUUID();
  const db = getDb();
  const [role] = await db
    .select()
    .from(partnerRoleTemplates)
    .where(
      and(
        eq(partnerRoleTemplates.key, "administrator"),
        isNull(partnerRoleTemplates.partnerAccountId),
      ),
    )
    .limit(1);
  await db.insert(partnerAccounts).values({
    id: accountId,
    name: "Local portal readiness",
    normalizedName: accountId,
    status: "active_partner",
    portalAccessEnabled: true,
  });
  await db.insert(partnerUsers).values({
    id: userId,
    email: `${userId}@example.test`,
    normalizedEmail: `${userId}@example.test`,
    name: "Local portal user",
    active: true,
    identityStatus: "active",
    emailVerifiedAt: new Date(),
  });
  await db.insert(partnerAccountMemberships).values({
    id: membershipId,
    partnerAccountId: accountId,
    partnerUserId: userId,
    roleKey: "administrator",
    roleTemplateId: role!.id,
    status: "active",
    accessLevel: "account",
    acceptedAt: new Date(),
  });
  const [access] = await authorization.loadActiveMembershipAccesses(userId);
  if (!access) throw new Error("Local test membership missing");
  principal = {
    ...access,
    type: "partner",
    partnerUserId: userId,
    email: `${userId}@example.test`,
    name: "Local portal user",
    passwordSet: true,
    accessSource: "membership",
    availableAccounts: [access],
    session: {
      id: randomUUID(),
      authMethod: "password",
      deviceName: null,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
    },
  };
  return { accountId, userId, membershipId, principal };
}
function request(path: string) {
  return new NextRequest(`http://localhost/api/portal/v2/${path}`, {
    headers: { "x-correlation-id": "local-account-readiness" },
  });
}
async function addLocation() {
  return createLocation(
    new NextRequest("http://localhost/api/portal/v2/locations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-correlation-id": "local-account-readiness",
      },
      body: JSON.stringify({
        siteName: "First test location",
        address: {
          line1: `${randomUUID()} Test Way`,
          city: "Atlanta",
          state: "GA",
          postalCode: "30301",
        },
      }),
    }),
  );
}

suite(
  "fresh partner account access and manual confirmation / real PostgreSQL",
  () => {
    beforeEach(() => {
      process.env.NODE_ENV = "production";
      process.env.PARTNER_PORTAL_V2_READS_ENABLED = "true";
      process.env.PARTNER_PORTAL_V2_WRITES_ENABLED = "true";
      process.env.PARTNER_PORTAL_INTERNAL_TEST_MODE = "false";
      process.env.PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED = "false";
      delete process.env.MAPBOX_ACCESS_TOKEN;
      authError = null;
    });
    afterAll(async () => {
      principal = null;
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await closeDbForTests();
    });
    it("loads a brand-new empty company and creates its first location with all optional tools off", async () => {
      const f = await fixture();
      const home = await overview(request("overview"));
      expect(home.status).toBe(200);
      await expect(home.json()).resolves.toMatchObject({
        nextJob: null,
        savedRequest: null,
        outstandingBalances: [],
      });
      const jobList = await jobs(request("jobs"));
      expect(jobList.status).toBe(200);
      await expect(jobList.json()).resolves.toMatchObject({ jobs: [] });
      await expect(
        listCanonicalPartnerQuotes({
          principal: f.principal,
          params: new URLSearchParams("limit=100"),
        }),
      ).resolves.toMatchObject({ ok: true, items: [], nextCursor: null });
      const quoteList = await quotes(request("quotes?limit=100"));
      expect(quoteList.status).toBe(200);
      await expect(quoteList.json()).resolves.toMatchObject({ quotes: [] });
      const filteredQuotes = await quotes(
        request("quotes?limit=100&status=expired"),
      );
      expect(filteredQuotes.status).toBe(200);
      await expect(filteredQuotes.json()).resolves.toMatchObject({
        quotes: [],
      });
      const locationList = await locations(request("locations"));
      expect(locationList.status).toBe(200);
      await expect(locationList.json()).resolves.toMatchObject({
        locations: [],
        directory: { canCreateLocation: true, canManagePortfolio: false },
      });
      const created = await addLocation();
      expect(created.status).toBe(201);
      const payload = (await created.json()) as { location: { id: string } };
      const [stored] = await getDb()
        .select()
        .from(partnerAccountLocations)
        .where(eq(partnerAccountLocations.id, payload.location.id));
      expect(stored?.partnerAccountId).toBe(f.accountId);
      expect(stored?.addressVerificationStatus).toBe("review_required");
      const [account] = await getDb()
        .select()
        .from(partnerAccounts)
        .where(eq(partnerAccounts.id, f.accountId));
      expect(account?.portalWorkflowConfig).toEqual({});
    });
    it("keeps a scoped member and viewer from creating locations, and separately enforces read-only mode", async () => {
      const f = await fixture();
      principal = {
        ...f.principal,
        accessLevel: "scoped",
        accessScope: { locationIds: [] },
      };
      await expect(
        (await locations(request("locations"))).json(),
      ).resolves.toMatchObject({
        directory: { canCreateLocation: false, canManagePortfolio: false },
      });
      expect((await addLocation()).status).toBe(403);
      principal = {
        ...f.principal,
        capabilities: ["properties.read", "portal.session.read"],
      };
      await expect(
        (await locations(request("locations"))).json(),
      ).resolves.toMatchObject({ directory: { canCreateLocation: false } });
      expect((await addLocation()).status).toBe(403);
      principal = f.principal;
      process.env.PARTNER_PORTAL_V2_WRITES_ENABLED = "false";
      await expect(
        (await locations(request("locations"))).json(),
      ).resolves.toMatchObject({
        directory: { canCreateLocation: false, canManagePortfolio: false },
      });
      expect((await addLocation()).status).toBe(503);
      expect(
        await getDb()
          .select()
          .from(partnerAccountLocations)
          .where(eq(partnerAccountLocations.partnerAccountId, f.accountId)),
      ).toEqual([]);
    });
    it("distinguishes disabled reads from an empty account", async () => {
      await fixture();
      delete process.env.PARTNER_PORTAL_V2_READS_ENABLED;
      for (const [path, handler] of [
        ["overview", overview],
        ["jobs", jobs],
        ["locations", locations],
      ] as const) {
        const response = await handler(request(path));
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
          error: "service_unavailable",
          correlationId: "local-account-readiness",
        });
      }
    });
    it("contains authorization query failures in the same safe correlated response", async () => {
      authError = Object.assign(
        new Error("sensitive database URL and submitted values"),
        { cause: { code: "42703" } },
      );
      const logger = jest
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        for (const [path, handler] of [
          ["jobs", jobs],
          ["locations", locations],
          ["quotes", quotes],
        ] as const) {
          const response = await handler(request(path));
          expect(response.status).toBe(500);
          await expect(response.json()).resolves.toMatchObject({
            error: "internal_error",
            correlationId: "local-account-readiness",
          });
        }
        expect(logger).toHaveBeenCalledWith(
          "[partner-portal-v2] request failed",
          expect.objectContaining({
            category: "database_schema",
            errorCode: "42703",
            correlationId: "local-account-readiness",
          }),
        );
        expect(JSON.stringify(logger.mock.calls)).not.toContain("sensitive");
      } finally {
        logger.mockRestore();
      }
    });

    it.each([
      { global: false, account: true },
      { global: true, account: false },
      { global: true, account: null },
    ])(
      "records old held approvals without confirming when global=$global and account=$account",
      async (settings) => {
        const f = await fixture();
        const db = getDb(),
          now = new Date();
        process.env.PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED = String(
          settings.global,
        );
        if (settings.account !== null)
          await db
            .insert(partnerAccountSchedulingPolicies)
            .values({
              partnerAccountId: f.accountId,
              instantConfirmationEnabled: settings.account,
            })
            .onConflictDoUpdate({
              target: partnerAccountSchedulingPolicies.partnerAccountId,
              set: { instantConfirmationEnabled: settings.account },
            });
        else
          await db
            .delete(partnerAccountSchedulingPolicies)
            .where(
              eq(
                partnerAccountSchedulingPolicies.partnerAccountId,
                f.accountId,
              ),
            );
        expect(
          (await getPartnerPortalAvailability(f.principal)).instantConfirmation,
        ).toBe(false);
        const requesterUserId = randomUUID(),
          requesterId = randomUUID(),
          contactId = randomUUID(),
          propertyId = randomUUID(),
          draftId = randomUUID(),
          appointmentId = randomUUID(),
          bookingId = randomUUID(),
          holdId = randomUUID(),
          approvalId = randomUUID();
        const start = new Date(now.getTime() + 86400000),
          end = new Date(start.getTime() + 7200000);
        await db.transaction(async (tx) => {
          await tx.insert(partnerUsers).values({
            id: requesterUserId,
            email: `${requesterUserId}@example.test`,
            normalizedEmail: `${requesterUserId}@example.test`,
            name: "Local requester",
            active: true,
            identityStatus: "active",
            emailVerifiedAt: now,
          });
          await tx.insert(partnerAccountMemberships).values({
            id: requesterId,
            partnerAccountId: f.accountId,
            partnerUserId: requesterUserId,
            roleKey: "operations",
            status: "active",
            accessLevel: "account",
            acceptedAt: now,
          });
          await tx.insert(contacts).values({
            id: contactId,
            firstName: "Local",
            lastName: "Held approval",
          });
          await tx.insert(properties).values({
            id: propertyId,
            contactId,
            addressLine1: "1 Local Approval Way",
            city: "Atlanta",
            state: "GA",
            postalCode: "30301",
          });
          await tx.insert(partnerBookingDrafts).values({
            id: draftId,
            partnerAccountId: f.accountId,
            createdByMembershipId: requesterId,
            state: "submitted",
            expiresAt: new Date(now.getTime() + 3600000),
          });
          await tx.insert(appointments).values({
            id: appointmentId,
            contactId,
            propertyId,
            partnerAccountId: f.accountId,
            type: "job",
            status: "requested",
            rescheduleToken: randomUUID(),
          });
          await tx.insert(partnerBookings).values({
            id: bookingId,
            orgContactId: contactId,
            partnerAccountId: f.accountId,
            requestedByMembershipId: requesterId,
            propertyId,
            appointmentId,
            bookingDraftId: draftId,
            publicStatus: "approval_needed",
            confirmationMode: "approval",
            arrivalWindowStartAt: start,
            arrivalWindowEndAt: end,
          });
          await tx.insert(appointmentHolds).values({
            id: holdId,
            partnerAccountId: f.accountId,
            partnerBookingDraftId: draftId,
            requestedByMembershipId: requesterId,
            propertyId,
            startAt: start,
            durationMinutes: 60,
            arrivalWindowStartAt: start,
            arrivalWindowEndAt: end,
            policyRevision: "old-policy",
            serviceProfileRevision: 1,
            status: "active",
            expiresAt: new Date(now.getTime() + 3600000),
          });
          await tx.insert(partnerApprovalRequests).values({
            id: approvalId,
            partnerAccountId: f.accountId,
            partnerBookingId: bookingId,
            requestedByMembershipId: requesterId,
            approvalHoldId: holdId,
            state: "pending",
            requiredDecisionCount: 1,
            ruleSnapshot: [
              {
                id: randomUUID(),
                name: "Local approval",
                version: 1,
                requiredApproverCapabilities: ["approvals.decide"],
                requiredApproverRoleKeys: [],
                requiredDecisionCount: 1,
              },
            ],
            requestSnapshot: {},
          });
        });
        const view = await getPartnerApprovalRequest({
          accountId: f.accountId,
          membershipId: f.membershipId,
          requestId: approvalId,
          access: f.principal,
        });
        expect(view.ok).toBe(true);
        const result = await decidePartnerApprovalRequest({
          accountId: f.accountId,
          membershipId: f.membershipId,
          partnerUserId: f.userId,
          email: f.principal.email,
          roleKey: "administrator",
          sessionId: f.principal.session.id,
          requestId: approvalId,
          decision: "approved",
          reason: null,
          ifMatch: view.ok ? view.etag : null,
          idempotencyKeyHash: "a".repeat(64),
          correlationId: "local-account-readiness",
          now,
        });
        expect(result.status).toBe(200);
        const [approval] = await db
          .select()
          .from(partnerApprovalRequests)
          .where(eq(partnerApprovalRequests.id, approvalId));
        const [hold] = await db
          .select()
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, holdId));
        const [appointment] = await db
          .select()
          .from(appointments)
          .where(eq(appointments.id, appointmentId));
        expect(approval?.state).toBe("approved_needs_reschedule");
        expect(hold?.status).toBe("released");
        expect(appointment).toMatchObject({
          status: "requested",
          startAt: null,
          promisedArrivalStartAt: null,
          promisedArrivalEndAt: null,
        });
        const events = await db
          .select()
          .from(outboxEvents)
          .where(eq(outboxEvents.type, "appointment.calendar_sync_requested"));
        expect(
          events.some(
            (event) => event.payload["appointmentId"] === appointmentId,
          ),
        ).toBe(false);
      },
    );
  },
);

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  appointments,
  closeDbForTests,
  contacts,
  getDb,
  outboxEvents,
  partnerAccounts,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerApprovalRequests,
  partnerBookings,
  partnerMembershipLocationScopes,
  partnerRoleTemplates,
  partnerUsers,
  properties,
} from "@/db";
import { loadActiveMembershipAccesses } from "@/lib/partner-account-authorization";
import {
  decidePartnerApprovalRequest,
  getPartnerApprovalRequest,
  listPartnerApprovalRequests,
} from "@/lib/partner-portal-v2-approvals";

const local =
  process.env["DATABASE_URL"] &&
  ["127.0.0.1", "localhost"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const describeLocal = local ? describe : describe.skip;
describeLocal(
  "approval scope and canonical authority in local PostgreSQL",
  () => {
    afterAll(closeDbForTests);
    it("filters assigned locations, forbids self-approval, refreshes canonical authority, and emits a committed job decision", async () => {
      const accountId = randomUUID(),
        userId = randomUUID(),
        requesterUserId = randomUUID(),
        membershipId = randomUUID(),
        requesterId = randomUUID();
      const locationId = randomUUID(),
        propertyId = randomUUID(),
        contactId = randomUUID(),
        appointmentId = randomUUID(),
        bookingId = randomUUID(),
        requestId = randomUUID();
      const db = getDb();
      const [role] = await db
        .select()
        .from(partnerRoleTemplates)
        .where(
          and(
            eq(partnerRoleTemplates.key, "billing_approver"),
            isNull(partnerRoleTemplates.partnerAccountId),
          ),
        )
        .limit(1);
      expect(role).toBeDefined();
      await db.transaction(async (tx) => {
        await tx.insert(partnerAccounts).values({
          id: accountId,
          name: "Local approval company",
          normalizedName: `approval-${accountId}`,
          status: "active_partner",
          portalAccessEnabled: true,
        });
        await tx.insert(partnerUsers).values(
          [userId, requesterUserId].map((id) => ({
            id,
            email: `${id}@example.test`,
            normalizedEmail: `${id}@example.test`,
            name: "Local approval user",
            active: true,
            identityStatus: "active" as const,
            emailVerifiedAt: new Date(),
          })),
        );
        await tx.insert(partnerAccountMemberships).values([
          {
            id: membershipId,
            partnerAccountId: accountId,
            partnerUserId: userId,
            roleKey: "billing_approver",
            roleTemplateId: role!.id,
            accessLevel: "scoped",
            status: "active",
            acceptedAt: new Date(),
          },
          {
            id: requesterId,
            partnerAccountId: accountId,
            partnerUserId: requesterUserId,
            roleKey: "operations",
            accessLevel: "account",
            status: "active",
            acceptedAt: new Date(),
          },
        ]);
        await tx.insert(contacts).values({
          id: contactId,
          firstName: "Approval",
          lastName: "Local",
          email: `${contactId}@example.test`,
        });
        await tx.insert(properties).values({
          id: propertyId,
          contactId,
          addressLine1: "1 Local Approval Way",
          city: "Atlanta",
          state: "GA",
          postalCode: "30301",
        });
        await tx.insert(partnerAccountLocations).values({
          id: locationId,
          partnerAccountId: accountId,
          propertyId,
          siteName: "Assigned site",
          addressLine1: "1 Local Approval Way",
          city: "Atlanta",
          state: "GA",
          postalCode: "30301",
        });
        await tx
          .insert(partnerMembershipLocationScopes)
          .values({ membershipId, partnerAccountId: accountId, locationId });
        await tx.insert(appointments).values({
          id: appointmentId,
          partnerAccountId: accountId,
          contactId,
          propertyId,
          type: "job",
          status: "requested",
          rescheduleToken: randomUUID(),
        });
        await tx.insert(partnerBookings).values({
          id: bookingId,
          partnerAccountId: accountId,
          orgContactId: contactId,
          propertyId,
          appointmentId,
          requestedByMembershipId: requesterId,
          publicStatus: "approval_needed",
          confirmationMode: "approval",
        });
        await tx.insert(partnerApprovalRequests).values({
          id: requestId,
          partnerAccountId: accountId,
          partnerBookingId: bookingId,
          requestedByMembershipId: requesterId,
          state: "pending",
          requiredDecisionCount: 1,
          ruleSnapshot: [
            {
              id: randomUUID(),
              name: "Local approval",
              version: 1,
              requiredApproverCapabilities: ["approvals.decide"],
              requiredApproverRoleKeys: ["billing_approver"],
              requiredDecisionCount: 1,
            },
          ],
          requestSnapshot: {},
        });
      });
      const access = (await loadActiveMembershipAccesses(userId)).find(
        (row) => row.membershipId === membershipId,
      )!;
      expect(access.capabilities).toContain("approvals.decide");
      expect(access.accessScope.locationIds).toContain(locationId);
      const allowed = await getPartnerApprovalRequest({
        accountId,
        membershipId,
        requestId,
        access,
      });
      expect(allowed.ok).toBe(true);
      const denied = {
        ...access,
        accessScope: { locationIds: [randomUUID()] },
      };
      expect(
        await getPartnerApprovalRequest({
          accountId,
          membershipId,
          requestId,
          access: denied,
        }),
      ).toMatchObject({ ok: false, status: 404 });
      expect(
        await listPartnerApprovalRequests({
          accountId,
          membershipId,
          access: denied,
          params: new URLSearchParams(),
        }),
      ).toMatchObject({ approvalRequests: [] });
      const decision = {
        accountId,
        membershipId,
        partnerUserId: userId,
        email: `${userId}@example.test`,
        roleKey: "billing_approver",
        sessionId: randomUUID(),
        correlationId: "local-approval",
        idempotencyKeyHash: "a".repeat(64),
        requestId,
        ifMatch: allowed.ok ? allowed.etag : null,
        decision: "declined" as const,
        reason: "Local test decision",
      };
      const [original] = await db
        .select()
        .from(partnerApprovalRequests)
        .where(eq(partnerApprovalRequests.id, requestId));
      const selfRequestId = randomUUID();
      await db.insert(partnerApprovalRequests).values({
        ...original!,
        id: selfRequestId,
        requestedByMembershipId: membershipId,
      });
      const selfView = await getPartnerApprovalRequest({
        accountId,
        membershipId,
        requestId: selfRequestId,
        access,
      });
      expect(
        await decidePartnerApprovalRequest({
          ...decision,
          requestId: selfRequestId,
          ifMatch: selfView.ok ? selfView.etag : null,
        }),
      ).toMatchObject({ status: 403 });
      const fresh = await getPartnerApprovalRequest({
        accountId,
        membershipId,
        requestId,
        access,
      });
      expect(
        await decidePartnerApprovalRequest({
          ...decision,
          ifMatch: fresh.ok ? fresh.etag : null,
        }),
      ).toMatchObject({ status: 200 });
      expect(
        (
          await db
            .select()
            .from(partnerApprovalRequests)
            .where(eq(partnerApprovalRequests.id, requestId))
        )[0]!.state,
      ).toBe("declined");
      const events = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.type, "partner.approval.decided"));
      expect(
        events.some(
          (row) =>
            row.payload["approvalRequestId"] === requestId &&
            row.payload["partnerBookingId"] === bookingId,
        ),
      ).toBe(true);
      await db
        .update(partnerAccountMemberships)
        .set({ status: "suspended", suspendedAt: new Date() })
        .where(eq(partnerAccountMemberships.id, membershipId));
      expect(await decidePartnerApprovalRequest(decision)).toMatchObject({
        status: 403,
      });
    });
    it.each(["approved", "declined"] as const)(
      "records a %s company decision for a combined request without creating an appointment",
      async (decision) => {
        const db = getDb();
        const accountId = randomUUID(),
          userId = randomUUID(),
          requesterUserId = randomUUID();
        const membershipId = randomUUID(),
          requesterId = randomUUID(),
          contactId = randomUUID();
        const propertyId = randomUUID(),
          locationId = randomUUID(),
          bookingId = randomUUID(),
          requestId = randomUUID();
        const [role] = await db
          .select()
          .from(partnerRoleTemplates)
          .where(
            and(
              eq(partnerRoleTemplates.key, "billing_approver"),
              isNull(partnerRoleTemplates.partnerAccountId),
            ),
          )
          .limit(1);
        await db.transaction(async (tx) => {
          await tx.insert(partnerAccounts).values({
            id: accountId,
            name: "Combined approval company",
            normalizedName: `multi-approval-${accountId}`,
            status: "active_partner",
            portalAccessEnabled: true,
          });
          await tx.insert(partnerUsers).values(
            [userId, requesterUserId].map((id) => ({
              id,
              email: `${id}@example.test`,
              normalizedEmail: `${id}@example.test`,
              name: "Combined approval user",
              active: true,
              identityStatus: "active" as const,
              emailVerifiedAt: new Date(),
            })),
          );
          await tx.insert(partnerAccountMemberships).values([
            {
              id: membershipId,
              partnerAccountId: accountId,
              partnerUserId: userId,
              roleKey: "billing_approver",
              roleTemplateId: role!.id,
              accessLevel: "account",
              status: "active",
              acceptedAt: new Date(),
            },
            {
              id: requesterId,
              partnerAccountId: accountId,
              partnerUserId: requesterUserId,
              roleKey: "operations",
              accessLevel: "account",
              status: "active",
              acceptedAt: new Date(),
            },
          ]);
          await tx.insert(contacts).values({
            id: contactId,
            firstName: "Combined",
            lastName: "Approval",
            email: `${contactId}@example.test`,
          });
          await tx.insert(properties).values({
            id: propertyId,
            contactId,
            addressLine1: "2 Local Approval Way",
            city: "Atlanta",
            state: "GA",
            postalCode: "30301",
          });
          await tx.insert(partnerAccountLocations).values({
            id: locationId,
            partnerAccountId: accountId,
            propertyId,
            siteName: "Combined services site",
            addressLine1: "2 Local Approval Way",
            city: "Atlanta",
            state: "GA",
            postalCode: "30301",
          });
          await tx.insert(partnerBookings).values({
            id: bookingId,
            modelVersion: 2,
            partnerAccountId: accountId,
            orgContactId: contactId,
            propertyId,
            appointmentId: null,
            requestedByMembershipId: requesterId,
            publicStatus: "approval_needed",
            confirmationMode: "review",
          });
          await tx.insert(partnerApprovalRequests).values({
            id: requestId,
            partnerAccountId: accountId,
            partnerBookingId: bookingId,
            requestedByMembershipId: requesterId,
            state: "pending",
            requiredDecisionCount: 1,
            ruleSnapshot: [
              {
                id: randomUUID(),
                name: "Combined approval",
                version: 1,
                requiredApproverCapabilities: ["approvals.decide"],
                requiredApproverRoleKeys: ["billing_approver"],
                requiredDecisionCount: 1,
              },
            ],
            requestSnapshot: {
              modelVersion: 2,
              serviceKeys: ["painting", "junk-removal"],
              amountMinor: null,
              currency: "USD",
            },
          });
        });
        const access = (await loadActiveMembershipAccesses(userId)).find(
          (row) => row.membershipId === membershipId,
        )!;
        const detail = await getPartnerApprovalRequest({
          accountId,
          membershipId,
          requestId,
          access,
        });
        expect(detail).toMatchObject({ ok: true });
        if (!detail.ok) throw new Error("Combined request was not readable");
        expect(detail).toMatchObject({
          approvalRequest: {
            request: {
              modelVersion: 2,
              serviceKeys: ["painting", "junk-removal"],
            },
          },
        });
        expect(
          await listPartnerApprovalRequests({
            accountId,
            membershipId,
            access,
            params: new URLSearchParams(),
          }),
        ).toMatchObject({
          approvalRequests: [expect.objectContaining({ id: requestId })],
        });
        expect(
          await getPartnerApprovalRequest({
            accountId: randomUUID(),
            membershipId,
            requestId,
            access,
          }),
        ).toMatchObject({ ok: false, status: 404 });
        expect(
          await decidePartnerApprovalRequest({
            accountId,
            membershipId,
            partnerUserId: userId,
            email: `${userId}@example.test`,
            roleKey: "billing_approver",
            sessionId: randomUUID(),
            correlationId: "combined-approval",
            idempotencyKeyHash: randomUUID().replaceAll("-", "").repeat(2),
            requestId,
            ifMatch: detail.etag,
            decision,
            reason: "Company reviewed all requested services",
          }),
        ).toMatchObject({ status: 200 });
        const [booking] = await db
          .select()
          .from(partnerBookings)
          .where(eq(partnerBookings.id, bookingId));
        expect(booking).toMatchObject({
          modelVersion: 2,
          appointmentId: null,
          pricedAt: null,
          quotedTotalCents: null,
          publicStatus: decision === "approved" ? "under_review" : "declined",
          confirmationMode: "review",
        });
        expect(
          await db
            .select()
            .from(appointments)
            .where(eq(appointments.partnerAccountId, accountId)),
        ).toHaveLength(0);
        const [approval] = await db
          .select()
          .from(partnerApprovalRequests)
          .where(eq(partnerApprovalRequests.id, requestId));
        expect(approval?.state).toBe(
          decision === "approved" ? "approved_needs_reschedule" : "declined",
        );
        expect(
          (
            await db
              .select()
              .from(outboxEvents)
              .where(eq(outboxEvents.type, "partner.approval.decided"))
          ).some((row) => row.payload["approvalRequestId"] === requestId),
        ).toBe(true);
      },
    );
  },
);

import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  appointments,
  closeDbForTests,
  contacts,
  getDb,
  partnerAccounts,
  partnerAccountMemberships,
  partnerUsers,
  partnerBookings,
  partnerBookingDrafts,
  partnerAccountLocations,
  partnerLocationAddressReviews,
  partnerRescheduleRequests,
  properties,
  teamMembers,
} from "@/db";
import {
  getPartnerRequestInboxItem,
  listPartnerRequestInbox,
} from "@/lib/partner-request-inbox";
import {
  parsePartnerRequestInbox,
  parsePartnerRequestInboxDetail,
} from "@myst-os/sdk";
import type { PermissionContext } from "@/lib/permissions";
const local =
  process.env["DATABASE_URL"] &&
  ["127.0.0.1", "localhost"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;
const context = (permissions = ["*"]): PermissionContext => ({
  authenticated: true,
  source: "team_session",
  role: "owner",
  permissions,
  principalId: randomUUID(),
  principalLabel: "Local owner",
  sessionId: randomUUID(),
  authenticatedAt: new Date(),
});
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
async function fixture() {
  const accountId = randomUUID(),
    name = `Inbox % fixture ${accountId}`,
    contactId = randomUUID(),
    propertyId = randomUUID(),
    memberId = randomUUID(),
    userId = randomUUID(),
    locationId = randomUUID();
  await getDb().transaction(async (tx) => {
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name,
      normalizedName: name.toLowerCase(),
      portalAccessEnabled: true,
    });
    await tx.insert(contacts).values({
      id: contactId,
      firstName: "Inbox",
      lastName: "Fixture",
      partnerAccountId: accountId,
    });
    await tx.insert(properties).values({
      id: propertyId,
      contactId,
      addressLine1: "403 Test Lane",
      city: "Woodstock",
      state: "GA",
      postalCode: "30188",
    });
    await tx.insert(partnerUsers).values({
      id: userId,
      email: `${userId}@example.test`,
      normalizedEmail: `${userId}@example.test`,
      name: "Test Requester",
      identityStatus: "active",
      active: true,
      emailVerifiedAt: new Date(),
    });
    await tx.insert(partnerAccountMemberships).values({
      id: memberId,
      partnerAccountId: accountId,
      partnerUserId: userId,
      roleKey: "company_admin",
      status: "active",
      accessLevel: "account",
      acceptedAt: new Date(),
    });
    await tx.insert(partnerAccountLocations).values({
      id: locationId,
      partnerAccountId: accountId,
      propertyId,
      siteName: "Test site",
      addressLine1: "403 Test Lane",
      city: "Woodstock",
      state: "GA",
      postalCode: "30188",
    });
  });
  const job = async (status = "under_review", scheduled = false) => {
    const id = randomUUID(),
      appointmentId = randomUUID(),
      draftId = randomUUID();
    await getDb().transaction(async (tx) => {
      await tx.insert(partnerBookingDrafts).values({
        id: draftId,
        partnerAccountId: accountId,
        createdByMembershipId: memberId,
      });
      await tx.insert(appointments).values({
        id: appointmentId,
        partnerAccountId: accountId,
        contactId,
        propertyId,
        type: "job",
        status: scheduled ? "confirmed" : "requested",
        startAt: scheduled ? new Date("2035-06-04T14:00:00Z") : null,
        rescheduleToken: randomUUID(),
      });
      await tx.insert(partnerBookings).values({
        id,
        partnerAccountId: accountId,
        orgContactId: contactId,
        propertyId,
        appointmentId,
        bookingDraftId: draftId,
        requestedByMembershipId: memberId,
        partnerUserId: userId,
        publicStatus: status,
        serviceKey: "junk-removal",
        scopeSnapshot: {
          description: "Remove two cabinets.",
          accessDetails: "SECRET ACCESS",
          commercial: { poNumber: "SECRET FINANCE" },
          preferredWindows: [{ localDate: "2035-06-04", timeOfDay: "morning" }],
          locationSnapshot: {
            id: locationId,
            name: "Test site",
            timezone: "America/New_York",
            address: {
              line1: "403 Test Lane",
              city: "Woodstock",
              state: "GA",
              postalCode: "30188",
            },
          },
        },
      });
    });
    return { id, appointmentId, draftId };
  };
  return { accountId, name, memberId, locationId, job };
}
suite("unified partner request inbox / PostgreSQL", () => {
  afterAll(async () => closeDbForTests());
  it("shows all six request kinds, complete counts, requested timing and no private fields", async () => {
    const f = await fixture(),
      ready = await f.job(),
      waiting = await f.job("approval_needed"),
      handled = await f.job("confirmed", true),
      other = await fixture();
    await other.job();
    await getDb()
      .insert(partnerRescheduleRequests)
      .values({
        partnerAccountId: f.accountId,
        partnerBookingId: handled.id,
        bookingDraftId: handled.draftId,
        createdByMembershipId: f.memberId,
        previousStartAt: new Date("2035-06-04T14:00:00Z"),
        requestKind: "preferred_dates",
        preferredWindows: [{ localDate: "2035-06-05", timeOfDay: "afternoon" }],
        operationKeyHash: digest(randomUUID()),
        requestHash: digest(randomUUID()),
      });
    const cancellationId = randomUUID(),
      changeId = randomUUID(),
      invoiceId = randomUUID(),
      threadId = randomUUID(),
      billingId = randomUUID();
    await getDb().execute(
      sql`insert into partner_cancellation_requests(id,partner_account_id,partner_booking_id,requested_by_membership_id,reason,request_snapshot,operation_key_hash,request_hash) values(${cancellationId},${f.accountId},${handled.id},${f.memberId},'Cancel this service please','{"version":1}',${digest(randomUUID())},${digest(randomUUID())})`,
    );
    await getDb().execute(
      sql`insert into partner_job_change_requests(id,partner_account_id,partner_booking_id,requested_by_membership_id,reason,proposed_changes,request_snapshot,base_booking_revision,operation_key_hash,request_hash) values(${changeId},${f.accountId},${handled.id},${f.memberId},'Add the second cabinet please','{"version":1,"description":"Two cabinets","materiality":{}}','{"version":1}',1,${digest(randomUUID())},${digest(randomUUID())})`,
    );
    await getDb().execute(
      sql`insert into partner_invoices(id,partner_account_id,partner_booking_id,invoice_number,subtotal_cents,total_cents,balance_cents,billing_contact) values(${invoiceId},${f.accountId},${handled.id},${invoiceId},100,100,100,'{}')`,
    );
    await getDb().execute(
      sql`insert into conversation_threads(id,partner_account_id,staff_scope,portal_visible) values(${threadId},${f.accountId},'partner_billing',true)`,
    );
    const snapshot = JSON.stringify({
      version: 1,
      replayReceipt: {
        version: 1,
        status: 201,
        correlationId: "test-correlation",
        etag: '"' + "A".repeat(43) + '"',
        message: "Test receipt",
      },
    });
    await getDb().execute(
      sql`insert into partner_billing_dispute_requests(id,partner_account_id,partner_booking_id,partner_invoice_id,requested_by_membership_id,conversation_thread_id,thread_scope,category,reason,request_snapshot,operation_key_hash,request_hash) values(${billingId},${f.accountId},${handled.id},${invoiceId},${f.memberId},${threadId},'account_billing','other','Explain the charges please',${snapshot}::jsonb,${digest(randomUUID())},${digest(randomUUID())})`,
    );
    await getDb()
      .insert(partnerLocationAddressReviews)
      .values({
        partnerAccountId: f.accountId,
        locationId: f.locationId,
        requestedByMembershipId: f.memberId,
        reasonCode: "partner_requested",
        enteredAddress: { line1: "403 Test Lane" },
      });
    const owner = context(),
      query = new URLSearchParams({ accountId: f.accountId, limit: "2" });
    const response = await listPartnerRequestInbox(query, owner);
    expect(parsePartnerRequestInbox(response)).not.toBeNull();
    expect(response.counts).toMatchObject({
      needsAttention: 6,
      waitingOnClient: 1,
      handled: 1,
      byKind: {
        service: 1,
        reschedule: 1,
        cancellation: 1,
        change: 1,
        billing: 1,
        address: 1,
      },
      byCompany: { [f.accountId]: 6 },
    });
    const rows = [...response.requests];
    let cursor = response.page.nextCursor;
    while (cursor) {
      query.set("cursor", cursor);
      const page = await listPartnerRequestInbox(query, owner);
      rows.push(...page.requests);
      cursor = page.page.nextCursor;
    }
    expect(new Set(rows.map((r) => r.kind)).size).toBe(6);
    expect(new Set(rows.map((r) => r.key)).size).toBe(6);
    expect(rows.find((r) => r.id === ready.id)).toMatchObject({
      requesterName: "Test Requester",
      address: "403 Test Lane, Woodstock, GA, 30188",
      preferredWindows: [
        {
          localDate: "2035-06-04",
          timeOfDay: "morning",
          timezone: "America/New_York",
        },
      ],
    });
    expect(JSON.stringify(rows)).not.toMatch(/SECRET|poNumber|accessDetails/u);
    for (const kind of [
      "cancellation",
      "change",
      "billing",
      "address",
    ] as const) {
      const row = rows.find((r) => r.kind === kind)!;
      const detail = await getPartnerRequestInboxItem(
        kind,
        row.id,
        f.accountId,
        owner,
      );
      expect(parsePartnerRequestInboxDetail(detail)).not.toBeNull();
      expect(detail.record?.["id"]).toBe(row.id);
    }
    const restricted = await listPartnerRequestInbox(
      new URLSearchParams({ accountId: f.accountId }),
      context(["partners.cancellation_requests.read"]),
    );
    expect(restricted.requests.map((r) => r.kind)).toEqual(["cancellation"]);
    expect(restricted.counts.needsAttention).toBe(1);
    expect(restricted.requests[0]?.canAct).toBe(false);
    await expect(
      getPartnerRequestInboxItem("service", ready.id, other.accountId, owner),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      listPartnerRequestInbox(
        new URLSearchParams({ kind: "billing" }),
        context(["partners.accounts.read"]),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const searched = await listPartnerRequestInbox(
      new URLSearchParams({ q: f.name }),
      owner,
    );
    expect(searched.counts.needsAttention).toBe(6);
    const changed = new URLSearchParams({
      accountId: f.accountId,
      limit: "2",
      cursor: response.page.nextCursor!,
      status: "handled",
    });
    await expect(listPartnerRequestInbox(changed, owner)).rejects.toMatchObject(
      { status: 422 },
    );
    const waitingResponse = await listPartnerRequestInbox(
      new URLSearchParams({
        accountId: f.accountId,
        status: "waiting_on_client",
      }),
      owner,
    );
    expect(waitingResponse.requests.map((r) => r.id)).toEqual([waiting.id]);
    // Existing review decisions are terminal. Follow-up billing/change-order work
    // must not leave an undecidable request permanently inflating the queue.
    await getDb()
      .insert(teamMembers)
      .values({ id: owner.principalId!, name: "Inbox decision reviewer" });
    await getDb().execute(
      sql`update partner_job_change_requests set state='change_order_required', revision=revision+1, updated_at=now(), resolved_by_team_member_id=${owner.principalId}, resolution_reason='A formal change order is needed.', resolution_snapshot='{"version":1,"outcome":"change_order_required"}', resolved_at=now() where id=${changeId}`,
    );
    await getDb().execute(
      sql`update partner_billing_dispute_requests set state='adjustment_required', revision=revision+1, updated_at=now(), resolved_by_team_member_id=${owner.principalId}, resolution_reason='A billing adjustment is needed.', resolution_snapshot='{"version":1,"outcome":"adjustment_required","providerActionPerformed":false,"monetaryMutationPerformed":false}', resolved_at=now() where id=${billingId}`,
    );
    const afterDecisions = await listPartnerRequestInbox(
      new URLSearchParams({ accountId: f.accountId }),
      owner,
    );
    expect(afterDecisions.counts).toMatchObject({
      needsAttention: 4,
      handled: 3,
      byKind: { change: 0, billing: 0 },
    });
    const decided = await listPartnerRequestInbox(
      new URLSearchParams({ accountId: f.accountId, status: "handled" }),
      owner,
    );
    expect(
      decided.requests
        .filter((row) => row.id === changeId || row.id === billingId)
        .every((row) => row.canAct === false),
    ).toBe(true);
  });
  it("group links retain resolved members, never mark opened on a read, and bind company identity", async () => {
    const f = await fixture(),
      first = await f.job(),
      closed = await f.job("confirmed", true),
      owner = context(),
      groupId = randomUUID();
    await getDb()
      .insert(teamMembers)
      .values({ id: owner.principalId!, name: "Inbox test owner" });
    await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`insert into partner_owner_alert_groups(id,partner_account_id,owner_team_member_id,settings_revision,member_count) values(${groupId},${f.accountId},${owner.principalId},1,2)`,
      );
      for (const job of [first, closed])
        await tx.execute(
          sql`insert into partner_owner_alert_members(group_id,partner_account_id,partner_booking_id,owner_team_member_id) values(${groupId},${f.accountId},${job.id},${owner.principalId})`,
        );
    });
    const result = await listPartnerRequestInbox(
      new URLSearchParams({ alertGroupId: groupId }),
      owner,
    );
    expect(result.requests).toHaveLength(2);
    expect(result.group).toMatchObject({
      id: groupId,
      memberCount: 2,
      canAcknowledge: true,
      openedAt: null,
    });
    const otherOwner = await listPartnerRequestInbox(
      new URLSearchParams({ alertGroupId: groupId }),
      context(),
    );
    expect(otherOwner.group?.canAcknowledge).toBe(false);
    const opened = await getDb().execute(
      sql`select opened_at from partner_owner_alert_members where group_id=${groupId}`,
    );
    expect(opened.every((row) => row["opened_at"] === null)).toBe(true);
    await expect(
      listPartnerRequestInbox(
        new URLSearchParams({ alertGroupId: groupId, accountId: randomUUID() }),
        owner,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await getDb()
      .update(partnerBookings)
      .set({ publicStatus: "canceled" })
      .where(eq(partnerBookings.id, first.id));
    const resolved = await listPartnerRequestInbox(
      new URLSearchParams({ alertGroupId: groupId }),
      owner,
    );
    expect(resolved.requests).toHaveLength(2);
    expect(resolved.counts.needsAttention).toBe(0);
  });
});

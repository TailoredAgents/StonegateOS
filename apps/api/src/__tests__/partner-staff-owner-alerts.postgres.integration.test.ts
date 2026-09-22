import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  appointments,
  appointmentHolds,
  partnerJobEvents,
  closeDbForTests,
  contacts,
  getDb,
  outboxEvents,
  partnerAccountMemberships,
  partnerAccounts,
  partnerApprovalRequests,
  partnerBookingDrafts,
  partnerBookings,
  partnerBulkImports,
  partnerBulkImportRows,
  partnerOwnerAlertGroups,
  partnerOwnerAlertSettings,
  partnerRoleTemplates,
  partnerUsers,
  properties,
  staffNotificationOperations,
  teamMembers,
  teamRoles,
} from "@/db";
import {
  changeOwnerAlertSettings,
  enqueueOwnerAlertEvaluation,
  evaluateOwnerAlert,
  markOwnerAlertOpened,
  ownerAlertSettingsDto,
  processOwnerAlertReminder,
  queueOwnerAlertTest,
  OWNER_ALERT_REMINDER_MS,
} from "@/lib/partner-owner-alerts";
import {
  finalizeStaffNotificationDispatch,
  prepareStaffNotificationDispatch,
} from "@/lib/staff-notification-operations";
import {
  getPartnerApprovalRequest,
  decidePartnerApprovalRequest,
} from "@/lib/partner-portal-v2-approvals";
import { loadActiveMembershipAccesses } from "@/lib/partner-account-authorization";
import { getDefaultPermissionsForRole } from "@/lib/permissions";

const local =
  process.env["DATABASE_URL"] &&
  ["localhost", "127.0.0.1"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;
const NOW = new Date("2035-05-01T12:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const ownerId = randomUUID();
const phone = `+1555${String(BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 10)}`) % 10000000n).padStart(7, "0")}`;
let db: ReturnType<typeof getDb>;
let savedSettings: typeof partnerOwnerAlertSettings.$inferSelect;
const accounts: string[] = [];
async function fixture() {
  const accountId = randomUUID(),
    userId = randomUUID(),
    membershipId = randomUUID(),
    contactId = randomUUID(),
    propertyId = randomUUID();
  accounts.push(accountId);
  await db.transaction(async (tx) => {
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: "Owner alert test company",
      normalizedName: accountId,
      status: "active_partner",
      portalAccessEnabled: true,
    });
    await tx.insert(partnerUsers).values({
      id: userId,
      email: `${userId}@example.test`,
      normalizedEmail: `${userId}@example.test`,
      name: "Synthetic requester",
      active: true,
      identityStatus: "active",
      emailVerifiedAt: NOW,
    });
    await tx.insert(partnerAccountMemberships).values({
      id: membershipId,
      partnerAccountId: accountId,
      partnerUserId: userId,
      roleKey: "operations",
      status: "active",
      accessLevel: "account",
      acceptedAt: NOW,
    });
    await tx.insert(contacts).values({
      id: contactId,
      firstName: "Synthetic",
      lastName: "Owner alerts",
    });
    await tx.insert(properties).values({
      id: propertyId,
      contactId,
      addressLine1: "1 Test Way",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
    });
  });
  return { accountId, userId, membershipId, contactId, propertyId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function job(
  f: Fixture,
  input: {
    status?: "under_review" | "approval_needed";
    createdAt?: Date;
    bulkId?: string;
    row?: number;
    modelVersion?: 1 | 2;
  } = {},
) {
  const id = randomUUID(),
    appointmentId = randomUUID(),
    draftId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(partnerBookingDrafts).values({
      id: draftId,
      partnerAccountId: f.accountId,
      createdByMembershipId: f.membershipId,
      state: "submitted",
      submittedAt: NOW,
    });
    if (input.modelVersion !== 2)
      await tx.insert(appointments).values({
        id: appointmentId,
        contactId: f.contactId,
        propertyId: f.propertyId,
        partnerAccountId: f.accountId,
        type: "job",
        status: "requested",
        rescheduleToken: randomUUID(),
      });
    await tx.insert(partnerBookings).values({
      id,
      appointmentId: input.modelVersion === 2 ? null : appointmentId,
      modelVersion: input.modelVersion ?? 1,
      bookingDraftId: draftId,
      orgContactId: f.contactId,
      propertyId: f.propertyId,
      partnerAccountId: f.accountId,
      requestedByMembershipId: f.membershipId,
      publicStatus: input.status ?? "under_review",
      confirmationMode:
        input.status === "approval_needed" ? "approval" : "review",
      createdAt: input.createdAt ?? later(1),
      scopeSnapshot: {
        description: "Remove sample cabinet",
        serviceLabel: "Junk removal",
        preferredWindows: [
          {
            localDate: "2035-05-03",
            timeOfDay: "morning",
            timezone: "America/New_York",
          },
        ],
        locationSnapshot: {
          address: { line1: "1 Test Way", city: "Atlanta", state: "GA" },
        },
      },
    });
    if (input.bulkId)
      await tx.insert(partnerBulkImportRows).values({
        partnerAccountId: f.accountId,
        partnerBulkImportId: input.bulkId,
        rowNumber: input.row!,
        bookingDraftId: draftId,
        partnerBookingId: id,
        state: "created",
      });
  });
  return { id, appointmentId, draftId };
}
async function bulk(f: Fixture) {
  const id = randomUUID();
  await db.insert(partnerBulkImports).values({
    id,
    partnerAccountId: f.accountId,
    createdByMembershipId: f.membershipId,
    sourceFilename: "synthetic.csv",
    sourceSha256: "a".repeat(64),
    state: "processing",
    dryRun: false,
    rowCount: 3,
    validCount: 3,
  });
  return id;
}
async function groups(f: Fixture) {
  return db
    .select()
    .from(partnerOwnerAlertGroups)
    .where(eq(partnerOwnerAlertGroups.partnerAccountId, f.accountId));
}
async function operation(groupId: string, kind = "partner_request_initial") {
  const [row] = await db
    .select()
    .from(staffNotificationOperations)
    .where(
      and(
        eq(staffNotificationOperations.subjectId, groupId),
        eq(staffNotificationOperations.kind, kind),
      ),
    );
  if (!row) throw new Error("operation_missing");
  return row;
}
async function accept(id: string, at: Date) {
  expect(
    (
      await db.transaction((tx) =>
        prepareStaffNotificationDispatch(tx, {
          operationId: id,
          outboxEventId: randomUUID(),
          now: at,
        }),
      )
    ).kind,
  ).toBe("dispatch");
  await db.transaction((tx) =>
    finalizeStaffNotificationDispatch(tx, {
      operationId: id,
      outboxEventId: randomUUID(),
      result: {
        ok: true,
        provider: "twilio",
        providerMessageId: `SM${randomUUID().replaceAll("-", "")}`,
        deliveryCertainty: "accepted",
      },
      now: at,
    }),
  );
}

suite("durable owner service-request alerts in PostgreSQL", () => {
  beforeAll(async () => {
    db = getDb();
    process.env["NEXT_PUBLIC_SITE_URL"] = "https://example.test";
    process.env["PARTNER_PORTAL_V2_READS_ENABLED"] = "true";
    process.env["PARTNER_PORTAL_V2_WRITES_ENABLED"] = "true";
    process.env["PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED"] = "false";
    [savedSettings] = await db.select().from(partnerOwnerAlertSettings);
    await db
      .insert(teamRoles)
      .values({
        slug: "owner",
        name: "Owner",
        permissions: getDefaultPermissionsForRole("owner"),
      })
      .onConflictDoNothing();
    const [role] = await db
      .select()
      .from(teamRoles)
      .where(eq(teamRoles.slug, "owner"));
    if (!role) throw new Error("owner_role_missing");
    await db.insert(teamMembers).values({
      id: ownerId,
      name: "Synthetic owner",
      phoneE164: phone,
      roleId: role.id,
      active: true,
    });
  });
  beforeEach(async () => {
    await db
      .update(teamMembers)
      .set({ active: true, phoneE164: phone, permissionsDeny: [] })
      .where(eq(teamMembers.id, ownerId));
    await db
      .update(partnerOwnerAlertSettings)
      .set({
        enabled: true,
        ownerTeamMemberId: ownerId,
        phoneSnapshot: phone,
        enabledSince: NOW,
        revision: 1,
      })
      .where(eq(partnerOwnerAlertSettings.id, "owner"));
  });
  afterAll(async () => {
    await db
      .update(partnerOwnerAlertSettings)
      .set(savedSettings)
      .where(eq(partnerOwnerAlertSettings.id, "owner"));
    // The isolated, disposable test database retains scoped audit evidence; restore the singleton so other suites stay independent.
    await closeDbForTests();
  });
  it("repairs only historical fully approved unscheduled jobs, releasing obsolete holds without SMS", async () => {
    const f = await fixture();
    const approved = await job(f, { status: "approval_needed" }),
      pending = await job(f, { status: "approval_needed" }),
      declined = await job(f, { status: "approval_needed" }),
      scheduled = await job(f, { status: "approval_needed" }),
      unapproved = await job(f, { status: "approval_needed" });
    const holdId = randomUUID();
    await db.insert(appointmentHolds).values({
      id: holdId,
      partnerAccountId: f.accountId,
      partnerBookingDraftId: approved.draftId,
      requestedByMembershipId: f.membershipId,
      startAt: later(86_400_000),
      expiresAt: later(60_000),
      status: "active",
    });
    for (const [target, state] of [
      [approved, "approved_needs_reschedule"],
      [pending, "approved_needs_reschedule"],
      [pending, "pending"],
      [declined, "approved_needs_reschedule"],
      [declined, "declined"],
      [scheduled, "approved_needs_reschedule"],
    ] as const) {
      await db.insert(partnerApprovalRequests).values({
        partnerAccountId: f.accountId,
        partnerBookingId: target.id,
        requestedByMembershipId: f.membershipId,
        state,
        ruleSnapshot: [],
        requestSnapshot: {},
        requiredDecisionCount: 1,
        approvalHoldId: target.id === approved.id ? holdId : null,
      });
    }
    await db
      .update(appointments)
      .set({
        promisedArrivalStartAt: later(86_400_000),
        promisedArrivalEndAt: later(93_600_000),
        schedulePolicyRevision: "obsolete-held-policy",
      })
      .where(eq(appointments.id, approved.appointmentId));
    await db
      .update(appointments)
      .set({ status: "confirmed", startAt: later(86_400_000) })
      .where(eq(appointments.id, scheduled.appointmentId));
    const source = readFileSync(
      join(
        process.cwd(),
        "src/db/migrations/0175_partner_owner_request_alerts.sql",
      ),
      "utf8",
    );
    const repair = source
      .split(
        "-- BEGIN approved manual-review handoff repair (no notification backfill)",
      )[1]!
      .split("-- END approved manual-review handoff repair")[0]!;
    await db.execute(sql.raw(repair));
    const [changed] = await db
      .select()
      .from(partnerBookings)
      .where(eq(partnerBookings.id, approved.id));
    expect(changed!.publicStatus).toBe("under_review");
    expect(changed!.confirmationMode).toBe("review");
    expect(changed!.version).toBe(2);
    expect(changed!.arrivalWindowStartAt).toBeNull();
    const [repairedAppointment] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, approved.appointmentId));
    expect(repairedAppointment!.startAt).toBeNull();
    expect(repairedAppointment!.promisedArrivalStartAt).toBeNull();
    expect(repairedAppointment!.promisedArrivalEndAt).toBeNull();
    expect(repairedAppointment!.schedulePolicyRevision).toBeNull();
    for (const target of [pending, declined, scheduled, unapproved])
      expect(
        (
          await db
            .select()
            .from(partnerBookings)
            .where(eq(partnerBookings.id, target.id))
        )[0]!.publicStatus,
      ).toBe("approval_needed");
    expect(
      (
        await db
          .select()
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, holdId))
      )[0]!.status,
    ).toBe("released");
    expect(await groups(f)).toHaveLength(0);
    const events = await db
      .select()
      .from(partnerJobEvents)
      .where(eq(partnerJobEvents.partnerBookingId, approved.id));
    expect(events).toHaveLength(1);
    expect(events[0]!.actorType).toBe("system");
    expect(
      await db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.type, "partner.owner_alert.evaluate"),
            sql`${outboxEvents.payload}->>'accountId'=${f.accountId}`,
          ),
        ),
    ).toHaveLength(0);
    await db.execute(sql.raw(repair));
    expect(
      await db
        .select()
        .from(partnerJobEvents)
        .where(eq(partnerJobEvents.partnerBookingId, approved.id)),
    ).toHaveLength(1);
  });
  it("has no historical backfill and permits a non-notifying historical open", async () => {
    const f = await fixture(),
      old = await job(f, { createdAt: later(-1) }),
      fresh = await job(f);
    await evaluateOwnerAlert(
      { accountId: f.accountId, bookingId: old.id },
      later(10),
    );
    expect(await groups(f)).toHaveLength(0);
    const alreadyApproved = await job(f, { createdAt: later(-60_000) });
    await db.insert(partnerApprovalRequests).values({
      partnerAccountId: f.accountId,
      partnerBookingId: alreadyApproved.id,
      requestedByMembershipId: f.membershipId,
      state: "approved_needs_reschedule",
      ruleSnapshot: [],
      requestSnapshot: {},
      requiredDecisionCount: 1,
      resolvedAt: later(-1000),
      updatedAt: later(-1000),
    });
    await evaluateOwnerAlert(
      { accountId: f.accountId, bookingId: alreadyApproved.id },
      later(10),
    );
    expect(await groups(f)).toHaveLength(0);
    expect(
      await db.transaction((tx) =>
        markOwnerAlertOpened(tx, {
          ownerId,
          bookingId: old.id,
          now: later(20),
        }),
      ),
    ).toEqual({ opened: true });
    expect(await groups(f)).toHaveLength(0);
    await db
      .update(partnerOwnerAlertSettings)
      .set({ enabled: false, enabledSince: null })
      .where(eq(partnerOwnerAlertSettings.id, "owner"));
    await evaluateOwnerAlert(
      { accountId: f.accountId, bookingId: fresh.id },
      later(30),
    );
    expect(await groups(f)).toHaveLength(0);
  });
  it("remembers an owner opening before grouping without preventing the initial alert", async () => {
    const f = await fixture(),
      j = await job(f, { status: "approval_needed" });
    await db.transaction((tx) =>
      markOwnerAlertOpened(tx, { ownerId, bookingId: j.id, now: later(5) }),
    );
    await evaluateOwnerAlert(
      { accountId: f.accountId, bookingId: j.id },
      later(10),
    );
    expect(await groups(f)).toHaveLength(0);
    await db
      .update(partnerBookings)
      .set({ publicStatus: "under_review", confirmationMode: "review" })
      .where(eq(partnerBookings.id, j.id));
    await evaluateOwnerAlert(
      { accountId: f.accountId, bookingId: j.id },
      later(20),
    );
    const [g] = await groups(f);
    expect(g!.openedAt).not.toBeNull();
    const initial = await operation(g!.id);
    await accept(initial.id, later(30));
    await processOwnerAlertReminder(
      { groupId: g!.id },
      later(30 + OWNER_ALERT_REMINDER_MS),
    );
    expect(
      await db
        .select()
        .from(staffNotificationOperations)
        .where(eq(staffNotificationOperations.subjectId, g!.id)),
    ).toHaveLength(1);
  });
  it("keeps pricing and approval-ready alerts separate, including opens and reminders", async () => {
    const f = await fixture(),
      j = await job(f, { modelVersion: 2, status: "approval_needed" });
    await Promise.all(
      Array.from({ length: 3 }, () =>
        evaluateOwnerAlert(
          { accountId: f.accountId, bookingId: j.id },
          later(10),
        ),
      ),
    );
    const [pricing] = await groups(f);
    expect(pricing?.stage).toBe("pricing_review");
    const initial = await operation(pricing!.id);
    expect(initial.body).toContain("needs pricing");
    await accept(initial.id, later(20));
    await db.transaction((tx) =>
      markOwnerAlertOpened(tx, { ownerId, bookingId: j.id, now: later(30) }),
    );
    await db
      .update(partnerBookings)
      .set({ quotedTotalCents: 42000 })
      .where(eq(partnerBookings.id, j.id));
    await evaluateOwnerAlert(
      { accountId: f.accountId, bookingId: j.id },
      later(40),
    );
    expect(await groups(f)).toHaveLength(1);
    await db.insert(partnerApprovalRequests).values({
      partnerAccountId: f.accountId,
      partnerBookingId: j.id,
      requestedByMembershipId: f.membershipId,
      state: "approved_needs_reschedule",
      ruleSnapshot: [],
      requestSnapshot: {},
      requiredDecisionCount: 1,
      resolvedAt: later(50),
      updatedAt: later(50),
    });
    await db
      .update(partnerBookings)
      .set({ publicStatus: "under_review", confirmationMode: "review" })
      .where(eq(partnerBookings.id, j.id));
    await Promise.all(
      Array.from({ length: 3 }, () =>
        evaluateOwnerAlert(
          { accountId: f.accountId, bookingId: j.id },
          later(60),
        ),
      ),
    );
    const waves = await groups(f);
    expect(waves).toHaveLength(2);
    const ready = waves.find((group) => group.stage === "ready_to_schedule")!;
    expect(ready.openedAt).toBeNull();
    await expect(
      db
        .update(partnerOwnerAlertGroups)
        .set({ stage: "pricing_review" })
        .where(eq(partnerOwnerAlertGroups.id, ready.id)),
    ).rejects.toThrow();
    // Following the earlier pricing link does not acknowledge a later approval-ready alert.
    await db.transaction((tx) =>
      markOwnerAlertOpened(tx, {
        ownerId,
        groupId: pricing!.id,
        now: later(70),
      }),
    );
    expect(
      (await groups(f)).find((group) => group.id === ready.id)?.openedAt,
    ).toBeNull();
    await accept((await operation(ready.id)).id, later(80));
    await processOwnerAlertReminder(
      { groupId: pricing!.id },
      later(OWNER_ALERT_REMINDER_MS + 90),
    );
    expect(
      await db
        .select()
        .from(staffNotificationOperations)
        .where(eq(staffNotificationOperations.subjectId, pricing!.id)),
    ).toHaveLength(1);
    await Promise.all(
      Array.from({ length: 3 }, () =>
        processOwnerAlertReminder(
          { groupId: ready.id },
          later(OWNER_ALERT_REMINDER_MS + 90),
        ),
      ),
    );
    expect(
      await db
        .select()
        .from(staffNotificationOperations)
        .where(eq(staffNotificationOperations.subjectId, ready.id)),
    ).toHaveLength(2);
    await db.transaction((tx) =>
      markOwnerAlertOpened(tx, {
        ownerId,
        bookingId: j.id,
        now: later(OWNER_ALERT_REMINDER_MS + 100),
      }),
    );
    const reminder = await operation(ready.id, "partner_request_reminder");
    const decision = await db.transaction((tx) =>
      prepareStaffNotificationDispatch(tx, {
        operationId: reminder.id,
        outboxEventId: randomUUID(),
        now: later(OWNER_ALERT_REMINDER_MS + 110),
      }),
    );
    expect(decision.kind).not.toBe("dispatch");
  });
  it("suppresses a queued pricing text once pricing is complete without sending an unnecessary second alert", async () => {
    const f = await fixture(),
      j = await job(f, { modelVersion: 2 });
    await evaluateOwnerAlert(
      { accountId: f.accountId, bookingId: j.id },
      later(10),
    );
    const [pricing] = await groups(f);
    const initial = await operation(pricing!.id);
    await db
      .update(partnerBookings)
      .set({ quotedTotalCents: 25000 })
      .where(eq(partnerBookings.id, j.id));
    const decision = await db.transaction((tx) =>
      prepareStaffNotificationDispatch(tx, {
        operationId: initial.id,
        outboxEventId: randomUUID(),
        now: later(20),
      }),
    );
    expect(decision.kind).not.toBe("dispatch");
    await evaluateOwnerAlert(
      { accountId: f.accountId, bookingId: j.id },
      later(30),
    );
    expect(await groups(f)).toHaveLength(1);
  });
  it("creates a single group under duplicate concurrent wakeups, with a real generic subject", async () => {
    const f = await fixture(),
      j = await job(f);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        evaluateOwnerAlert(
          { accountId: f.accountId, bookingId: j.id },
          later(20),
        ),
      ),
    );
    const rows = await groups(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.memberCount).toBe(1);
    const op = await operation(rows[0]!.id);
    expect(op.appointmentId).toBeNull();
    expect(op.subjectType).toBe("partner_owner_group");
    expect(op.body).toContain("Who: Synthetic requester");
    expect(op.body).toContain("p_alert=");
    await expect(
      db
        .update(partnerOwnerAlertGroups)
        .set({ memberCount: 2 })
        .where(eq(partnerOwnerAlertGroups.id, rows[0]!.id)),
    ).rejects.toThrow();
  });
  it("waits for bulk processing to settle then creates immutable waves only for newly ready jobs", async () => {
    const f = await fixture(),
      bulkId = await bulk(f),
      first = await job(f, { bulkId, row: 1 }),
      second = await job(f, { bulkId, row: 2 }),
      laterJob = await job(f, { bulkId, row: 3, status: "approval_needed" });
    await evaluateOwnerAlert({ accountId: f.accountId, bulkImportId: bulkId });
    expect(await groups(f)).toHaveLength(0);
    await db
      .update(partnerBulkImports)
      .set({ state: "completed", completedAt: later(10) })
      .where(eq(partnerBulkImports.id, bulkId));
    await Promise.all([
      evaluateOwnerAlert(
        { accountId: f.accountId, bulkImportId: bulkId },
        later(20),
      ),
      evaluateOwnerAlert(
        { accountId: f.accountId, bulkImportId: bulkId },
        later(20),
      ),
    ]);
    const [initial] = await groups(f);
    expect(initial?.memberCount).toBe(2);
    await db.transaction((tx) =>
      markOwnerAlertOpened(tx, {
        ownerId,
        bookingId: first.id,
        now: later(30),
      }),
    );
    expect((await groups(f))[0]?.openedAt).toBeNull();
    await db.transaction((tx) =>
      markOwnerAlertOpened(tx, {
        ownerId,
        bookingId: second.id,
        now: later(40),
      }),
    );
    expect((await groups(f))[0]?.openedAt).not.toBeNull();
    await db
      .update(partnerBookings)
      .set({ publicStatus: "under_review", confirmationMode: "review" })
      .where(eq(partnerBookings.id, laterJob.id));
    await db.transaction((tx) =>
      enqueueOwnerAlertEvaluation(tx, {
        accountId: f.accountId,
        bookingId: laterJob.id,
        afterApproval: true,
        now: later(100),
      }),
    );
    const events = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.type, "partner.owner_alert.evaluate"),
          sql`${outboxEvents.payload}->>'accountId'=${f.accountId}`,
        ),
      );
    expect(events[0]?.nextAttemptAt?.getTime()).toBe(later(60100).getTime());
    expect(events[0]?.payload["bulkImportId"]).toBe(bulkId);
    await evaluateOwnerAlert(events[0]!.payload, later(60100));
    const waves = await groups(f);
    expect(waves.map((x) => x.memberCount).sort()).toEqual([1, 2]);
    expect(waves.find((x) => x.id !== initial!.id)?.openedAt).toBeNull();
    await evaluateOwnerAlert(events[0]!.payload, later(61000));
    expect(await groups(f)).toHaveLength(2);
  });
  it("starts one reminder only 30 minutes after provider acceptance, even following a worker outage", async () => {
    const f = await fixture(),
      j = await job(f);
    await evaluateOwnerAlert(
      { accountId: f.accountId, bookingId: j.id },
      later(10),
    );
    const [g] = await groups(f);
    const initial = await operation(g!.id);
    expect(g!.reminderDueAt).toBeNull();
    const acceptedAt = later(4 * 60 * 60_000);
    await accept(initial.id, acceptedAt);
    const [accepted] = await groups(f);
    expect(accepted!.reminderDueAt!.getTime()).toBe(
      acceptedAt.getTime() + OWNER_ALERT_REMINDER_MS,
    );
    await processOwnerAlertReminder(
      { groupId: g!.id },
      new Date(acceptedAt.getTime() + OWNER_ALERT_REMINDER_MS - 1),
    );
    expect(
      await db
        .select()
        .from(staffNotificationOperations)
        .where(
          and(
            eq(staffNotificationOperations.subjectId, g!.id),
            eq(staffNotificationOperations.kind, "partner_request_reminder"),
          ),
        ),
    ).toHaveLength(0);
    await Promise.all([
      processOwnerAlertReminder({ groupId: g!.id }, accepted!.reminderDueAt!),
      processOwnerAlertReminder({ groupId: g!.id }, accepted!.reminderDueAt!),
    ]);
    const reminder = await operation(g!.id, "partner_request_reminder");
    expect(reminder.state).toBe("requested");
    await db.transaction((tx) =>
      markOwnerAlertOpened(tx, {
        ownerId,
        groupId: g!.id,
        now: accepted!.reminderDueAt!,
      }),
    );
    expect(
      await db.transaction((tx) =>
        prepareStaffNotificationDispatch(tx, {
          operationId: reminder.id,
          outboxEventId: randomUUID(),
          now: accepted!.reminderDueAt!,
        }),
      ),
    ).toEqual({ kind: "terminal", state: "suppressed" });
  });
  it("does not regroup or remind when initial delivery is uncertain", async () => {
    const f = await fixture(),
      j = await job(f);
    await evaluateOwnerAlert(
      { accountId: f.accountId, bookingId: j.id },
      later(10),
    );
    const [g] = await groups(f);
    const initial = await operation(g!.id);
    await db.transaction((tx) =>
      prepareStaffNotificationDispatch(tx, {
        operationId: initial.id,
        outboxEventId: randomUUID(),
        now: later(20),
      }),
    );
    await db.transaction((tx) =>
      finalizeStaffNotificationDispatch(tx, {
        operationId: initial.id,
        outboxEventId: randomUUID(),
        result: {
          ok: false,
          provider: "twilio",
          deliveryCertainty: "uncertain",
          detail: "provider_timeout",
        },
        now: later(30),
      }),
    );
    await evaluateOwnerAlert(
      { accountId: f.accountId, bookingId: j.id },
      later(50),
    );
    expect(await groups(f)).toHaveLength(1);
    expect((await groups(f))[0]!.reminderDueAt).toBeNull();
    await processOwnerAlertReminder({ groupId: g!.id }, later(3_600_000));
    expect(
      await db
        .select()
        .from(staffNotificationOperations)
        .where(eq(staffNotificationOperations.subjectId, g!.id)),
    ).toHaveLength(1);
  });
  it.each(["resolved", "phone", "revoked", "disabled"])(
    "rechecks %s immediately when claiming delivery",
    async (reason) => {
      const f = await fixture(),
        j = await job(f);
      await evaluateOwnerAlert(
        { accountId: f.accountId, bookingId: j.id },
        later(10),
      );
      const op = await operation((await groups(f))[0]!.id);
      if (reason === "resolved")
        await db
          .update(partnerBookings)
          .set({ publicStatus: "canceled" })
          .where(eq(partnerBookings.id, j.id));
      if (reason === "phone")
        await db
          .update(teamMembers)
          .set({ phoneE164: "+15550000001" })
          .where(eq(teamMembers.id, ownerId));
      if (reason === "revoked")
        await db
          .update(teamMembers)
          .set({ permissionsDeny: ["appointments.read"] })
          .where(eq(teamMembers.id, ownerId));
      if (reason === "disabled")
        await db
          .update(partnerOwnerAlertSettings)
          .set({ enabled: false, enabledSince: null })
          .where(eq(partnerOwnerAlertSettings.id, "owner"));
      const result = await db.transaction((tx) =>
        prepareStaffNotificationDispatch(tx, {
          operationId: op.id,
          outboxEventId: randomUUID(),
          now: later(20),
        }),
      );
      expect(result.kind).toBe("terminal");
      expect(
        result.kind === "terminal" &&
          ["suppressed", "failed"].includes(result.state),
      ).toBe(true);
    },
  );
  it("requires the configured owner for opened/test, masks phone, and validates settings revision", async () => {
    const f = await fixture(),
      j = await job(f);
    await evaluateOwnerAlert(
      { accountId: f.accountId, bookingId: j.id },
      later(10),
    );
    const g = (await groups(f))[0]!;
    await expect(
      db.transaction((tx) =>
        markOwnerAlertOpened(tx, { ownerId: randomUUID(), groupId: g.id }),
      ),
    ).rejects.toThrow("configured owner");
    await expect(
      db.transaction((tx) => queueOwnerAlertTest(tx, randomUUID(), "1")),
    ).rejects.toThrow();
    await expect(
      db.transaction((tx) =>
        changeOwnerAlertSettings(tx, {
          enabled: false,
          ownerTeamMemberId: ownerId,
          expectedVersion: "999",
        }),
      ),
    ).rejects.toThrow();
    const data = await ownerAlertSettingsDto(true);
    expect(JSON.stringify(data)).not.toContain(phone);
    expect(data.settings.phoneLastFour).toBe(phone.slice(-4));
    const test = await db.transaction((tx) =>
      queueOwnerAlertTest(tx, ownerId, "1", later(10)),
    );
    expect(test.state).toBe("queued");
    const [op] = await db
      .select()
      .from(staffNotificationOperations)
      .where(eq(staffNotificationOperations.id, test.operationId!));
    expect(op!.appointmentId).toBeNull();
    expect(op!.subjectType).toBe("partner_owner_test");
    expect(op!.body.startsWith("TEST")).toBe(true);
  });
  it.each([1, -60_000])(
    "moves final company approval into staff review and alerts once for booking created %i ms from activation",
    async (createdOffset) => {
      const f = await fixture(),
        j = await job(f, {
          status: "approval_needed",
          createdAt: later(createdOffset),
        }),
        approverUser = randomUUID(),
        approverMembership = randomUUID(),
        approvalId = randomUUID();
      const [role] = await db
        .select()
        .from(partnerRoleTemplates)
        .where(
          and(
            eq(partnerRoleTemplates.key, "billing_approver"),
            isNull(partnerRoleTemplates.partnerAccountId),
          ),
        );
      await db.insert(partnerUsers).values({
        id: approverUser,
        name: "Synthetic approver",
        email: `${approverUser}@example.test`,
        normalizedEmail: `${approverUser}@example.test`,
        active: true,
        identityStatus: "active",
        emailVerifiedAt: NOW,
      });
      await db.insert(partnerAccountMemberships).values({
        id: approverMembership,
        partnerAccountId: f.accountId,
        partnerUserId: approverUser,
        roleKey: "billing_approver",
        roleTemplateId: role!.id,
        status: "active",
        accessLevel: "account",
        acceptedAt: NOW,
      });
      await db.insert(partnerApprovalRequests).values({
        id: approvalId,
        partnerAccountId: f.accountId,
        partnerBookingId: j.id,
        requestedByMembershipId: f.membershipId,
        state: "pending",
        ruleSnapshot: [
          {
            id: randomUUID(),
            name: "Owner test approval",
            version: 1,
            requiredApproverCapabilities: ["approvals.decide"],
            requiredApproverRoleKeys: ["billing_approver"],
            requiredDecisionCount: 1,
          },
        ],
        requestSnapshot: {},
        requiredDecisionCount: 1,
      });
      await evaluateOwnerAlert(
        { accountId: f.accountId, bookingId: j.id },
        later(10),
      );
      expect(await groups(f)).toHaveLength(0);
      const access = (await loadActiveMembershipAccesses(approverUser))[0]!;
      const view = await getPartnerApprovalRequest({
        accountId: f.accountId,
        membershipId: approverMembership,
        requestId: approvalId,
        access,
      });
      expect(view.ok).toBe(true);
      const result = await decidePartnerApprovalRequest({
        accountId: f.accountId,
        membershipId: approverMembership,
        partnerUserId: approverUser,
        email: `${approverUser}@example.test`,
        roleKey: "billing_approver",
        sessionId: randomUUID(),
        correlationId: "owner-alert-approval",
        idempotencyKeyHash: randomUUID().replaceAll("-", "").repeat(2),
        requestId: approvalId,
        ifMatch: view.ok ? view.etag : null,
        decision: "approved",
        reason: "Approve synthetic request",
        now: later(20),
      });
      expect(result.status).toBe(200);
      const [saved] = await db
        .select()
        .from(partnerBookings)
        .where(eq(partnerBookings.id, j.id));
      expect(saved!.publicStatus).toBe("under_review");
      expect(saved!.confirmationMode).toBe("review");
      expect(saved!.arrivalWindowStartAt).toBeNull();
      const [appointment] = await db
        .select()
        .from(appointments)
        .where(eq(appointments.id, j.appointmentId));
      expect(appointment!.status).toBe("requested");
      expect(appointment!.startAt).toBeNull();
      expect(appointment!.promisedArrivalStartAt).toBeNull();
      expect(appointment!.promisedArrivalEndAt).toBeNull();
      expect(appointment!.schedulePolicyRevision).toBeNull();
      const events = await db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.type, "partner.owner_alert.evaluate"),
            sql`${outboxEvents.payload}->>'bookingId'=${j.id}`,
          ),
        );
      expect(events).toHaveLength(1);
      await evaluateOwnerAlert(events[0]!.payload, later(25));
      expect(await groups(f)).toHaveLength(1);
      await evaluateOwnerAlert(events[0]!.payload, later(30));
      expect(await groups(f)).toHaveLength(1);
      expect(
        await db
          .select()
          .from(staffNotificationOperations)
          .where(
            eq(staffNotificationOperations.subjectId, (await groups(f))[0]!.id),
          ),
      ).toHaveLength(1);
    },
  );
});

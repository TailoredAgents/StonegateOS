import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  appointments,
  appointmentHolds,
  closeDbForTests,
  contacts,
  getDb,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccounts,
  partnerBookings,
  partnerBookingDrafts,
  partnerRecurringOccurrences,
  partnerRecurringSeries,
  partnerServiceCatalog,
  partnerServiceTemplates,
  partnerUsers,
  properties,
  teamMembers,
  teamRoles,
} from "@/db";
import {
  applyPartnerServiceTemplate,
  getPartnerServiceTemplate,
  listPartnerServiceTemplates,
  updatePartnerServiceTemplate,
  evaluateClaimedPartnerRecurringOccurrence,
} from "@/lib/partner-repeat-work";
import {
  createPartnerBookingDraft,
  submitPartnerBookingDraft,
} from "@/lib/partner-portal-v2-scheduling/service";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import type { PartnerSchedulingActor } from "@/lib/partner-portal-v2-scheduling";
import { normalizePartnerAccountWorkflow } from "@/lib/partner-account-workflows";
import { updatePartnerWorkflowAsStaff } from "@/lib/partner-relationship-management";
import type { TeamMutationContext } from "@/lib/team-mutation";
import { createPortalV2StrongEtag } from "@/lib/portal-v2-contract";

const local =
  process.env["DATABASE_URL"] &&
  ["localhost", "127.0.0.1"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;
const db = () => getDb();
const templateEtag = (id: string, version: number) =>
  createPortalV2StrongEtag(`partner-service-template:${id}:${version}`);
async function fixture() {
  const accountId = randomUUID(),
    userId = randomUUID(),
    membershipId = randomUUID();
  const locationId = randomUUID(),
    hiddenLocationId = randomUUID(),
    staffId = randomUUID(),
    staffRoleId = randomUUID();
  const serviceKey = "maintenance_" + randomUUID().replaceAll("-", "");
  await db().transaction(async (tx) => {
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: "Local template maintenance " + accountId,
      normalizedName: accountId,
      portalAccessEnabled: true,
      portalWorkflowConfig: { tools: { templates: true, recurring: true } },
    });
    await tx.insert(partnerUsers).values({
      id: userId,
      email: userId + "@example.test",
      normalizedEmail: userId + "@example.test",
      name: "Local maintenance partner",
      active: true,
      identityStatus: "active",
    });
    await tx.insert(partnerAccountMemberships).values({
      id: membershipId,
      partnerAccountId: accountId,
      partnerUserId: userId,
      roleKey: "operations",
      status: "active",
      accessLevel: "account",
      acceptedAt: new Date(),
    });
    await tx.insert(partnerAccountLocations).values(
      [locationId, hiddenLocationId].map((id) => ({
        id,
        partnerAccountId: accountId,
        siteName: "Site " + id,
        addressLine1: "1 Local Way",
        city: "Atlanta",
        state: "GA",
        postalCode: "30301",
        active: true,
      })),
    );
    await tx.insert(partnerServiceCatalog).values({
      key: serviceKey,
      label: "Local service",
      description: "Local test service",
    });
    await tx.insert(teamRoles).values({
      id: staffRoleId,
      slug: "maintenance-" + staffRoleId,
      name: "Local maintenance staff",
      permissions: ["partners.accounts.manage"],
    });
    await tx.insert(teamMembers).values({
      id: staffId,
      roleId: staffRoleId,
      name: "Local maintenance staff",
      email: staffId + "@example.test",
      active: true,
    });
  });
  const actor: PartnerSchedulingActor = {
    accountId,
    membershipId,
    partnerUserId: userId,
    email: userId + "@example.test",
    sessionId: randomUUID(),
    accessLevel: "account",
    canReadRates: false,
    locationIds: [],
    propertyIds: [],
  };
  const mutation = {
    actor: {
      type: "human",
      id: staffId,
      label: "Local maintenance staff",
      authMethod: "team_session",
      sessionId: randomUUID(),
    },
    correlationId: "local-template-maintenance",
    idempotencyKeyHash: randomUUID().replaceAll("-", "").repeat(2),
    expectedVersion: "1",
  } as TeamMutationContext;
  return {
    accountId,
    userId,
    membershipId,
    locationId,
    hiddenLocationId,
    staffId,
    staffRoleId,
    serviceKey,
    actor,
    mutation,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function template(
  f: Fixture,
  name: string,
  options: { active?: boolean; locationId?: string | null } = {},
) {
  const id = randomUUID();
  await db()
    .insert(partnerServiceTemplates)
    .values({
      id,
      partnerAccountId: f.accountId,
      name,
      active: options.active ?? true,
      locationId:
        options.locationId === undefined ? f.locationId : options.locationId,
      serviceKey: f.serviceKey,
      createdByMembershipId: f.membershipId,
      templateData: {
        schemaVersion: 1,
        tierKey: null,
        scope: { quantity: 1 },
        description: "Synthetic service scope",
        crewInstructions: null,
        onSiteContact: null,
        proofRequirements: { before: 1, after: 1 },
        selectedAddOns: [],
      },
    });
  return id;
}
function update(
  f: Fixture,
  id: string,
  version: number,
  changes: { active?: boolean; name?: string },
  key = randomUUID(),
  actor = f.actor,
) {
  return updatePartnerServiceTemplate({
    actor,
    templateId: id,
    ...changes,
    ifMatch: templateEtag(id, version),
    idempotencyKeyHash: key,
    correlationId: "local-template-maintenance",
  });
}
async function workflow(
  f: Fixture,
  version = "1",
  enabled = false,
  confirmPauseRecurring?: boolean,
) {
  return db().transaction((tx) =>
    updatePartnerWorkflowAsStaff(
      tx,
      { ...f.mutation, expectedVersion: version },
      f.accountId,
      {
        ...normalizePartnerAccountWorkflow({
          tools: { templates: true, recurring: enabled },
        }),
        ...(confirmPauseRecurring === undefined
          ? {}
          : { confirmPauseRecurring }),
      },
    ),
  );
}
async function recurring(f: Fixture) {
  const id = randomUUID(),
    contactId = randomUUID(),
    propertyId = randomUUID(),
    appointmentId = randomUUID(),
    jobId = randomUUID();
  const startsAt = new Date("2035-07-02T14:00:00.000Z");
  await db().transaction(async (tx) => {
    await tx
      .insert(contacts)
      .values({ id: contactId, firstName: "Local", lastName: "Maintenance" });
    await tx.insert(properties).values({
      id: propertyId,
      contactId,
      addressLine1: "2 Local Way",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
    });
    await tx.insert(appointments).values({
      id: appointmentId,
      partnerAccountId: f.accountId,
      contactId,
      propertyId,
      type: "job",
      status: "confirmed",
      startAt: startsAt,
      rescheduleToken: randomUUID(),
    });
    await tx.insert(partnerBookings).values({
      id: jobId,
      partnerAccountId: f.accountId,
      orgContactId: contactId,
      propertyId,
      appointmentId,
      publicStatus: "confirmed",
    });
    await tx.insert(partnerRecurringSeries).values({
      id,
      partnerAccountId: f.accountId,
      locationId: f.locationId,
      name: "Local future service",
      recurrenceRule: JSON.stringify({
        frequency: "weekly",
        occurrenceCount: 5,
      }),
      startsOn: "2035-07-01",
      endsOn: "2035-08-01",
      createdByMembershipId: f.membershipId,
      state: "active",
    });
    await tx.insert(partnerRecurringOccurrences).values(
      ["tentative", "confirmed", "evaluating", "review", "failed"].map(
        (state, index) => ({
          partnerAccountId: f.accountId,
          recurringSeriesId: id,
          localDate: `2035-07-0${index + 1}`,
          state,
          ...(state === "confirmed" ? { partnerBookingId: jobId } : {}),
        }),
      ),
    );
  });
  return { id, jobId, appointmentId, startsAt };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitForAdvisoryWaiter(key: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await db().execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_locks where locktype='advisory' and objid=hashtext(${key})::oid and not granted`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected a real advisory-lock waiter: " + key);
}

async function claimedOccurrenceFixture() {
  const f = await fixture(),
    series = await recurring(f),
    templateId = await template(f, "In-flight recurring scope");
  await db()
    .update(partnerAccounts)
    .set({
      portalWorkflowConfig: {
        tools: { templates: true, recurring: true },
        requestableServiceKeys: [f.serviceKey],
      },
    })
    .where(eq(partnerAccounts.id, f.accountId));
  await db()
    .update(partnerRecurringSeries)
    .set({ templateId })
    .where(eq(partnerRecurringSeries.id, series.id));
  const [occurrence] = await db()
    .update(partnerRecurringOccurrences)
    .set({ state: "evaluating", evaluatedAt: new Date("2035-06-30T12:00:00Z") })
    .where(
      and(
        eq(partnerRecurringOccurrences.recurringSeriesId, series.id),
        eq(partnerRecurringOccurrences.localDate, "2035-07-01"),
      ),
    )
    .returning();
  if (!occurrence) throw new Error("Local occurrence missing");
  return { f, series, occurrence };
}

async function assertNoNewRecurringWork(f: Fixture, occurrenceId: string) {
  const [occurrence] = await db()
    .select()
    .from(partnerRecurringOccurrences)
    .where(eq(partnerRecurringOccurrences.id, occurrenceId));
  expect(occurrence).toMatchObject({
    state: "skipped",
    failureCode: "series_paused",
    partnerBookingId: null,
  });
  expect(
    await db()
      .select()
      .from(partnerBookings)
      .where(eq(partnerBookings.partnerAccountId, f.accountId)),
  ).toHaveLength(1); // pre-existing confirmed fixture job only
  expect(
    await db()
      .select()
      .from(appointments)
      .where(eq(appointments.partnerAccountId, f.accountId)),
  ).toHaveLength(1);
  expect(
    await db()
      .select()
      .from(appointmentHolds)
      .where(
        and(
          eq(appointmentHolds.partnerAccountId, f.accountId),
          eq(appointmentHolds.status, "active"),
        ),
      ),
  ).toHaveLength(0);
  return occurrence!;
}

// Every fixture is confined to disposable localhost PostgreSQL. Commit fixtures
// so independent transactions exercise the actual constraints and locking.
suite(
  "saved-template history and optional-tool maintenance / real PostgreSQL",
  () => {
    afterAll(async () => closeDbForTests());
    it("searches active and archived history with cursor isolation and no repeated or foreign rows", async () => {
      const f = await fixture(),
        foreign = await fixture();
      const a = await template(f, "Alpha cleanout"),
        b = await template(f, "Beta CLEANOUT", { active: false }),
        c = await template(f, "Gamma cleanout");
      await template(f, "Other service");
      await template(foreign, "Foreign cleanout");
      const first = await listPartnerServiceTemplates({
        actor: f.actor,
        params: new URLSearchParams({ q: "cLeAnOuT", limit: "2" }),
      });
      expect(first.templates.map((item) => item.id)).toEqual([a, b]);
      expect(first.templates[1]?.active).toBe(false);
      expect(first.nextCursor).toBeTruthy();
      const second = await listPartnerServiceTemplates({
        actor: f.actor,
        params: new URLSearchParams({
          q: "cLeAnOuT",
          limit: "2",
          cursor: first.nextCursor!,
        }),
      });
      expect(second.templates.map((item) => item.id)).toEqual([c]);
      expect(second.nextCursor).toBeNull();
      const archived = await listPartnerServiceTemplates({
        actor: f.actor,
        params: new URLSearchParams({ state: "archived" }),
      });
      expect(archived.templates.map((item) => item.id)).toEqual([b]);
      for (const actor of [
        foreign.actor,
        { ...f.actor, membershipId: randomUUID() },
        {
          ...f.actor,
          accessLevel: "scoped" as const,
          locationIds: [f.locationId],
        },
      ]) {
        await expect(
          listPartnerServiceTemplates({
            actor,
            params: new URLSearchParams({
              q: "cLeAnOuT",
              limit: "2",
              cursor: first.nextCursor!,
            }),
          }),
        ).rejects.toMatchObject({ code: "invalid_cursor" });
      }
      await expect(
        listPartnerServiceTemplates({
          actor: f.actor,
          params: new URLSearchParams({
            q: "different",
            limit: "2",
            cursor: first.nextCursor!,
          }),
        }),
      ).rejects.toMatchObject({ code: "invalid_cursor" });
    });
    it("keeps scoped history and direct read/update access inside permitted locations and account", async () => {
      const f = await fixture(),
        foreign = await fixture();
      const visible = await template(f, "Visible shortcut"),
        hidden = await template(f, "Hidden shortcut", {
          locationId: f.hiddenLocationId,
        }),
        foreignId = await template(foreign, "Foreign shortcut");
      const actor = {
        ...f.actor,
        accessLevel: "scoped" as const,
        locationIds: [f.locationId],
      };
      expect(
        (await listPartnerServiceTemplates({ actor })).templates.map(
          (item) => item.id,
        ),
      ).toEqual([visible]);
      for (const id of [hidden, foreignId]) {
        await expect(
          getPartnerServiceTemplate({ actor, templateId: id }),
        ).rejects.toMatchObject({ code: "not_found", status: 404 });
        await expect(
          update(f, id, 1, { active: false }, randomUUID(), actor),
        ).rejects.toMatchObject({ code: "not_found", status: 404 });
      }
    });
    it("does not let a scoped member substitute an unbound account-wide template", async () => {
      const f = await fixture(),
        id = await template(f, "Legacy unbound shortcut", { locationId: null });
      const actor = {
        ...f.actor,
        accessLevel: "scoped" as const,
        locationIds: [f.locationId],
      };
      expect((await listPartnerServiceTemplates({ actor })).templates).toEqual(
        [],
      );
      await expect(
        getPartnerServiceTemplate({ actor, templateId: id }),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
      await expect(
        update(f, id, 1, { active: false }, randomUUID(), actor),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
    });
    it("archives and restores revision-safely, retains history and replays an identical archive once", async () => {
      const f = await fixture(),
        id = await template(f, "Restore this shortcut"),
        key = randomUUID();
      const archived = await update(f, id, 1, { active: false }, key);
      expect(archived.template.active).toBe(false);
      expect(archived.template.version).toBe(2);
      expect((await update(f, id, 1, { active: false }, key)).replayed).toBe(
        true,
      );
      await expect(update(f, id, 1, { active: true })).rejects.toMatchObject({
        code: "revision_mismatch",
        status: 412,
      });
      expect(
        (await listPartnerServiceTemplates({ actor: f.actor })).templates[0]
          ?.id,
      ).toBe(id);
      const restored = await update(f, id, 2, { active: true });
      expect(restored.template.active).toBe(true);
      expect(restored.template.version).toBe(3);
    });
    it("returns a recoverable conflict when restoring a name now used by another active shortcut", async () => {
      const f = await fixture(),
        archived = await template(f, "Same name", { active: false });
      await template(f, "Same name");
      await expect(
        update(f, archived, 1, { active: true }),
      ).rejects.toMatchObject({ code: "conflict", status: 409 });
      expect(
        (
          await db()
            .select()
            .from(partnerServiceTemplates)
            .where(eq(partnerServiceTemplates.id, archived))
        )[0]?.active,
      ).toBe(false);
    });
    it("permits history and cleanup when templates are disabled, but cannot restore, rename or apply them", async () => {
      const f = await fixture(),
        id = await template(f, "Disabled tool history");
      await db()
        .update(partnerAccounts)
        .set({
          portalWorkflowConfig: {
            tools: { templates: false, recurring: false },
          },
        })
        .where(eq(partnerAccounts.id, f.accountId));
      expect(
        (await listPartnerServiceTemplates({ actor: f.actor })).templates[0]
          ?.id,
      ).toBe(id);
      expect(
        (await getPartnerServiceTemplate({ actor: f.actor, templateId: id }))
          .id,
      ).toBe(id);
      expect((await update(f, id, 1, { active: false })).active).toBe(false);
      await expect(update(f, id, 2, { active: true })).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(update(f, id, 2, { name: "Renamed" })).rejects.toMatchObject(
        { code: "not_found" },
      );
      await expect(
        applyPartnerServiceTemplate({
          actor: f.actor,
          templateId: id,
          idempotencyKeyHash: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(
        (
          await listPartnerServiceTemplates({
            actor: f.actor,
            params: new URLSearchParams({ state: "archived" }),
          })
        ).templates[0]?.id,
      ).toBe(id);
    });
    it("requires explicit staff confirmation before disabling recurring work and changes nothing on refusal", async () => {
      const f = await fixture(),
        series = await recurring(f);
      await expect(workflow(f)).rejects.toThrow(
        /Confirm.*pauses future tentative/u,
      );
      expect(
        (
          await db()
            .select()
            .from(partnerAccounts)
            .where(eq(partnerAccounts.id, f.accountId))
        )[0]?.portalWorkflowRevision,
      ).toBe(1);
      expect(
        (
          await db()
            .select()
            .from(partnerRecurringSeries)
            .where(eq(partnerRecurringSeries.id, series.id))
        )[0]?.state,
      ).toBe("active");
      expect(
        (
          await db()
            .select()
            .from(partnerRecurringOccurrences)
            .where(eq(partnerRecurringOccurrences.recurringSeriesId, series.id))
        ).filter((row) => row.state === "skipped"),
      ).toHaveLength(0);
    });
    it("pauses only the selected account's active series, skips unconfirmed tentative work, and preserves accepted jobs", async () => {
      const f = await fixture(),
        foreign = await fixture(),
        series = await recurring(f),
        other = await recurring(foreign);
      await db()
        .insert(partnerRecurringOccurrences)
        .values([
          {
            partnerAccountId: f.accountId,
            recurringSeriesId: series.id,
            localDate: "2000-01-01",
            state: "tentative",
          },
          {
            partnerAccountId: f.accountId,
            recurringSeriesId: series.id,
            localDate: "2000-01-02",
            state: "evaluating",
          },
        ]);
      const saved = await workflow(f, "1", false, true);
      expect(saved.version).toBe("2");
      expect(saved.config.tools.recurring).toBe(false);
      expect(saved.config).not.toHaveProperty("confirmPauseRecurring");
      const rows = await db()
        .select()
        .from(partnerRecurringOccurrences)
        .where(eq(partnerRecurringOccurrences.recurringSeriesId, series.id));
      expect(rows.filter((row) => row.state === "skipped")).toHaveLength(2);
      expect(rows.find((row) => row.localDate === "2000-01-01")?.state).toBe(
        "tentative",
      );
      expect(rows.find((row) => row.localDate === "2000-01-02")?.state).toBe(
        "evaluating",
      );
      expect(rows.find((row) => row.localDate === "2035-07-02")?.state).toBe(
        "confirmed",
      );
      expect(rows.find((row) => row.localDate === "2035-07-04")?.state).toBe(
        "review",
      );
      expect(rows.find((row) => row.localDate === "2035-07-05")?.state).toBe(
        "failed",
      );
      const [appointment] = await db()
        .select()
        .from(appointments)
        .where(eq(appointments.id, series.appointmentId));
      expect(appointment?.status).toBe("confirmed");
      expect(appointment?.startAt).toEqual(series.startsAt);
      expect(
        (
          await db()
            .select()
            .from(partnerBookings)
            .where(eq(partnerBookings.id, series.jobId))
        )[0]?.publicStatus,
      ).toBe("confirmed");
      expect(
        (
          await db()
            .select()
            .from(partnerRecurringSeries)
            .where(eq(partnerRecurringSeries.id, other.id))
        )[0]?.state,
      ).toBe("active");
      expect(
        (
          await db()
            .select()
            .from(partnerRecurringOccurrences)
            .where(eq(partnerRecurringOccurrences.recurringSeriesId, other.id))
        ).filter((row) => row.state === "skipped"),
      ).toHaveLength(0);
      await workflow(f, "2", true);
      expect(
        (
          await db()
            .select()
            .from(partnerRecurringSeries)
            .where(eq(partnerRecurringSeries.id, series.id))
        )[0]?.state,
      ).toBe("paused");
    });
    it("uses each series' local date rather than UTC when deciding which unconfirmed occurrences are still upcoming", async () => {
      const f = await fixture(),
        east = await recurring(f),
        west = await recurring(f);
      await db()
        .update(partnerRecurringSeries)
        .set({ timezone: "Pacific/Kiritimati" })
        .where(eq(partnerRecurringSeries.id, east.id));
      await db()
        .update(partnerRecurringSeries)
        .set({ timezone: "Etc/GMT+10" })
        .where(eq(partnerRecurringSeries.id, west.id));
      const dates = await db().execute<{ local_date: string }>(
        sql`select (now() at time zone 'Etc/GMT+10')::date::text as local_date`,
      );
      const localDate = dates[0]!.local_date;
      await db()
        .insert(partnerRecurringOccurrences)
        .values(
          [east, west].map((series) => ({
            partnerAccountId: f.accountId,
            recurringSeriesId: series.id,
            localDate,
            state: "tentative",
          })),
        );
      await workflow(f, "1", false, true);
      const rows = await db()
        .select()
        .from(partnerRecurringOccurrences)
        .where(eq(partnerRecurringOccurrences.partnerAccountId, f.accountId));
      expect(
        rows.find(
          (row) =>
            row.recurringSeriesId === east.id && row.localDate === localDate,
        )?.state,
      ).toBe("tentative");
      expect(
        rows.find(
          (row) =>
            row.recurringSeriesId === west.id && row.localDate === localDate,
        )?.state,
      ).toBe("skipped");
    });
    it("contains an actual worker already evaluating before staff disables recurring, preserving its skipped result and accepting no new job", async () => {
      const { f, series, occurrence } = await claimedOccurrenceFixture();
      const entered = deferred(),
        release = deferred();
      const blocker = db().transaction(async (tx) => {
        await acquireScheduleConflictLock(tx);
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      let worker: Promise<unknown> | undefined,
        containment: Promise<unknown> | undefined;
      try {
        worker = evaluateClaimedPartnerRecurringOccurrence({
          actor: f.actor,
          seriesId: series.id,
          occurrenceId: occurrence.id,
          correlationId: "local-recurring-worker-race",
          now: new Date("2035-06-30T12:00:00Z"),
        });
        // The worker has read the active series and holds claim coordination;
        // it is now genuinely blocked on the controller's schedule lock.
        await waitForAdvisoryWaiter("appointment_schedule_conflict_v1");
        containment = db().transaction((tx) =>
          updatePartnerWorkflowAsStaff(tx, f.mutation, f.accountId, {
            ...normalizePartnerAccountWorkflow({
              tools: { templates: true, recurring: false },
              requestableServiceKeys: [f.serviceKey],
            }),
            confirmPauseRecurring: true,
          }),
        );
        await waitForAdvisoryWaiter("partner_recurring_horizon_claim_v1");
        release.resolve();
        await blocker;
        await containment;
        await worker;
        const saved = await assertNoNewRecurringWork(f, occurrence.id);
        expect(saved.bookingDraftId).not.toBeNull();
        const drafts = await db()
          .select()
          .from(partnerBookingDrafts)
          .where(eq(partnerBookingDrafts.partnerAccountId, f.accountId));
        expect(drafts).toHaveLength(1);
        expect(drafts[0]?.id).toBe(saved.bookingDraftId);
        expect(drafts[0]?.state).toBe("draft");
      } finally {
        release.resolve();
        await Promise.allSettled([
          blocker,
          ...(worker ? [worker] : []),
          ...(containment ? [containment] : []),
        ]);
      }
    }, 30_000);
    it("rejects a generic bound-draft submission queued behind containment and releases its prior hold atomically", async () => {
      const { f, series, occurrence } = await claimedOccurrenceFixture();
      const now = new Date("2035-06-30T12:00:00Z");
      const created = await createPartnerBookingDraft({
        actor: f.actor,
        recurringSource: { seriesId: series.id, occurrenceId: occurrence.id },
        mutation: {
          locationId: f.locationId,
          serviceKey: f.serviceKey,
          description: "Synthetic in-flight recurrence",
          onSiteContact: { name: "Local site contact", email: f.actor.email },
        },
        idempotencyKeyHash: randomUUID(),
        now,
      });
      const holdId = randomUUID();
      await db()
        .insert(appointmentHolds)
        .values({
          id: holdId,
          partnerAccountId: f.accountId,
          partnerBookingDraftId: created.draft.id,
          requestedByMembershipId: f.membershipId,
          startAt: new Date("2035-07-01T14:00:00Z"),
          expiresAt: new Date("2035-06-30T12:10:00Z"),
          status: "active",
        });
      const entered = deferred(),
        release = deferred();
      const containment = db().transaction(async (tx) => {
        await updatePartnerWorkflowAsStaff(tx, f.mutation, f.accountId, {
          ...normalizePartnerAccountWorkflow({
            tools: { templates: true, recurring: false },
            requestableServiceKeys: [f.serviceKey],
          }),
          confirmPauseRecurring: true,
        });
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      let submission: Promise<unknown> | undefined;
      try {
        // Deliberately omit recurringSource: the draft's durable binding must
        // prevent the generic portal endpoint from bypassing containment.
        submission = submitPartnerBookingDraft({
          actor: f.actor,
          draftId: created.draft.id,
          holdId,
          ifMatch: created.draft.etag,
          idempotencyKeyHash: randomUUID(),
          correlationId: "local-bound-draft-race",
          now,
        });
        const observed = submission.then(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({ ok: false, error }),
        );
        await waitForAdvisoryWaiter("partner_recurring_horizon_claim_v1");
        release.resolve();
        await containment;
        expect(await observed).toMatchObject({
          ok: false,
          error: { code: "forbidden", status: 403 },
        });
        await assertNoNewRecurringWork(f, occurrence.id);
        expect(
          (
            await db()
              .select()
              .from(appointmentHolds)
              .where(eq(appointmentHolds.id, holdId))
          )[0]?.status,
        ).toBe("released");
      } finally {
        release.resolve();
        await Promise.allSettled([
          containment,
          ...(submission ? [submission] : []),
        ]);
      }
    }, 30_000);
    it("revalidates staff permission and workflow revision before recurring containment", async () => {
      const f = await fixture(),
        series = await recurring(f);
      await expect(workflow(f, "9", false, true)).rejects.toThrow(
        /changed after it was loaded/u,
      );
      await db()
        .update(teamRoles)
        .set({ permissions: [] })
        .where(eq(teamRoles.id, f.staffRoleId));
      await expect(workflow(f, "1", false, true)).rejects.toThrow(
        /permission is no longer/u,
      );
      expect(
        (
          await db()
            .select()
            .from(partnerRecurringSeries)
            .where(eq(partnerRecurringSeries.id, series.id))
        )[0]?.state,
      ).toBe("active");
    });
  },
);

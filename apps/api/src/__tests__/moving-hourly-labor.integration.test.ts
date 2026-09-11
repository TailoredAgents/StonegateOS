import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  appointmentCommissions,
  appointmentCrewMembers,
  appointments,
  closeDbForTests,
  commissionManagementRateRecipients,
  commissionManagementRateVersions,
  contacts,
  expenses,
  getDb,
  payoutRunLines,
  payoutRuns,
  properties,
  teamMembers,
  type DatabaseClient,
} from "@/db";
import {
  getOrCreateCommissionSettings,
  lockCompletedAppointmentPayoutPeriodInTransaction,
  lockPayoutRun,
  markPayoutRunPaid,
  recalculateAppointmentCommissions,
  resolveCurrentPayoutPeriod,
} from "@/lib/commissions";

import { buildExpenseOverview } from "@/lib/expense-overview";
import { mapExpenseOverviewRows } from "@/lib/expense-overview-repository";

const describeOrSkip = process.env["DATABASE_URL"] ? describe : describe.skip;

describeOrSkip("moving hourly labor database workflow", () => {
  afterAll(async () => {
    await closeDbForTests();
  });

  it("recalculates hourly and percentage work, snapshots payouts, and posts payroll once", async () => {
    const rollback = new Error("moving_labor_test_rollback");
    await expect(
      getDb().transaction(async (tx) => {
        const db = tx as unknown as DatabaseClient;
        const settings = await getOrCreateCommissionSettings(db);
        const [owner, mover] = await tx
          .insert(teamMembers)
          .values([
            { name: "Moving test owner", active: true },
            {
              name: "Moving test crew",
              active: true,
              fixedCrewJobRateBps: 1000,
            },
          ])
          .returning({ id: teamMembers.id });
        if (!owner || !mover) throw Error("test_members_missing");
        const completedAt = new Date("2099-09-08T18:00:00Z");
        const [version] = await tx
          .insert(commissionManagementRateVersions)
          .values({
            settingsKey: "default",
            effectiveFrom: new Date("2099-09-07T04:00:00Z"),
            totalRateBps: 500,
            reason: "Moving labor test policy",
            createdBy: owner.id,
          })
          .returning({ id: commissionManagementRateVersions.id });
        await tx
          .insert(commissionManagementRateRecipients)
          .values({ versionId: version!.id, memberId: owner.id, rateBps: 500 });
        const [contact] = await tx
          .insert(contacts)
          .values({ firstName: "Moving", lastName: "Fixture" })
          .returning({ id: contacts.id });
        const [property] = await tx
          .insert(properties)
          .values({
            contactId: contact!.id,
            addressLine1: "Test origin",
            city: "Test",
            state: "NY",
            postalCode: "14604",
          })
          .returning({ id: properties.id });
        const [moving, junk] = await tx
          .insert(appointments)
          .values([
            {
              contactId: contact!.id,
              propertyId: property!.id,
              type: "job",
              status: "completed",
              finalTotalCents: 60000,
              completedAt,
              startAt: completedAt,
              rescheduleToken: randomUUID(),
              bookingDetails: { serviceType: "moving" },
            },
            {
              contactId: contact!.id,
              propertyId: property!.id,
              type: "job",
              status: "completed",
              finalTotalCents: 100000,
              completedAt,
              startAt: completedAt,
              rescheduleToken: randomUUID(),
              bookingDetails: { serviceType: "junk_removal" },
            },
          ])
          .returning({ id: appointments.id });
        if (!moving || !junk) throw Error("test_jobs_missing");
        await tx.insert(appointmentCrewMembers).values([
          {
            appointmentId: moving.id,
            memberId: owner.id,
            splitBps: 0,
            hourlyRateCents: 3000,
            workedMinutes: 150,
          },
          {
            appointmentId: moving.id,
            memberId: mover.id,
            splitBps: 0,
            hourlyRateCents: 4000,
            workedMinutes: 120,
          },
          { appointmentId: junk.id, memberId: owner.id, splitBps: 1 },
        ]);
        const rowsFor = (id: string) =>
          tx
            .select()
            .from(appointmentCommissions)
            .where(eq(appointmentCommissions.appointmentId, id));
        await recalculateAppointmentCommissions(db, moving.id, {
          failClosedOnSchemaMismatch: true,
        });
        await recalculateAppointmentCommissions(db, junk.id, {
          failClosedOnSchemaMismatch: true,
        });
        expect(
          (await rowsFor(moving.id))
            .filter((row) => row.role === "crew")
            .map((row) => row.amountCents)
            .sort((a, b) => a - b),
        ).toEqual([7500, 8000]);
        expect(
          (await rowsFor(junk.id)).find((row) => row.role === "crew")
            ?.amountCents,
        ).toBe(20000);

        // Correct hours, then reopen and complete: commission rows are replaced, never accumulated.
        await tx
          .update(appointmentCrewMembers)
          .set({ workedMinutes: 180 })
          .where(
            and(
              eq(appointmentCrewMembers.memberId, owner.id),
              eq(appointmentCrewMembers.appointmentId, moving.id),
            ),
          );
        // The percentage assignment is unaffected by the hourly correction.
        await recalculateAppointmentCommissions(db, moving.id, {
          failClosedOnSchemaMismatch: true,
        });
        expect(
          (await rowsFor(moving.id)).find(
            (row) => row.role === "crew" && row.memberId === owner.id,
          )?.amountCents,
        ).toBe(9000);
        await tx
          .update(appointments)
          .set({ status: "confirmed", completedAt: null })
          .where(eq(appointments.id, moving.id));
        await recalculateAppointmentCommissions(db, moving.id, {
          failClosedOnSchemaMismatch: true,
        });
        expect(await rowsFor(moving.id)).toEqual([]);
        await tx
          .update(appointments)
          .set({ status: "completed", completedAt, finalTotalCents: 0 })
          .where(eq(appointments.id, moving.id));
        await recalculateAppointmentCommissions(db, moving.id, {
          failClosedOnSchemaMismatch: true,
        });
        expect(
          (await rowsFor(moving.id))
            .filter((row) => row.role === "crew")
            .reduce((sum, row) => sum + row.amountCents, 0),
        ).toBe(17000);
        await tx
          .update(appointments)
          .set({ finalTotalCents: 60000 })
          .where(eq(appointments.id, moving.id));

        await recalculateAppointmentCommissions(db, moving.id, {
          failClosedOnSchemaMismatch: true,
        });
        // Use persisted repository-shaped rows inside the rollback fixture. The
        // production loader owns a separate read-only transaction.
        const overviewFor = async () => {
          const jobRows = await tx
            .select()
            .from(appointments)
            .where(inArray(appointments.id, [moving.id, junk.id]));
          const commissionRows = await tx
            .select()
            .from(appointmentCommissions)
            .where(
              inArray(appointmentCommissions.appointmentId, [
                moving.id,
                junk.id,
              ]),
            );
          const runRows = await tx
            .select()
            .from(payoutRuns)
            .where(eq(payoutRuns.createdBy, owner.id));
          const lines = runRows.length
            ? await tx
                .select()
                .from(payoutRunLines)
                .where(
                  inArray(
                    payoutRunLines.payoutRunId,
                    runRows.map((run) => run.id),
                  ),
                )
            : [];
          const expenseRows = runRows.length
            ? await tx
                .select()
                .from(expenses)
                .where(
                  inArray(
                    expenses.payoutRunId,
                    runRows.map((run) => run.id),
                  ),
                )
            : [];
          const mapped = mapExpenseOverviewRows({
            weekStart: "2099-09-07",
            asOf: completedAt,
            rows: {
              jobs: jobRows.map((row) => ({
                ...row,
                appointmentType: row.type,
              })),
              commissions: commissionRows.map((row) => ({
                ...row,
                completedAt,
              })),
              payoutLines: lines.map((line) => {
                const run = runRows.find((run) => run.id === line.payoutRunId)!;
                return {
                  ...line,
                  status: run.status,
                  periodStart: run.periodStart,
                };
              }),
              expenses: expenseRows.map((row) => ({
                ...row,
                amountCents: row.amount,
                legacyCategory: row.category,
                categoryName: null,
              })),
              allocations: [],
              dumpDetails: [],
              payoutAdjustments: [],
              dailyAdEntries: [],
              fixedCostVersions: [],
            },
          });
          // The real posted payroll expense is excluded at the repository
          // boundary, so the earned labor is counted only once.
          expect(mapped.expenses).toEqual([]);
          return buildExpenseOverview(mapped);
        };
        const assertOverview = (
          overview: ReturnType<typeof buildExpenseOverview>,
          state: "estimated" | "actual",
        ) => {
          expect(overview.labor.state).toBe(state);
          expect(overview.labor.rows).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                group: "crew",
                serviceType: "moving",
                compensationType: "hourly",
                amountCents: 17000,
                workedMinutes: 300,
                jobCount: 1,
              }),
            ]),
          );
          expect(overview.laborCents).toBe(45000);
          expect(overview.totalExpensesCents).toBe(45000);
        };
        assertOverview(await overviewFor(), "estimated");
        // The database rejects incomplete rate/time pairs, and a job-type
        // mismatch cannot replace already-earned commissions.
        await expect(
          tx.transaction(async (nested) => {
            await nested
              .update(appointmentCrewMembers)
              .set({ workedMinutes: null })
              .where(
                and(
                  eq(appointmentCrewMembers.appointmentId, moving.id),
                  eq(appointmentCrewMembers.memberId, mover.id),
                ),
              );
          }),
        ).rejects.toThrow();
        const beforeInvalid = await rowsFor(moving.id);
        await expect(
          tx.transaction(async (nested) => {
            await nested
              .update(appointments)
              .set({ bookingDetails: { serviceType: "junk_removal" } })
              .where(eq(appointments.id, moving.id));
            await recalculateAppointmentCommissions(
              nested as unknown as DatabaseClient,
              moving.id,
              { failClosedOnSchemaMismatch: true },
            );
          }),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(await rowsFor(moving.id)).toEqual(beforeInvalid);
        // Stale or malformed commission metadata is regenerated from the
        // complete, validated crew facts before a payout can snapshot it.
        await tx
          .update(appointmentCommissions)
          .set({ meta: { compensationType: "hourly" } })
          .where(
            and(
              eq(appointmentCommissions.appointmentId, moving.id),
              eq(appointmentCommissions.memberId, mover.id),
            ),
          );
        await recalculateAppointmentCommissions(db, moving.id, {
          failClosedOnSchemaMismatch: true,
        });
        expect(
          (await rowsFor(moving.id)).find((row) => row.memberId === mover.id)
            ?.meta,
        ).toMatchObject({
          compensationType: "hourly",
          serviceType: "moving",
          hourlyRateCents: 4000,
          workedMinutes: 120,
        });
        // Earned hourly wages remain payable if a mover leaves the team
        // before the payroll run is finalized.
        await tx
          .update(teamMembers)
          .set({ active: false })
          .where(eq(teamMembers.id, mover.id));
        const earnedBeforeRetiredChange = await rowsFor(moving.id);
        await expect(
          tx.transaction(async (nested) => {
            await nested
              .update(appointmentCrewMembers)
              .set({ workedMinutes: 180 })
              .where(
                and(
                  eq(appointmentCrewMembers.appointmentId, moving.id),
                  eq(appointmentCrewMembers.memberId, mover.id),
                ),
              );
            await recalculateAppointmentCommissions(
              nested as unknown as DatabaseClient,
              moving.id,
              { failClosedOnSchemaMismatch: true },
            );
          }),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(await rowsFor(moving.id)).toEqual(earnedBeforeRetiredChange);
        const period = resolveCurrentPayoutPeriod(completedAt, settings);
        const [run] = await tx
          .insert(payoutRuns)
          .values({
            timezone: period.timezone,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            scheduledPayoutAt: period.scheduledPayoutAt,
            periodCanonical: true,
            createdBy: owner.id,
          })
          .returning({ id: payoutRuns.id });
        const runId = run!.id;
        expect(
          (
            await lockCompletedAppointmentPayoutPeriodInTransaction(
              tx,
              completedAt,
            )
          ).ok,
        ).toBe(true);
        await lockPayoutRun(db, { payoutRunId: runId, actorId: owner.id });
        assertOverview(await overviewFor(), "actual");
        const lines = await tx
          .select()
          .from(payoutRunLines)
          .where(eq(payoutRunLines.payoutRunId, runId));
        expect(lines.reduce((sum, line) => sum + line.totalCents, 0)).toBe(
          45000,
        );
        const hourly = lines
          .flatMap((line) => line.laborDetails ?? [])
          .filter((entry) => entry.compensationType === "hourly");
        expect(hourly.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(
          17000,
        );
        expect(
          hourly.reduce((sum, entry) => sum + (entry.workedMinutes ?? 0), 0),
        ).toBe(300);
        expect(
          hourly.every(
            (entry) =>
              entry.serviceType === "moving" &&
              entry.appointmentId === moving.id,
          ),
        ).toBe(true);
        expect(
          await lockCompletedAppointmentPayoutPeriodInTransaction(
            tx,
            completedAt,
          ),
        ).toMatchObject({ ok: false, reason: "payout_period_finalized" });
        expect(
          await lockPayoutRun(db, { payoutRunId: runId, actorId: owner.id }),
        ).toMatchObject({ status: "locked", changed: false });
        await markPayoutRunPaid(db, runId, { actorId: owner.id });
        await markPayoutRunPaid(db, runId, { actorId: owner.id });
        assertOverview(await overviewFor(), "actual");
        const payrollExpenses = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.payoutRunId, runId));
        expect(payrollExpenses).toHaveLength(1);
        expect(payrollExpenses[0]).toMatchObject({
          amount: 45000,
          source: "payout_run",
          lifecycleStatus: "posted",
        });
        expect(
          await tx
            .select()
            .from(payoutRunLines)
            .where(eq(payoutRunLines.payoutRunId, runId)),
        ).toEqual(lines);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
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
  lockPayoutRun,
  markPayoutRunPaid,
  recalculateAppointmentCommissions,
  resolveConfiguredCrewPayout,
  resolveCurrentPayoutPeriod,
} from "@/lib/commissions";
import { buildExpenseOverview } from "@/lib/expense-overview";
import { mapExpenseOverviewRows } from "@/lib/expense-overview-repository";

const describeOrSkip = process.env["DATABASE_URL"] ? describe : describe.skip;

describeOrSkip("dynamic labor database workflow", () => {
  afterAll(closeDbForTests);

  it("carries solo/pair/trio/four-person earnings through expenses and immutable paid payroll", async () => {
    const rollback = new Error("dynamic_labor_test_rollback");
    await expect(
      getDb().transaction(async (tx) => {
        const db = tx as unknown as DatabaseClient;
        const settings = await getOrCreateCommissionSettings(db);
        const staff = await tx
          .insert(teamMembers)
          .values(
            ["Jeffrey", "Jed", "Devon", "Austin"].map((name) => ({
              name,
              active: true,
              fixedCrewJobRateBps: 1000,
            })),
          )
          .returning({ id: teamMembers.id });
        const ownerId = staff[0]!.id;
        const completedAt = new Date("2097-09-10T18:00:00Z");
        const [version] = await tx
          .insert(commissionManagementRateVersions)
          .values({
            settingsKey: "default",
            effectiveFrom: new Date("2097-09-09T04:00:00Z"),
            totalRateBps: 500,
            reason: "Dynamic labor fixture",
            createdBy: ownerId,
          })
          .returning({ id: commissionManagementRateVersions.id });
        await tx.insert(commissionManagementRateRecipients).values({
          versionId: version!.id,
          memberId: ownerId,
          rateBps: 500,
        });
        const [contact] = await tx
          .insert(contacts)
          .values({ firstName: "Labor", lastName: "Fixture" })
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
        const jobIds: string[] = [];
        for (const count of [1, 2, 3, 4]) {
          const [job] = await tx
            .insert(appointments)
            .values({
              contactId: contact!.id,
              propertyId: property!.id,
              type: "job",
              status: "completed",
              finalTotalCents: 100000,
              completedAt,
              startAt: completedAt,
              rescheduleToken: randomUUID(),
              bookingDetails: { serviceType: "junk_removal" },
            })
            .returning({ id: appointments.id });
          jobIds.push(job!.id);
          const resolved = await resolveConfiguredCrewPayout(
            db,
            staff.slice(0, count).map((member) => member.id),
          );
          if (!resolved.ok) throw new Error("missing_crew_resolution");
          await tx
            .insert(appointmentCrewMembers)
            .values(
              resolved.splits.map((entry) => ({
                ...entry,
                appointmentId: job!.id,
              })),
            );
          await recalculateAppointmentCommissions(db, job!.id, {
            failClosedOnSchemaMismatch: true,
          });
          // Repeated calculation replaces earnings rather than accumulating them.
          await recalculateAppointmentCommissions(db, job!.id, {
            failClosedOnSchemaMismatch: true,
          });
          const earned = await tx
            .select()
            .from(appointmentCommissions)
            .where(eq(appointmentCommissions.appointmentId, job!.id));
          const crew = earned.filter((entry) => entry.role === "crew");
          expect(crew).toHaveLength(count);
          expect(crew.map((entry) => entry.amountCents)).toEqual(
            Array(count).fill(count === 1 ? 20000 : count === 4 ? 7500 : 10000),
          );
          expect(
            crew.every(
              (entry) =>
                entry.meta?.["crewCount"] === count &&
                entry.meta?.["poolRateBps"] === (count <= 2 ? 2000 : 3000),
            ),
          ).toBe(true);
        }
        // Neither changing current guarantees nor invalid snapshot writes can rewrite earned pay.
        await tx
          .update(teamMembers)
          .set({ fixedCrewJobRateBps: 2000 })
          .where(
            inArray(
              teamMembers.id,
              staff.map((member) => member.id),
            ),
          );
        for (const id of jobIds)
          await recalculateAppointmentCommissions(db, id, {
            failClosedOnSchemaMismatch: true,
          });
        await expect(
          tx.transaction(async (nested) => {
            await nested
              .update(appointmentCrewMembers)
              .set({ splitBps: 2 })
              .where(eq(appointmentCrewMembers.appointmentId, jobIds[3]!));
          }),
        ).rejects.toThrow();
        const period = resolveCurrentPayoutPeriod(completedAt, settings);
        const [run] = await tx
          .insert(payoutRuns)
          .values({
            ...period,
            periodCanonical: true,
            createdBy: ownerId,
          })
          .returning({ id: payoutRuns.id });
        const overview = async () => {
          const jobs = await tx
            .select()
            .from(appointments)
            .where(inArray(appointments.id, jobIds));
          const commissions = await tx
            .select()
            .from(appointmentCommissions)
            .where(inArray(appointmentCommissions.appointmentId, jobIds));
          const [currentRun] = await tx
            .select()
            .from(payoutRuns)
            .where(eq(payoutRuns.id, run!.id));
          const lines = await tx
            .select()
            .from(payoutRunLines)
            .where(eq(payoutRunLines.payoutRunId, run!.id));
          const posted = await tx
            .select()
            .from(expenses)
            .where(eq(expenses.payoutRunId, run!.id));
          const mapped = mapExpenseOverviewRows({
            weekStart: period.periodStart.toISOString().slice(0, 10),
            asOf: completedAt,
            rows: {
              jobs: jobs.map((row) => ({ ...row, appointmentType: row.type })),
              commissions: commissions.map((row) => ({ ...row, completedAt })),
              payoutLines: lines.map((row) => ({
                ...row,
                status: currentRun!.status,
                periodStart: period.periodStart,
              })),
              expenses: posted.map((row) => ({
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
          expect(mapped.expenses).toEqual([]);
          return buildExpenseOverview(mapped);
        };
        const estimated = await overview();
        expect(estimated.labor.state).toBe("estimated");
        expect(estimated.labor.subrows.crewCents).toBe(100000);
        expect(estimated.labor.subrows.managementCents).toBe(20000);
        expect(estimated.totalExpensesCents).toBe(120000);
        await lockPayoutRun(db, { payoutRunId: run!.id, actorId: ownerId });
        const locked = await overview();
        expect(locked.labor.state).toBe("actual");
        expect(locked.labor.amountCents).toBe(120000);
        const frozen = await tx
          .select()
          .from(payoutRunLines)
          .where(eq(payoutRunLines.payoutRunId, run!.id));
        const details = frozen
          .flatMap((line) => line.laborDetails ?? [])
          .filter((detail) => detail.group === "crew");
        expect(details).toHaveLength(10);
        expect(
          details
            .filter((detail) => detail.crewCount === 4)
            .map((detail) => detail.amountCents),
        ).toEqual([7500, 7500, 7500, 7500]);
        expect(
          details.every(
            (detail) =>
              detail.poolRateBps === (detail.crewCount! <= 2 ? 2000 : 3000),
          ),
        ).toBe(true);
        await markPayoutRunPaid(db, run!.id, { actorId: ownerId });
        await markPayoutRunPaid(db, run!.id, { actorId: ownerId });
        const paid = await overview();
        expect(paid.labor.state).toBe("actual");
        expect(paid.totalExpensesCents).toBe(120000);
        expect(
          await tx
            .select()
            .from(payoutRunLines)
            .where(eq(payoutRunLines.payoutRunId, run!.id)),
        ).toEqual(frozen);
        const payroll = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.payoutRunId, run!.id));
        expect(payroll).toHaveLength(1);
        expect(payroll[0]).toMatchObject({
          amount: 120000,
          source: "payout_run",
          lifecycleStatus: "posted",
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});

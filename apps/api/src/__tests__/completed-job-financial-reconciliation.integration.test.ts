import { randomUUID } from "node:crypto";
import {
  appointmentCommissions,
  appointments,
  closeDbForTests,
  contacts,
  getDb,
  payoutRunAdjustments,
  payoutRuns,
  properties,
  teamMembers,
  type DatabaseClient,
} from "@/db";
import { buildExpenseOverview } from "@/lib/expense-overview";
import { loadExpenseOverviewInput } from "@/lib/expense-overview-repository";
import {
  buildPayoutRunReportData,
  calculatePayoutPeriodPayrollAdjustmentTotalCents,
  calculatePayoutRunLiveTotalCents,
} from "@/lib/payout-run-report";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
const describeOrSkip = hasDatabase ? describe : describe.skip;
const ROLLBACK = new Error("completed_job_reconciliation_test_rollback");

const WEEK_START = "2099-08-17";
const PERIOD_START = new Date("2099-08-17T04:00:00.000Z");
const PERIOD_END = new Date("2099-08-24T04:00:00.000Z");
const COMPLETED_AT = new Date("2099-08-18T14:00:00.000Z");

/**
 * The overview repository opens its own read-only transaction in production.
 * This test already owns the surrounding rollback transaction, so this adapter
 * reuses that transaction and ignores only the nested isolation declaration.
 * Every fixture write and every asserted read still executes in PostgreSQL.
 */
function bindOverviewLoaderToTransaction(tx: object): DatabaseClient {
  const transactionTarget = tx as Record<PropertyKey, unknown>;
  const readTarget = new Proxy(transactionTarget, {
    get(target, property) {
      if (property === "execute") {
        return () => Promise.resolve([]);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (...args: unknown[]): unknown =>
            Reflect.apply(value, target, args) as unknown
        : value;
    },
  });

  return new Proxy(transactionTarget, {
    get(target, property) {
      if (property === "transaction") {
        return (callback: (nested: unknown) => Promise<unknown>) =>
          callback(readTarget);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (...args: unknown[]): unknown =>
            Reflect.apply(value, target, args) as unknown
        : value;
    },
  }) as unknown as DatabaseClient;
}

describeOrSkip("completed-job financial reconciliation", () => {
  afterAll(async () => {
    await closeDbForTests();
  });

  it("reconciles a completed legacy estimate across Spend and payout projections while excluding quote-only rows", async () => {
    await expect(
      getDb().transaction(async (tx) => {
        const [contact] = await tx
          .insert(contacts)
          .values({
            firstName: "Legacy",
            lastName: "Estimate Fixture",
          })
          .returning({ id: contacts.id });
        if (!contact) throw new Error("test_contact_missing");

        const [property] = await tx
          .insert(properties)
          .values({
            contactId: contact.id,
            addressLine1: "425 Reconciliation Way",
            city: "Rochester",
            state: "NY",
            postalCode: "14604",
          })
          .returning({ id: properties.id });
        if (!property) throw new Error("test_property_missing");

        const [crewMember, managementMember] = await tx
          .insert(teamMembers)
          .values([
            { name: "Reconciliation Crew", active: true },
            { name: "Reconciliation Management", active: true },
          ])
          .returning({ id: teamMembers.id });
        if (!crewMember || !managementMember) {
          throw new Error("test_team_members_missing");
        }

        const appointmentFixtures = [
          {
            key: "legacy-estimate",
            type: "estimate",
            finalTotalCents: 42_500,
          },
          {
            key: "quote-only",
            type: "\tIN_PERSON_QUOTE\n",
            finalTotalCents: 900_000,
          },
          {
            key: "estimate-only",
            type: " \rIN_PERSON_ESTIMATE\t",
            finalTotalCents: 800_000,
          },
        ] as const;

        const appointmentRows = await tx
          .insert(appointments)
          .values(
            appointmentFixtures.map((fixture, index) => ({
              contactId: contact.id,
              propertyId: property.id,
              type: fixture.type,
              startAt: new Date(COMPLETED_AT.getTime() + index * 60_000),
              status: "completed" as const,
              finalTotalCents: fixture.finalTotalCents,
              completedAt: new Date(COMPLETED_AT.getTime() + index * 60_000),
              rescheduleToken: randomUUID(),
            })),
          )
          .returning({ id: appointments.id, type: appointments.type });
        const appointmentIdByType = new Map(
          appointmentRows.map((row) => [row.type.trim().toLowerCase(), row.id]),
        );
        const legacyEstimateId = appointmentIdByType.get("estimate");
        const quoteOnlyId = appointmentIdByType.get("in_person_quote");
        const estimateOnlyId = appointmentIdByType.get("in_person_estimate");
        if (!legacyEstimateId || !quoteOnlyId || !estimateOnlyId) {
          throw new Error("test_appointments_missing");
        }

        await tx.insert(appointmentCommissions).values([
          {
            appointmentId: legacyEstimateId,
            memberId: crewMember.id,
            role: "crew",
            baseCents: 42_500,
            amountCents: 8_500,
          },
          {
            appointmentId: legacyEstimateId,
            memberId: managementMember.id,
            role: "marketing",
            baseCents: 42_500,
            amountCents: 7_225,
          },
          // Deliberately malformed historical rows prove every reader applies
          // the appointment-kind boundary instead of trusting row presence.
          {
            appointmentId: quoteOnlyId,
            memberId: crewMember.id,
            role: "crew",
            baseCents: 900_000,
            amountCents: 180_000,
          },
          {
            appointmentId: estimateOnlyId,
            memberId: managementMember.id,
            role: "marketing",
            baseCents: 800_000,
            amountCents: 136_000,
          },
        ]);

        const [payoutRun] = await tx
          .insert(payoutRuns)
          .values({
            timezone: "America/New_York",
            periodStart: PERIOD_START,
            periodEnd: PERIOD_END,
            scheduledPayoutAt: new Date("2099-08-24T16:00:00.000Z"),
            periodCanonical: true,
            status: "draft",
            createdBy: managementMember.id,
          })
          .returning({ id: payoutRuns.id });
        if (!payoutRun) throw new Error("test_payout_run_missing");

        await tx.insert(payoutRunAdjustments).values([
          {
            payoutRunId: payoutRun.id,
            memberId: crewMember.id,
            kind: "manual",
            amountCents: 500,
            note: "Test payroll adjustment",
            createdBy: managementMember.id,
          },
          {
            payoutRunId: payoutRun.id,
            memberId: crewMember.id,
            kind: "reimbursement",
            amountCents: 750,
            note: "Test reimbursement",
            createdBy: managementMember.id,
          },
        ]);

        const overviewInput = await loadExpenseOverviewInput(
          bindOverviewLoaderToTransaction(tx),
          WEEK_START,
          { asOf: "2099-08-24" },
        );
        const overview = buildExpenseOverview(overviewInput);
        const livePayoutTotal = await calculatePayoutRunLiveTotalCents(tx, {
          id: payoutRun.id,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
        });
        const payrollAdjustmentsTotal =
          await calculatePayoutPeriodPayrollAdjustmentTotalCents(tx, {
            timezone: "America/New_York",
            periodStart: PERIOD_START,
            periodEnd: PERIOD_END,
          });
        const payoutReport = await buildPayoutRunReportData(tx, payoutRun.id);

        expect(overviewInput.jobs.map((job) => job.id)).toContain(
          legacyEstimateId,
        );
        expect(overviewInput.jobs.map((job) => job.id)).not.toEqual(
          expect.arrayContaining([quoteOnlyId, estimateOnlyId]),
        );
        expect(
          overviewInput.commissions.map(
            (commission) => commission.appointmentId,
          ),
        ).toEqual([legacyEstimateId, legacyEstimateId]);

        expect(overview).toMatchObject({
          revenueCents: 42_500,
          laborCents: 16_225,
          missingCommissionDataCount: 0,
          labor: {
            state: "estimated",
            amountCents: 16_225,
            subrows: {
              crewCents: 8_500,
              salesCents: 0,
              managementCents: 7_225,
              otherPayrollAdjustmentsCents: 500,
            },
          },
        });
        expect(payrollAdjustmentsTotal).toBe(500);
        expect(livePayoutTotal).toBe(16_975);
        expect(payoutReport.totalCents).toBe(16_975);
        expect(payoutReport.commissionDetailCount).toBe(2);
        expect(payoutReport.adjustmentCount).toBe(2);
        expect(
          payoutReport.memberSummaries.flatMap((summary) =>
            summary.commissionDetails.map((detail) => detail.appointmentId),
          ),
        ).toEqual([legacyEstimateId, legacyEstimateId]);

        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  });
});

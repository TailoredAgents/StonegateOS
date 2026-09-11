import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import postgres from "postgres";
import {
  appointmentCommissions,
  appointments,
  closeDbForTests,
  contacts,
  expenses,
  getDb,
  payoutRunAdjustments,
  payoutRunLines,
  payoutRuns,
  properties,
  teamMembers,
  teamRoles,
  teamSessions,
  type PayoutLaborDetail,
} from "@/db";
import {
  buildExpenseOverview,
  getExpenseOverviewWeekBoundary,
} from "@/lib/expense-overview";
import { loadExpenseOverviewInput } from "@/lib/expense-overview-repository";
import { GET } from "../../app/api/admin/expenses/overview/route";

// The loader opens its own read-only transaction, so these fixtures must commit.
// Opt in with a local migrated template; each run clones and drops its own database.
const describeOrSkip =
  process.env["EXPENSE_OVERVIEW_LOADER_TESTS"] === "1" &&
  process.env["DATABASE_URL"]
    ? describe
    : describe.skip;
const WEEK = "2100-03-08"; // Eastern spring-DST week: 167 hours.
const boundary = getExpenseOverviewWeekBoundary(WEEK);
const completedAt = new Date("2100-03-10T16:00:00.000Z");

describeOrSkip(
  "expense overview committed database loader and authorized route",
  () => {
    const ids = {
      owner: randomUUID(),
      crew: randomUUID(),
      contact: randomUUID(),
      property: randomUUID(),
      moving: randomUUID(),
      junk: randomUUID(),
      prior: randomUUID(),
      next: randomUUID(),
      quote: randomUUID(),
      run: randomUUID(),
      fuel: randomUUID(),
      payroll: randomUUID(),
      reimbursement: randomUUID(),
    };
    const ownerToken = randomUUID();
    const crewToken = randomUUID();
    const originalDatabaseUrl = process.env["DATABASE_URL"];
    const fixtureDatabase = `expense_overview_${randomUUID().replace(/-/gu, "")}`;
    let databaseCreated = false;
    let admin: ReturnType<typeof postgres> | null = null;
    const originalAdminKey = process.env["ADMIN_API_KEY"];
    const originalOverviewFlag = process.env["EXPENSE_OVERVIEW_ENABLED"];
    const detail = (
      appointmentId: string,
      amountCents: number,
      workedMinutes: number,
    ): PayoutLaborDetail => ({
      appointmentId,
      group: "crew",
      serviceType: "moving",
      compensationType: "hourly",
      amountCents,
      workedMinutes,
      hourlyRateCents: 2500,
    });
    const details: PayoutLaborDetail[] = [
      detail(ids.moving, 3750, 90),
      detail(ids.moving, 3000, 72),
      {
        appointmentId: ids.junk,
        group: "crew",
        serviceType: "junk_removal",
        compensationType: "percentage",
        amountCents: 2000,
      },
      {
        appointmentId: ids.junk,
        group: "management",
        serviceType: "junk_removal",
        compensationType: "percentage",
        amountCents: 1000,
      },
    ];
    const read = async (weekStart = WEEK) =>
      buildExpenseOverview(
        await loadExpenseOverviewInput(getDb(), weekStart, { asOf: weekStart }),
      );
    const request = (token = ownerToken, weekStart = WEEK) =>
      new NextRequest(
        `http://localhost/api/admin/expenses/overview?weekStart=${weekStart}`,
        {
          headers: {
            "x-api-key": "expense-overview-loader-test-only",
            authorization: `Bearer ${token}`,
          },
        },
      );

    beforeAll(async () => {
      const url = new URL(process.env["DATABASE_URL"]!);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new Error(
          "Committed expense overview tests require a local disposable database.",
        );
      const templateDatabase = url.pathname.slice(1);
      if (!/^[a-zA-Z0-9_]+$/u.test(templateDatabase))
        throw new Error("Invalid local test template name.");
      const adminUrl = new URL(url);
      adminUrl.pathname = "/postgres";
      admin = postgres(adminUrl.toString(), { max: 1 });
      await admin.unsafe(
        `CREATE DATABASE "${fixtureDatabase}" TEMPLATE "${templateDatabase}"`,
      );
      databaseCreated = true;
      url.pathname = `/${fixtureDatabase}`;
      process.env["DATABASE_URL"] = url.toString();
      process.env["ADMIN_API_KEY"] = "expense-overview-loader-test-only";
      process.env["EXPENSE_OVERVIEW_ENABLED"] = "1";
      const db = getDb();
      let [role] = await db
        .select({ id: teamRoles.id })
        .from(teamRoles)
        .where(eq(teamRoles.slug, "owner"));
      if (!role) {
        [role] = await db
          .insert(teamRoles)
          .values({
            name: "Owner",
            slug: "owner",
            permissions: ["financials.read"],
          })
          .returning({ id: teamRoles.id });
      }
      await db.transaction(async (tx) => {
        await tx.insert(teamMembers).values([
          {
            id: ids.owner,
            name: "Expense loader owner",
            active: true,
            roleId: role!.id,
            permissionsGrant: ["financials.read"],
          },
          { id: ids.crew, name: "Expense loader crew", active: true },
        ]);
        await tx.insert(teamSessions).values([
          {
            teamMemberId: ids.owner,
            sessionHash: createHash("sha256")
              .update(ownerToken)
              .digest("base64url"),
            expiresAt: new Date(Date.now() + 3600000),
          },
          {
            teamMemberId: ids.crew,
            sessionHash: createHash("sha256")
              .update(crewToken)
              .digest("base64url"),
            expiresAt: new Date(Date.now() + 3600000),
          },
        ]);
        await tx.insert(contacts).values({
          id: ids.contact,
          firstName: "Expense",
          lastName: "Loader",
        });
        await tx.insert(properties).values({
          id: ids.property,
          contactId: ids.contact,
          addressLine1: "Loader fixture origin",
          city: "Test",
          state: "NY",
          postalCode: "14604",
        });
        const base = {
          contactId: ids.contact,
          propertyId: ids.property,
          status: "completed",
          type: "job",
          startAt: completedAt,
          completedAt,
          finalTotalCents: 10000,
        };
        await tx.insert(appointments).values([
          {
            ...base,
            id: ids.moving,
            rescheduleToken: randomUUID(),
            bookingDetails: { serviceType: "moving" },
          },
          {
            ...base,
            id: ids.junk,
            rescheduleToken: randomUUID(),
            bookingDetails: { serviceType: "junk_removal" },
          },
          {
            ...base,
            id: ids.prior,
            rescheduleToken: randomUUID(),
            completedAt: new Date(new Date(boundary.startAt).getTime() - 1),
            finalTotalCents: 1000,
            bookingDetails: { serviceType: "moving" },
          },
          {
            ...base,
            id: ids.next,
            rescheduleToken: randomUUID(),
            completedAt: new Date(boundary.endAtExclusive),
            finalTotalCents: 2000,
            bookingDetails: { serviceType: "moving" },
          },
          {
            ...base,
            id: ids.quote,
            rescheduleToken: randomUUID(),
            type: "in_person_quote",
            finalTotalCents: 99999,
          },
        ]);
        await tx.insert(appointmentCommissions).values([
          ...details.map((row, index) => ({
            appointmentId: row.appointmentId,
            memberId: index === 1 ? ids.crew : ids.owner,
            role:
              row.group === "management" ? ("marketing" as const) : row.group,
            amountCents: row.amountCents,
            baseCents: 10000,
            meta: { ...row },
          })),
          {
            appointmentId: ids.prior,
            memberId: ids.owner,
            role: "crew",
            amountCents: 500,
            baseCents: 1000,
            meta: {
              compensationType: "hourly",
              serviceType: "moving",
              workedMinutes: 12,
            },
          },
          {
            appointmentId: ids.next,
            memberId: ids.owner,
            role: "crew",
            amountCents: 800,
            baseCents: 2000,
            meta: {
              compensationType: "hourly",
              serviceType: "moving",
              workedMinutes: 24,
            },
          },
          {
            appointmentId: ids.quote,
            memberId: ids.owner,
            role: "crew",
            amountCents: 9000,
            baseCents: 99999,
          },
        ]);
        await tx.insert(payoutRuns).values({
          id: ids.run,
          timezone: "America/New_York",
          periodStart: new Date(boundary.startAt),
          periodEnd: new Date(boundary.endAtExclusive),
          scheduledPayoutAt: new Date("2100-03-19T16:00:00Z"),
          periodCanonical: true,
          status: "draft",
          createdBy: ids.owner,
        });
        await tx.insert(payoutRunAdjustments).values([
          {
            payoutRunId: ids.run,
            memberId: ids.owner,
            kind: "tip",
            amountCents: 500,
          },
          {
            payoutRunId: ids.run,
            memberId: ids.owner,
            kind: "manual",
            amountCents: 200,
          },
          {
            payoutRunId: ids.run,
            memberId: ids.owner,
            kind: "manual",
            amountCents: -100,
          },
          {
            payoutRunId: ids.run,
            memberId: ids.owner,
            kind: "reimbursement",
            amountCents: 700,
          },
        ]);
        await tx.insert(expenses).values({
          id: ids.fuel,
          amount: 1200,
          category: "Legacy moving fuel",
          paidAt: completedAt,
          source: "manual",
          lifecycleStatus: "posted",
          reviewStatus: "approved",
        });
      });
    });

    afterAll(async () => {
      try {
        await closeDbForTests();
        if (databaseCreated && admin)
          await admin.unsafe(`DROP DATABASE "${fixtureDatabase}"`);
      } finally {
        await admin?.end({ timeout: 5 });
        if (originalDatabaseUrl === undefined)
          delete process.env["DATABASE_URL"];
        else process.env["DATABASE_URL"] = originalDatabaseUrl;
        if (originalAdminKey === undefined) delete process.env["ADMIN_API_KEY"];
        else process.env["ADMIN_API_KEY"] = originalAdminKey;
        if (originalOverviewFlag === undefined)
          delete process.env["EXPENSE_OVERVIEW_ENABLED"];
        else process.env["EXPENSE_OVERVIEW_ENABLED"] = originalOverviewFlag;
      }
    });

    it("loads adjacent Eastern weeks across DST and pays only completed service work", async () => {
      const overview = await read();
      expect(
        new Date(boundary.endAtExclusive).getTime() -
          new Date(boundary.startAt).getTime(),
      ).toBe(167 * 3600000);
      expect(overview).toMatchObject({
        revenueCents: 20000,
        laborCents: 10350,
        ordinaryExpensesCents: 1200,
        totalExpensesCents: 11550,
        priorWeek: { revenueCents: 1000, laborCents: 500 },
      });
      expect(overview.labor.rows).toContainEqual(
        expect.objectContaining({
          serviceType: "moving",
          compensationType: "hourly",
          amountCents: 6750,
          workedMinutes: 162,
          jobCount: 1,
        }),
      );
      expect(overview.labor.subrows.otherPayrollAdjustmentsCents).toBe(600);
      const next = await read("2100-03-15");
      expect(next).toMatchObject({
        revenueCents: 2000,
        laborCents: 800,
        priorWeek: { revenueCents: 20000, laborCents: 10350 },
      });
    });

    it("returns exact dynamic labor from the real owner-authorized route and rejects crew access", async () => {
      const allowed = await GET(request());
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("cache-control")).toContain("no-store");
      const body = await allowed.json();
      expect(body).toMatchObject({
        ok: true,
        laborCents: 10350,
        totalExpensesCents: 11550,
        labor: { state: "estimated" },
      });
      expect(body.labor.rows).toContainEqual(
        expect.objectContaining({ label: "Moving", workedMinutes: 162 }),
      );
      expect((await GET(request(crewToken))).status).toBe(403);
      expect((await GET(request("expired-or-invented-token"))).status).toBe(
        401,
      );
      expect((await GET(request(ownerToken, "2100-03-09"))).status).toBe(422);
    });

    it("uses locked and paid snapshots despite stale live metadata and excludes payout/reimbursement ledger duplication", async () => {
      const db = getDb();
      await db.insert(payoutRunLines).values({
        payoutRunId: ids.run,
        memberId: ids.owner,
        crewCents: 8750,
        salesCents: 0,
        marketingCents: 1000,
        adjustmentsCents: 1300,
        totalCents: 11050,
        laborDetails: details,
      });
      await db
        .update(payoutRuns)
        .set({ status: "locked", lockedAt: new Date() })
        .where(eq(payoutRuns.id, ids.run));
      await db
        .update(appointmentCommissions)
        .set({
          amountCents: 99999,
          meta: {
            compensationType: "hourly",
            serviceType: "moving",
            workedMinutes: 9999,
          },
        })
        .where(
          and(
            eq(appointmentCommissions.appointmentId, ids.moving),
            eq(appointmentCommissions.memberId, ids.owner),
          ),
        );
      for (const state of ["locked", "paid"] as const) {
        if (state === "paid") {
          await db
            .update(payoutRuns)
            .set({ status: "paid", paidAt: new Date() })
            .where(eq(payoutRuns.id, ids.run));
          await db.insert(expenses).values([
            {
              id: ids.payroll,
              amount: 10350,
              source: "payout_run",
              payoutRunId: ids.run,
              paidAt: completedAt,
              category: "Commissions",
            },
            {
              id: ids.reimbursement,
              amount: 700,
              source: "payout_reimbursement",
              paidAt: completedAt,
              category: "Reimbursements",
            },
          ]);
        }
        const overview = await read();
        expect(overview).toMatchObject({
          laborCents: 10350,
          ordinaryExpensesCents: 1200,
          totalExpensesCents: 11550,
          labor: { state: "actual" },
        });
        expect(overview.labor.rows).toContainEqual(
          expect.objectContaining({
            serviceType: "moving",
            amountCents: 6750,
            workedMinutes: 162,
            jobCount: 1,
          }),
        );
        expect((await (await GET(request())).json()).labor).toEqual(
          overview.labor,
        );
      }
      await expect(
        db
          .update(payoutRunLines)
          .set({ laborDetails: null })
          .where(eq(payoutRunLines.payoutRunId, ids.run)),
      ).rejects.toThrow();
      expect((await read()).labor.rows).toContainEqual(
        expect.objectContaining({ serviceType: "moving", workedMinutes: 162 }),
      );
    });

    it("preserves legacy and partial snapshot totals without inventing historical hours", async () => {
      const db = getDb();
      for (const [weekStart, laborDetails] of [
        ["2100-04-05", null],
        ["2100-04-12", details.slice(0, 1)],
      ] as const) {
        const week = getExpenseOverviewWeekBoundary(weekStart);
        const payoutRunId = randomUUID();
        await db.insert(payoutRuns).values({
          id: payoutRunId,
          timezone: "America/New_York",
          periodStart: new Date(week.startAt),
          periodEnd: new Date(week.endAtExclusive),
          scheduledPayoutAt: new Date(week.endAtExclusive),
          periodCanonical: true,
          status: "draft",
          createdBy: ids.owner,
        });
        await db.insert(payoutRunLines).values({
          payoutRunId,
          memberId: ids.owner,
          crewCents: 8750,
          marketingCents: 1000,
          totalCents: 9750,
          laborDetails,
        });
        await db
          .update(payoutRuns)
          .set({ status: "locked", lockedAt: new Date() })
          .where(eq(payoutRuns.id, payoutRunId));
        const legacy = await read(weekStart);
        expect(legacy.laborCents).toBe(9750);
        expect(legacy.labor.rows).toContainEqual(
          expect.objectContaining({
            label: "Crew",
            amountCents: 8750,
            workedMinutes: null,
            jobCount: null,
          }),
        );
      }
    });

    it("does not truncate labor at a calendar page size and flags missing payroll/final totals", async () => {
      const bulkDate = new Date("2100-03-23T16:00:00.000Z");
      const bulkIds = Array.from({ length: 151 }, () => randomUUID());
      const incompleteId = randomUUID();
      const db = getDb();
      await db.insert(appointments).values(
        [...bulkIds, incompleteId].map((id) => ({
          id,
          contactId: ids.contact,
          propertyId: ids.property,
          rescheduleToken: randomUUID(),
          status: "completed",
          type: "job",
          completedAt: bulkDate,
          startAt: bulkDate,
          finalTotalCents: id === incompleteId ? null : 10000,
          bookingDetails: { serviceType: "moving" as const },
        })),
      );
      await db.insert(appointmentCommissions).values(
        bulkIds.map((appointmentId) => ({
          appointmentId,
          memberId: ids.owner,
          role: "crew" as const,
          baseCents: 10000,
          amountCents: 2500,
          meta: {
            compensationType: "hourly",
            serviceType: "moving",
            workedMinutes: 60,
            hourlyRateCents: 2500,
          },
        })),
      );
      const overview = await read("2100-03-22");
      expect(overview).toMatchObject({
        revenueCents: 1510000,
        laborCents: 377500,
        missingCommissionDataCount: 1,
        missingFinalTotalCount: 1,
      });
      expect(overview.labor.rows).toEqual([
        expect.objectContaining({
          amountCents: 377500,
          workedMinutes: 9060,
          jobCount: 151,
        }),
      ]);
      expect(overview.completeness.reasons).toEqual(
        expect.arrayContaining([
          "missing_commission_data",
          "missing_final_totals",
        ]),
      );
    });
  },
);

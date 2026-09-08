import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  appointmentCommissions,
  appointmentCrewMembers,
  appointments,
  closeDbForTests,
  commissionManagementRateRecipients,
  commissionManagementSplits,
  contacts,
  getDb,
  payoutRuns,
  properties,
  teamMembers,
  type DatabaseClient,
} from "@/db";
import { applyManagementRateVersion } from "@/lib/apply-management-rate-version";
import {
  getOrCreateCommissionSettings,
  recalculateAppointmentCommissions,
} from "@/lib/commissions";
import { readManagementRateVersion } from "@/lib/management-commission-rates";

const describeOrSkip = process.env["DATABASE_URL"] ? describe : describe.skip;
describeOrSkip(
  "effective-dated management commission database workflow",
  () => {
    afterAll(async () => {
      await closeDbForTests();
    });
    it("changes this week's management only, preserves historical recalculation, and rejects finalized periods", async () => {
      const ROLLBACK = new Error("management_rate_test_rollback");
      await expect(
        getDb().transaction(async (tx) => {
          const db = tx as unknown as DatabaseClient;
          await getOrCreateCommissionSettings(db);
          const [austin, jeffrey] = await tx
            .insert(teamMembers)
            .values([
              { name: "Rate Test Austin", active: true },
              { name: "Rate Test Jeffrey", active: true },
            ])
            .returning({ id: teamMembers.id });
          if (!austin || !jeffrey) throw Error("test_members_missing");
          await tx.insert(commissionManagementSplits).values([
            { settingsKey: "default", memberId: austin.id, splitBps: 5000 },
            { settingsKey: "default", memberId: jeffrey.id, splitBps: 12000 },
          ]);
          const [contact] = await tx
            .insert(contacts)
            .values({ firstName: "Rate", lastName: "Fixture" })
            .returning({ id: contacts.id });
          if (!contact) throw Error("test_contact_missing");
          const [property] = await tx
            .insert(properties)
            .values({
              contactId: contact.id,
              addressLine1: "Test site",
              city: "Test",
              state: "NY",
              postalCode: "14604",
            })
            .returning({ id: properties.id });
          if (!property) throw Error("test_property_missing");
          const cutoff = new Date("2026-09-07T04:00:00.000Z");
          const dates = [
            new Date(cutoff.getTime() - 1),
            cutoff,
            new Date("2026-09-14T14:00:00Z"),
          ];
          const jobIds: string[] = [];
          for (const completedAt of dates) {
            const [job] = await tx
              .insert(appointments)
              .values({
                contactId: contact.id,
                propertyId: property.id,
                type: "job",
                status: "completed",
                finalTotalCents: 42500,
                completedAt,
                startAt: completedAt,
                rescheduleToken: randomUUID(),
              })
              .returning({ id: appointments.id });
            if (!job) throw Error("test_job_missing");
            jobIds.push(job.id);
            await tx
              .insert(appointmentCrewMembers)
              .values({
                appointmentId: job.id,
                memberId: jeffrey.id,
                splitBps: 1,
              });
            await recalculateAppointmentCommissions(db, job.id, {
              failClosedOnSchemaMismatch: true,
            });
          }
          const [oldId, currentId, futureId] = jobIds as [
            string,
            string,
            string,
          ];
          const rowsFor = (id: string) =>
            tx
              .select()
              .from(appointmentCommissions)
              .where(eq(appointmentCommissions.appointmentId, id));
          const oldBefore = await rowsFor(oldId);
          const change = {
            effectiveFrom: cutoff,
            actorId: jeffrey.id,
            reason: "Owner requested management rate change",
            recipients: [
              { memberId: austin.id, rateBps: 0 },
              { memberId: jeffrey.id, rateBps: 500 },
            ],
          };
          const now = new Date("2026-09-08T22:00:00Z");
          const result = await applyManagementRateVersion(tx, change, now);
          expect(result.jobsChecked).toBe(1);
          expect(result.members).toEqual([
            expect.objectContaining({
              name: "Rate Test Austin",
              beforeManagementCents: 2125,
              afterManagementCents: 0,
            }),
            expect.objectContaining({
              name: "Rate Test Jeffrey",
              beforeManagementCents: 5100,
              afterManagementCents: 2125,
            }),
          ]);
          expect(await rowsFor(oldId)).toEqual(oldBefore);
          expect(
            (await rowsFor(currentId))
              .filter((row) => row.role === "crew")
              .map((row) => row.amountCents),
          ).toEqual([8500]);
          expect(await readManagementRateVersion(db, dates[0]!)).toBeNull();
          expect(
            (await readManagementRateVersion(db, cutoff))?.totalRateBps,
          ).toBe(500);
          expect(
            (await getOrCreateCommissionSettings(db)).marketingRateBps,
          ).toBe(500);
          await recalculateAppointmentCommissions(db, oldId, {
            failClosedOnSchemaMismatch: true,
          });
          const management = (rows: Awaited<ReturnType<typeof rowsFor>>) =>
            rows
              .filter((row) => row.role === "marketing")
              .map((row) => ({
                memberId: row.memberId,
                amountCents: row.amountCents,
              }))
              .sort((a, b) =>
                String(a.memberId).localeCompare(String(b.memberId)),
              );
          expect(management(await rowsFor(oldId))).toEqual(
            management(oldBefore),
          );
          await recalculateAppointmentCommissions(db, futureId, {
            failClosedOnSchemaMismatch: true,
          });
          expect(management(await rowsFor(futureId))).toEqual([
            { memberId: jeffrey.id, amountCents: 2125 },
          ]);
          const repeated = await applyManagementRateVersion(tx, change, now);
          expect(repeated.versionId).toBe(result.versionId);
          await expect(
            tx.transaction(async (nested) => {
              await nested
                .update(commissionManagementRateRecipients)
                .set({ rateBps: 1700 })
                .where(
                  eq(
                    commissionManagementRateRecipients.versionId,
                    result.versionId!,
                  ),
                );
            }),
          ).rejects.toThrow();
          await tx
            .insert(payoutRuns)
            .values({
              timezone: "America/New_York",
              periodStart: cutoff,
              periodEnd: new Date("2026-09-14T04:00:00Z"),
              scheduledPayoutAt: new Date("2026-09-14T16:00:00Z"),
              status: "locked",
              lockedAt: now,
            });
          await expect(
            applyManagementRateVersion(tx, change, now),
          ).rejects.toThrow(
            "management_rate_change_intersects_finalized_payout",
          );
          throw ROLLBACK;
        }),
      ).rejects.toBe(ROLLBACK);
    });
  },
);

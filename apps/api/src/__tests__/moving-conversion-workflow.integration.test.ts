import { createHash, randomUUID } from "node:crypto";
import type * as DbModule from "@/db";
import type * as PermissionsModule from "@/lib/permissions";
import type * as CalendarModule from "@/lib/calendar";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  appointmentCommissions,
  appointmentCrewMembers,
  appointments,
  auditLogs,
  closeDbForTests,
  commissionManagementRateRecipients,
  commissionManagementRateVersions,
  contacts,
  getDb,
  payoutRuns,
  properties,
  teamMembers,
  teamMutationIdempotency,
  type DatabaseClient,
} from "@/db";
import {
  getOrCreateCommissionSettings,
  resolveCurrentPayoutPeriod,
} from "@/lib/commissions";
import { setVerifiedRequestActor } from "@/lib/verified-actor-context";

let mockBoundDb: DatabaseClient | undefined;
jest.mock("@/db", () => {
  const actual = jest.requireActual<typeof DbModule>("@/db");
  return { ...actual, getDb: () => mockBoundDb ?? actual.getDb() };
});
// Authentication is supplied by the trusted request context. Keep only the
// capability decision local; all business data, locks, audits and replay
// receipts exercise the real route and PostgreSQL implementations.
jest.mock("@/lib/permissions", () => ({
  ...jest.requireActual<typeof PermissionsModule>("@/lib/permissions"),
  requirePermission: jest.fn(() => Promise.resolve(null)),
}));
jest.mock("@/lib/calendar", () => ({
  ...jest.requireActual<typeof CalendarModule>("@/lib/calendar"),
  isGoogleCalendarEnabled: () => false,
}));
import { POST as convertQuote } from "../../app/api/appointments/[id]/convert/route";

const describeOrSkip = process.env["DATABASE_URL"] ? describe : describe.skip;
const completedAt = new Date("2098-11-04T17:00:00Z");

describeOrSkip("moving quote conversion database workflow", () => {
  afterAll(async () => {
    mockBoundDb = undefined;
    await closeDbForTests();
  });

  it("converts and completes atomically, replays safely, and rejects backdating into locked payroll", async () => {
    const rollback = new Error("moving_conversion_test_rollback");
    try {
      await expect(
        getDb().transaction(async (tx) => {
          mockBoundDb = tx as unknown as DatabaseClient;
          const settings = await getOrCreateCommissionSettings(mockBoundDb);
          const [owner, mover] = await tx
            .insert(teamMembers)
            .values([
              { name: "Moving conversion owner", active: true },
              { name: "Moving conversion crew", active: true },
            ])
            .returning({ id: teamMembers.id });
          if (!owner || !mover) throw Error("test_members_missing");
          const [rateVersion] = await tx
            .insert(commissionManagementRateVersions)
            .values({
              settingsKey: "default",
              effectiveFrom: new Date("2098-11-03T04:00:00Z"),
              totalRateBps: 500,
              reason: "Moving conversion test policy",
              createdBy: owner.id,
            })
            .returning({ id: commissionManagementRateVersions.id });
          await tx.insert(commissionManagementRateRecipients).values({
            versionId: rateVersion!.id,
            memberId: owner.id,
            rateBps: 500,
          });
          const [contact] = await tx
            .insert(contacts)
            .values({ firstName: "Moving", lastName: "Conversion" })
            .returning({ id: contacts.id });
          const [property] = await tx
            .insert(properties)
            .values({
              contactId: contact!.id,
              addressLine1: "Conversion origin",
              city: "Test",
              state: "NY",
              postalCode: "14604",
            })
            .returning({ id: properties.id });
          const createQuote = async () => {
            const [quote] = await tx
              .insert(appointments)
              .values({
                contactId: contact!.id,
                propertyId: property!.id,
                type: "in_person_quote",
                status: "confirmed",
                startAt: completedAt,
                durationMinutes: 120,
                quotedScopeText: "Move household furniture to the new address.",
                rescheduleToken: randomUUID(),
              })
              .returning({
                id: appointments.id,
                updatedAt: appointments.updatedAt,
              });
            return quote!;
          };
          const quote = await createQuote();
          const payload = {
            startAt: completedAt.toISOString(),
            soldByMemberId: owner.id,
            expectedSoldByMemberId: null,
            expectedAssignedSalespersonMemberId: null,
            quotedTotalCents: 60000,
            expectedStatus: "confirmed",
            bookingDetails: {
              serviceType: "moving",
              source: { type: "google" },
              pricing: { mode: "exact" },
              moving: { destinationAddress: "Moving destination" },
            },
            completion: {
              finalTotalCents: 60000,
              expectedFinalTotalCents: null,
              completedAt: completedAt.toISOString(),
              crewMembers: [
                {
                  memberId: mover.id,
                  hourlyRateCents: 3000,
                  workedMinutes: 150,
                },
              ],
            },
          };
          const makeRequest = (
            id: string,
            version: Date,
            key: string,
            body: unknown = payload,
          ) => {
            const request = new NextRequest(
              `http://crm.test/api/appointments/${id}/convert`,
              {
                method: "POST",
                headers: {
                  origin: "http://crm.test",
                  host: "crm.test",
                  "content-type": "application/json",
                  "if-match": `"${version.toISOString()}"`,
                  "idempotency-key": key,
                },
                body: JSON.stringify(body),
              },
            );
            setVerifiedRequestActor(request, {
              type: "human",
              id: owner.id,
              role: "owner",
              label: "Moving test owner",
              authMethod: "team_session",
              sessionId: owner.id,
            });
            return request;
          };
          const key = `moving-convert-${randomUUID()}`;
          const response = await convertQuote(
            makeRequest(quote.id, quote.updatedAt, key),
            { params: Promise.resolve({ id: quote.id }) },
          );
          const result = (await response.json()) as Record<string, unknown>;
          if (!result["ok"]) throw new Error(JSON.stringify(result));
          expect(result).toMatchObject({
            ok: true,
            data: {
              status: "completed",
              appointmentType: "job",
              completedAtomically: true,
            },
          });
          expect(response.status).toBe(200);
          const [savedCrew] = await tx
            .select()
            .from(appointmentCrewMembers)
            .where(eq(appointmentCrewMembers.appointmentId, quote.id));
          expect(savedCrew).toMatchObject({
            memberId: mover.id,
            splitBps: 0,
            hourlyRateCents: 3000,
            workedMinutes: 150,
          });
          const earnings = await tx
            .select()
            .from(appointmentCommissions)
            .where(eq(appointmentCommissions.appointmentId, quote.id));
          expect(earnings.find((row) => row.role === "crew")).toMatchObject({
            amountCents: 7500,
            meta: {
              compensationType: "hourly",
              hourlyRateCents: 3000,
              workedMinutes: 150,
            },
          });
          expect(
            earnings.find((row) => row.role === "marketing")?.amountCents,
          ).toBe(3000);
          const replay = await convertQuote(
            makeRequest(quote.id, quote.updatedAt, key),
            { params: Promise.resolve({ id: quote.id }) },
          );
          expect(await replay.json()).toEqual(result);
          expect(replay.headers.get("idempotency-replayed")).toBe("true");
          const mismatchedRetry = await convertQuote(
            makeRequest(quote.id, quote.updatedAt, key, {
              ...payload,
              completion: {
                ...payload.completion,
                crewMembers: [
                  {
                    memberId: mover.id,
                    hourlyRateCents: 3000,
                    workedMinutes: 180,
                  },
                ],
              },
            }),
            { params: Promise.resolve({ id: quote.id }) },
          );
          expect(mismatchedRetry.status).toBe(409);
          expect(
            await tx
              .select()
              .from(appointmentCommissions)
              .where(eq(appointmentCommissions.appointmentId, quote.id)),
          ).toEqual(earnings);
          const successAudits = await tx
            .select()
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.entityId, quote.id),
                eq(auditLogs.action, "appointment.converted"),
              ),
            );
          expect(successAudits).toHaveLength(1);
          const receipts = await tx
            .select()
            .from(teamMutationIdempotency)
            .where(
              eq(
                teamMutationIdempotency.keyHash,
                createHash("sha256").update(key).digest("hex"),
              ),
            );
          expect(
            receipts.filter((row) => row.status === "succeeded"),
          ).toHaveLength(1);

          const period = resolveCurrentPayoutPeriod(completedAt, settings);
          await tx.insert(payoutRuns).values({
            timezone: period.timezone,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            scheduledPayoutAt: period.scheduledPayoutAt,
            periodCanonical: true,
            status: "locked",
            lockedAt: new Date(),
            createdBy: owner.id,
          });
          const blockedQuote = await createQuote();
          const blocked = await convertQuote(
            makeRequest(
              blockedQuote.id,
              blockedQuote.updatedAt,
              `moving-locked-${randomUUID()}`,
            ),
            { params: Promise.resolve({ id: blockedQuote.id }) },
          );
          expect(blocked.status).toBe(409);
          expect(await blocked.json()).toMatchObject({
            ok: false,
            code: "conflict",
          });
          const [unchanged] = await tx
            .select()
            .from(appointments)
            .where(eq(appointments.id, blockedQuote.id));
          expect(unchanged).toMatchObject({
            type: "in_person_quote",
            status: "confirmed",
            finalTotalCents: null,
            completedAt: null,
          });
          expect(
            await tx
              .select()
              .from(appointmentCrewMembers)
              .where(eq(appointmentCrewMembers.appointmentId, blockedQuote.id)),
          ).toEqual([]);
          expect(
            await tx
              .select()
              .from(appointmentCommissions)
              .where(eq(appointmentCommissions.appointmentId, blockedQuote.id)),
          ).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      mockBoundDb = undefined;
    }
  });
});

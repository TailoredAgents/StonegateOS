import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  closeDbForTests,
  partnerAccounts,
  contacts,
  properties,
  partnerBookings,
  appointments,
  partnerServiceCatalog,
  partnerSchedulingProfiles,
  scheduleResourcePools,
  scheduleResources,
  partnerSchedulingProfileResourceRequirements,
  teamMembers,
  teamRoles,
  scheduleBlocks,
  scheduleDateOverrides,
} from "@/db";
import {
  acquireScheduleConflictLock,
  filterScheduleReadCandidates,
  inspectScheduleConflicts,
} from "@/lib/appointment-schedule-conflicts";
import { synchronizePartnerStaffSchedule } from "@/lib/partner-staff-schedule";
import {
  readStaffResourceConfiguration,
  saveStaffResourceConfiguration,
} from "@/lib/staff-scheduling-resources";
import type { TeamMutationContext } from "@/lib/team-mutation";
const local =
  process.env["DATABASE_URL"] &&
  ["localhost", "127.0.0.1"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;
const NOW = new Date("2035-06-01T12:00:00Z"),
  START = new Date("2035-06-04T14:00:00Z");
async function fixture() {
  const accountId = randomUUID(),
    contactId = randomUUID(),
    propertyId = randomUUID(),
    profileId = randomUUID(),
    poolKey = `named_${randomUUID().replaceAll("-", "")}`,
    serviceKey = `named_${randomUUID().replaceAll("-", "")}`,
    crewId = randomUUID(),
    truckId = randomUUID(),
    equipmentId = randomUUID(),
    otherCrewId = randomUUID();
  await getDb().transaction(async (tx) => {
    await tx
      .insert(partnerAccounts)
      .values({
        id: accountId,
        name: "Local named resource account",
        normalizedName: accountId,
        portalAccessEnabled: true,
      });
    await tx
      .insert(contacts)
      .values({
        id: contactId,
        firstName: "Local",
        lastName: "Named resources",
      });
    await tx
      .insert(properties)
      .values({
        id: propertyId,
        contactId,
        addressLine1: "1 Test Way",
        city: "Atlanta",
        state: "GA",
        postalCode: "30301",
      });
    await tx
      .insert(scheduleResourcePools)
      .values({
        key: poolKey,
        label: "Local named resource pool",
        capacityUnits: 3,
      });
    await tx
      .insert(partnerServiceCatalog)
      .values({
        key: serviceKey,
        label: "Local named resource service",
        description: "Synthetic local resource test",
        active: true,
        instantBookable: true,
      });
    await tx
      .insert(partnerSchedulingProfiles)
      .values({
        id: profileId,
        serviceKey,
        version: 1,
        durationMinutes: 60,
        travelBufferMinutes: 30,
        capacityPoolKey: poolKey,
        capacityUnits: 1,
        effectiveFrom: new Date("2030-01-01T00:00:00Z"),
      });
    await tx.insert(scheduleResources).values(
      [
        {
          id: crewId,
          kind: "crew",
          label: "Heavy lift crew",
          skillKeys: ["heavy_lift"],
        },
        { id: otherCrewId, kind: "crew", label: "General crew", skillKeys: [] },
        { id: truckId, kind: "truck", label: "Truck A", skillKeys: [] },
        {
          id: equipmentId,
          kind: "equipment",
          label: "Lift A",
          skillKeys: ["lift_gate"],
        },
      ].map((row) => ({
        ...row,
        capacityPoolKey: poolKey,
        kind: row.kind as "crew" | "truck" | "equipment",
        capacityUnits: 1,
        source: "staff" as const,
      })),
    );
    await tx
      .delete(partnerSchedulingProfileResourceRequirements)
      .where(
        eq(
          partnerSchedulingProfileResourceRequirements.schedulingProfileId,
          profileId,
        ),
      );
    await tx.insert(partnerSchedulingProfileResourceRequirements).values(
      [
        { resourceKind: "crew" as const, requiredSkillKeys: ["heavy_lift"] },
        { resourceKind: "truck" as const, requiredSkillKeys: [] },
        {
          resourceKind: "equipment" as const,
          requiredSkillKeys: ["lift_gate"],
        },
      ].map((row) => ({
        ...row,
        schedulingProfileId: profileId,
        quantity: 1,
        capacityUnits: 1,
        source: "staff" as const,
      })),
    );
  });
  async function job() {
    const appointmentId = randomUUID(),
      jobId = randomUUID();
    await getDb().transaction(async (tx) => {
      await tx
        .insert(appointments)
        .values({
          id: appointmentId,
          partnerAccountId: accountId,
          contactId,
          propertyId,
          status: "requested",
          type: "job",
          capacityPoolKey: poolKey,
          capacityUnits: 1,
          durationMinutes: 60,
          travelBufferMinutes: 30,
          rescheduleToken: randomUUID(),
        });
      await tx
        .insert(partnerBookings)
        .values({
          id: jobId,
          partnerAccountId: accountId,
          orgContactId: contactId,
          propertyId,
          appointmentId,
          serviceKey,
          publicStatus: "under_review",
        });
    });
    return { appointmentId, jobId };
  }
  return {
    accountId,
    profileId,
    poolKey,
    crewId,
    otherCrewId,
    truckId,
    equipmentId,
    job,
  };
}
async function schedule(
  job: { appointmentId: string },
  selectedResourceIds?: string[],
  startAt = START,
  previousStartAt: Date | null = null,
) {
  return getDb().transaction(async (tx) => {
    await synchronizePartnerStaffSchedule(tx, {
      appointmentId: job.appointmentId,
      startAt,
      previousStartAt,
      now: NOW,
      actorTeamMemberId: null,
      correlationId: "local-named-resource",
      selectedResourceIds,
    });
    await tx
      .update(appointments)
      .set({ startAt, status: "confirmed" })
      .where(eq(appointments.id, job.appointmentId));
  });
}
suite("staff named-resource scheduling / PostgreSQL", () => {
  afterAll(async () => closeDbForTests());
  it("public read filtering matches locked weighted, buffer, external-block and date-override decisions", async () => {
    const f = await fixture(),
      job = await f.job();
    await getDb()
      .update(appointments)
      .set({ startAt: START, status: "confirmed", capacityUnits: 2 })
      .where(eq(appointments.id, job.appointmentId));
    await getDb()
      .insert(scheduleBlocks)
      .values({
        kind: "external_busy",
        source: "local_resource_test",
        capacityPoolKey: f.poolKey,
        capacityUnits: 3,
        startAt: new Date("2035-06-04T18:00:00Z"),
        endAt: new Date("2035-06-04T19:00:00Z"),
      });
    const candidates = [
      "2035-06-04T14:00:00Z",
      "2035-06-04T15:00:00Z",
      "2035-06-04T15:30:00Z",
      "2035-06-04T17:00:00Z",
      "2035-06-04T19:00:00Z",
    ].map((startAt) => ({ startAt }));
    const input = {
      candidates,
      durationMinutes: 60,
      travelBufferMinutes: 30,
      capacity: 9,
      capacityPoolKey: f.poolKey,
      capacityUnits: 2,
      timezone: "America/New_York",
      now: NOW,
    };
    const read = await filterScheduleReadCandidates(input);
    const locked = await getDb().transaction(async (tx) => {
      await acquireScheduleConflictLock(tx);
      const results = await Promise.all(
        candidates.map((candidate) =>
          inspectScheduleConflicts(tx, {
            ...input,
            startAt: new Date(candidate.startAt),
          }),
        ),
      );
      return candidates.filter((_, index) => !results[index]!.conflict);
    });
    expect(read).toEqual(locked);
    expect(read.map((row) => row.startAt)).toEqual([
      "2035-06-04T15:30:00Z",
      "2035-06-04T19:00:00Z",
    ]);
    const day = "2035-06-04";
    const [previous] = await getDb()
      .select()
      .from(scheduleDateOverrides)
      .where(
        and(
          eq(scheduleDateOverrides.localDate, day),
          eq(scheduleDateOverrides.timezone, input.timezone),
        ),
      );
    try {
      await getDb()
        .insert(scheduleDateOverrides)
        .values({
          localDate: day,
          timezone: input.timezone,
          reason: "Local named-resource read parity",
          capacityByPool: { [f.poolKey]: 1 },
        })
        .onConflictDoUpdate({
          target: [
            scheduleDateOverrides.localDate,
            scheduleDateOverrides.timezone,
          ],
          set: {
            capacityByPool: {
              ...(previous?.capacityByPool ?? {}),
              [f.poolKey]: 1,
            },
          },
        });
      expect(await filterScheduleReadCandidates(input)).toEqual([]);
    } finally {
      if (previous)
        await getDb()
          .update(scheduleDateOverrides)
          .set({ capacityByPool: previous.capacityByPool })
          .where(eq(scheduleDateOverrides.id, previous.id));
      else
        await getDb()
          .delete(scheduleDateOverrides)
          .where(
            and(
              eq(scheduleDateOverrides.localDate, day),
              eq(scheduleDateOverrides.timezone, input.timezone),
            ),
          );
    }
  });
  it("atomically assigns exactly the required crew/truck/equipment and rejects a competing job despite spare pool units", async () => {
    const f = await fixture(),
      first = await f.job(),
      second = await f.job();
    const outcomes = await Promise.allSettled([
      schedule(first, [f.crewId, f.truckId, f.equipmentId]),
      schedule(second, [f.crewId, f.truckId, f.equipmentId]),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const rows = await getDb()
      .select()
      .from(appointments)
      .where(eq(appointments.partnerAccountId, f.accountId));
    const confirmed = rows.find((row) => row.status === "confirmed")!;
    expect(
      confirmed.resourceAssignmentSnapshot.map((row) => row.resourceId).sort(),
    ).toEqual([f.crewId, f.truckId, f.equipmentId].sort());
    expect(rows.find((row) => row.status === "requested")?.startAt).toBeNull();
    const retry = first.appointmentId === confirmed.id ? second : first;
    await expect(
      schedule(retry, undefined, new Date("2035-06-04T15:00:00Z")),
    ).rejects.toMatchObject({ status: 409 }); // cleanup buffer still occupies resources
    await schedule(retry, undefined, new Date("2035-06-04T15:30:00Z")); // exact half-open boundary
  });
  it("rejects wrong skills, duplicate/inactive/foreign resource IDs and preserves the old schedule on a failed reassignment", async () => {
    const f = await fixture(),
      foreign = await fixture(),
      job = await f.job();
    await expect(
      schedule(job, [f.otherCrewId, f.truckId, f.equipmentId]),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      schedule(job, [foreign.crewId, f.truckId, f.equipmentId]),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      schedule(job, [f.crewId, f.crewId, f.truckId, f.equipmentId]),
    ).rejects.toMatchObject({ status: 422 });
    await schedule(job, [f.crewId, f.truckId, f.equipmentId]);
    await getDb()
      .update(scheduleResources)
      .set({ active: false })
      .where(eq(scheduleResources.id, f.equipmentId));
    await expect(
      schedule(
        job,
        [f.crewId, f.truckId, f.equipmentId],
        new Date("2035-06-05T14:00:00Z"),
        START,
      ),
    ).rejects.toMatchObject({ status: 422 });
    const [unchanged] = await getDb()
      .select()
      .from(appointments)
      .where(eq(appointments.id, job.appointmentId));
    expect(unchanged?.startAt?.toISOString()).toBe(START.toISOString());
    expect(unchanged?.resourceAssignmentSnapshot).toHaveLength(3);
  });
  it("configuration mutations require current policy permission, revision and explicit impact acknowledgment", async () => {
    const f = await fixture(),
      roleId = randomUUID(),
      staffId = randomUUID();
    await getDb()
      .insert(teamRoles)
      .values({
        id: roleId,
        name: "Local scheduler",
        slug: `local_${roleId}`,
        permissions: ["policy.read", "policy.write"],
      });
    await getDb()
      .insert(teamMembers)
      .values({
        id: staffId,
        name: "Local scheduler",
        email: `${staffId}@example.test`,
        roleId,
        active: true,
      });
    const config = await readStaffResourceConfiguration();
    const mutation = {
      actor: { id: staffId },
      expectedVersion: config.version,
    } as unknown as TeamMutationContext;
    const input = {
      operation: "resource" as const,
      id: f.crewId,
      capacityPoolKey: f.poolKey,
      kind: "crew" as const,
      label: "Renamed local crew",
      capacityUnits: 1,
      skillKeys: ["heavy_lift"],
      active: true,
      reason: "Rename to the current crew label",
      acknowledgeImpact: true,
    };
    await expect(
      getDb().transaction((tx) =>
        saveStaffResourceConfiguration(tx, mutation, {
          ...input,
          acknowledgeImpact: false,
        }),
      ),
    ).rejects.toThrow(/Confirm/u);
    const saved = await getDb().transaction((tx) =>
      saveStaffResourceConfiguration(tx, mutation, input),
    );
    expect(
      saved.configuration.resources.find((resource) => resource.id === f.crewId)
        ?.label,
    ).toBe(input.label);
    await expect(
      getDb().transaction((tx) =>
        saveStaffResourceConfiguration(tx, mutation, input),
      ),
    ).rejects.toThrow(/changed/u);
    const removed = await getDb().transaction((tx) =>
      saveStaffResourceConfiguration(
        tx,
        { ...mutation, expectedVersion: saved.configuration.version },
        {
          operation: "remove_requirement",
          profileId: f.profileId,
          resourceKind: "equipment",
          reason: "Service no longer needs the lift equipment",
          acknowledgeImpact: true,
        },
      ),
    );
    expect(removed.removedRequirement?.schedulingProfileId).toBe(f.profileId);
    expect(
      removed.configuration.requirements
        .filter(
          (requirement) => requirement.schedulingProfileId === f.profileId,
        )
        .map((requirement) => requirement.resourceKind)
        .sort(),
    ).toEqual(["crew", "truck"]);
    await getDb()
      .update(teamRoles)
      .set({ permissions: [] })
      .where(eq(teamRoles.id, roleId));
    await expect(
      getDb().transaction((tx) =>
        saveStaffResourceConfiguration(
          tx,
          { ...mutation, expectedVersion: removed.configuration.version },
          input,
        ),
      ),
    ).rejects.toThrow(/permission/u);
  });
});

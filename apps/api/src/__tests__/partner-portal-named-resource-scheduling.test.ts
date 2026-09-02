import {
  assignNamedScheduleResources,
  createScheduleInterval,
  type NamedScheduleResource,
  type NamedScheduleResourceBlock,
  type NamedScheduleResourceRequirement,
} from "@/lib/scheduling";

const occupancy = createScheduleInterval(
  new Date("2026-09-08T13:00:00.000Z"),
  new Date("2026-09-08T15:00:00.000Z"),
);

const resources: readonly NamedScheduleResource[] = [
  {
    id: "crew-a",
    capacityPoolKey: "field_service",
    kind: "crew",
    label: "Crew Alpha",
    capacityUnits: 1,
    dailyJobMultiplier: 1,
    skillKeys: ["general_field_service", "heavy_lift"],
  },
  {
    id: "crew-b",
    capacityPoolKey: "field_service",
    kind: "crew",
    label: "Crew Bravo",
    capacityUnits: 1,
    dailyJobMultiplier: 1,
    skillKeys: ["general_field_service"],
  },
  {
    id: "truck-a",
    capacityPoolKey: "field_service",
    kind: "truck",
    label: "Truck 12",
    capacityUnits: 1,
    dailyJobMultiplier: 1,
    skillKeys: ["general_field_service"],
  },
];

const requirements: readonly NamedScheduleResourceRequirement[] = [
  {
    kind: "crew",
    quantity: 1,
    capacityUnits: 1,
    requiredSkillKeys: ["general_field_service"],
  },
  {
    kind: "truck",
    quantity: 1,
    capacityUnits: 1,
    requiredSkillKeys: ["general_field_service"],
  },
];

function block(
  id: string,
  resourceId: string,
  startAt: string,
  endAt: string,
): NamedScheduleResourceBlock {
  return {
    id,
    resourceId,
    capacityUnits: 1,
    occupancy: createScheduleInterval(new Date(startAt), new Date(endAt)),
    localDate: "2026-09-08",
  };
}

describe("Partner named resource scheduling", () => {
  it("assigns a deterministic eligible crew and truck while respecting overlap", () => {
    const result = assignNamedScheduleResources({
      capacityPoolKey: "field_service",
      occupancy,
      localDate: "2026-09-08",
      resources,
      requirements,
      blocks: [
        // This block begins before the candidate; clipping must still consume
        // Crew Alpha throughout the overlapping portion.
        block(
          "job-before",
          "crew-a",
          "2026-09-08T12:00:00.000Z",
          "2026-09-08T14:00:00.000Z",
        ),
      ],
      maxJobsPerCrew: 4,
    });

    expect(result).toEqual({
      available: true,
      reason: "available",
      assignments: [
        {
          resourceId: "crew-b",
          kind: "crew",
          label: "Crew Bravo",
          capacityUnits: 1,
        },
        {
          resourceId: "truck-a",
          kind: "truck",
          label: "Truck 12",
          capacityUnits: 1,
        },
      ],
    });
  });

  it("routes a skill gap to no-slot behavior instead of guessing an assignment", () => {
    const result = assignNamedScheduleResources({
      capacityPoolKey: "field_service",
      occupancy,
      localDate: "2026-09-08",
      resources,
      requirements: [
        {
          kind: "truck",
          quantity: 1,
          capacityUnits: 1,
          requiredSkillKeys: ["hazmat_certified"],
        },
      ],
      blocks: [],
      maxJobsPerCrew: 4,
    });

    expect(result).toEqual({
      available: false,
      reason: "skill_unavailable",
      assignments: [],
    });
  });

  it("enforces the legacy per-crew daily limit independently of overlap", () => {
    const result = assignNamedScheduleResources({
      capacityPoolKey: "field_service",
      occupancy,
      localDate: "2026-09-08",
      resources: [{ ...resources[0]!, capacityUnits: 2 }],
      requirements: [requirements[0]!],
      blocks: [
        block(
          "job-1",
          "crew-a",
          "2026-09-08T08:00:00.000Z",
          "2026-09-08T09:00:00.000Z",
        ),
        block(
          "job-2",
          "crew-a",
          "2026-09-08T10:00:00.000Z",
          "2026-09-08T11:00:00.000Z",
        ),
      ],
      maxJobsPerCrew: 2,
    });

    expect(result).toEqual({
      available: false,
      reason: "crew_daily_limit",
      assignments: [],
    });
  });

  it("charges weighted jobs against every crew represented by a compatibility resource", () => {
    const compatibilityCrew: NamedScheduleResource = {
      ...resources[0]!,
      id: "compatibility-crew",
      label: "Field service crew pool",
      capacityUnits: 4,
      dailyJobMultiplier: 4,
    };
    const priorJobs = Array.from({ length: 6 }, (_, index) => ({
      ...block(
        `weighted-job-${index + 1}`,
        compatibilityCrew.id,
        `2026-09-08T${String(index + 1).padStart(2, "0")}:00:00.000Z`,
        `2026-09-08T${String(index + 1).padStart(2, "0")}:30:00.000Z`,
      ),
      capacityUnits: 2,
    }));

    const result = assignNamedScheduleResources({
      capacityPoolKey: "field_service",
      occupancy,
      localDate: "2026-09-08",
      resources: [compatibilityCrew],
      requirements: [
        {
          kind: "crew",
          quantity: 1,
          capacityUnits: 2,
          requiredSkillKeys: ["general_field_service"],
        },
      ],
      blocks: priorJobs,
      maxJobsPerCrew: 3,
    });

    expect(result).toEqual({
      available: false,
      reason: "crew_daily_limit",
      assignments: [],
    });
  });
});

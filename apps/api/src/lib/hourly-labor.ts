import { z } from "zod";

export const MAXIMUM_LABOR_CENTS = 2_147_483_647;
export const MAXIMUM_WORKED_MINUTES = 525_600;

export function isMovingCommissionJob(input: {
  bookingDetails?: unknown;
}): boolean {
  const details = input.bookingDetails;
  return (
    typeof details === "object" &&
    details !== null &&
    "serviceType" in details &&
    details.serviceType === "moving"
  );
}

/** Round once per worker, to the nearest cent, using integer minutes. */
export function calculateHourlyLaborCents(
  hourlyRateCents: number,
  workedMinutes: number,
): number {
  if (
    !Number.isInteger(hourlyRateCents) ||
    hourlyRateCents <= 0 ||
    hourlyRateCents > MAXIMUM_LABOR_CENTS ||
    !Number.isInteger(workedMinutes) ||
    workedMinutes <= 0 ||
    workedMinutes > MAXIMUM_WORKED_MINUTES
  ) {
    throw new Error("invalid_hourly_labor");
  }
  const cents = Math.round((hourlyRateCents * workedMinutes) / 60);
  if (cents > MAXIMUM_LABOR_CENTS)
    throw new Error("hourly_labor_exceeds_limit");
  return cents;
}

export const HourlyCrewMemberSchema = z
  .object({
    memberId: z.string().uuid(),
    hourlyRateCents: z.number().int().positive().max(MAXIMUM_LABOR_CENTS),
    workedMinutes: z.number().int().positive().max(MAXIMUM_WORKED_MINUTES),
  })
  .strict()
  .refine(
    (entry) =>
      Math.round((entry.hourlyRateCents * entry.workedMinutes) / 60) <=
      MAXIMUM_LABOR_CENTS,
    {
      message: "Hourly pay exceeds the supported amount.",
    },
  );

export const CompletionCrewMemberSchema = z.union([
  z
    .object({
      memberId: z.string().uuid(),
      splitBps: z.number().int().min(0).max(10_000),
    })
    .strict(),
  HourlyCrewMemberSchema,
]);

export const CompletionCrewMembersSchema = z
  .array(CompletionCrewMemberSchema)
  .max(50)
  .superRefine((crew, context) => {
    if (new Set(crew.map((entry) => entry.memberId)).size !== crew.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Select each crew member only once.",
      });
    }
    const total = crew.reduce(
      (sum, entry) =>
        sum +
        ("hourlyRateCents" in entry
          ? Math.round((entry.hourlyRateCents * entry.workedMinutes) / 60)
          : 0),
      0,
    );
    if (total > MAXIMUM_LABOR_CENTS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Total hourly labor exceeds the supported amount.",
      });
    }
  });

export type CompletionCrewMember = {
  memberId: string;
  splitBps: number;
  fixedJobRateBps?: number | null;
  hourlyRateCents?: number | null;
  workedMinutes?: number | null;
};

export function normalizeCompletionCrew(
  crew: z.infer<typeof CompletionCrewMembersSchema>,
): CompletionCrewMember[] {
  return crew
    .map((entry) =>
      "hourlyRateCents" in entry
        ? { ...entry, splitBps: 0, fixedJobRateBps: null }
        : { ...entry, hourlyRateCents: null, workedMinutes: null },
    )
    .sort((a, b) => a.memberId.localeCompare(b.memberId));
}

export function hasValidCrewCompensationMode(
  isMoving: boolean,
  crew: readonly CompletionCrewMember[],
): boolean {
  return crew.every((entry) =>
    isMoving
      ? HourlyCrewMemberSchema.safeParse({
          memberId: entry.memberId,
          hourlyRateCents: entry.hourlyRateCents,
          workedMinutes: entry.workedMinutes,
        }).success &&
        entry.splitBps === 0 &&
        entry.fixedJobRateBps == null
      : entry.hourlyRateCents == null && entry.workedMinutes == null,
  );
}

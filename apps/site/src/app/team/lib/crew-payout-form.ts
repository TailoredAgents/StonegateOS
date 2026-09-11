export type SavedCrewPayout = {
  memberId: string;
  hourlyRateCents?: number | null;
  workedMinutes?: number | null;
};

export type CrewPayoutInput =
  | { memberId: string; splitBps: number }
  | { memberId: string; hourlyRateCents: number; workedMinutes: number };

const MAX_CENTS = 2_147_483_647;
const MAX_MINUTES = 525_600;

export function parseHourlyRateCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/u.test(input)) return null;
  const [whole = "", fraction = ""] = input.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_CENTS
    ? cents
    : null;
}

export function parseWorkedMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!/^\d+(?:\.\d+)?$/u.test(input)) return null;
  const minutes = Math.round(Number(input) * 60);
  return Number.isSafeInteger(minutes) && minutes > 0 && minutes <= MAX_MINUTES
    ? minutes
    : null;
}

export function hourlyPayoutCents(
  hourlyRateCents: number,
  workedMinutes: number,
): number | null {
  const cents = Math.round((hourlyRateCents * workedMinutes) / 60);
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= MAX_CENTS
    ? cents
    : null;
}

export function parseCrewPayoutFormData(
  formData: FormData,
  isMoving = formData.get("crewCompensationMode") === "hourly",
): { ok: true; crewMembers: CrewPayoutInput[] } | { ok: false; error: string } {
  const memberIds = [
    ...new Set(
      formData
        .getAll("crewMemberId")
        .flatMap((value) =>
          typeof value === "string" && value.trim() ? [value.trim()] : [],
        ),
    ),
  ].sort();
  if (memberIds.length === 0) {
    return {
      ok: false,
      error: "Select at least one crew member who worked this job.",
    };
  }
  if (memberIds.length > 50) {
    return { ok: false, error: "Select no more than 50 crew members." };
  }
  if (!isMoving) {
    // The API resolves the labor pool from this roster and splits it equally.
    return {
      ok: true,
      crewMembers: memberIds.map((memberId) => ({ memberId, splitBps: 1 })),
    };
  }

  const crewMembers: CrewPayoutInput[] = [];
  let totalPayoutCents = 0;
  for (const memberId of memberIds) {
    const hourlyRateCents = parseHourlyRateCents(
      formData.get(`crewHourlyRate:${memberId}`),
    );
    const workedMinutes = parseWorkedMinutes(
      formData.get(`crewHours:${memberId}`),
    );
    if (hourlyRateCents === null || workedMinutes === null) {
      return {
        ok: false,
        error:
          "Enter a positive hourly rate and hours worked for every selected crew member.",
      };
    }
    const payoutCents = hourlyPayoutCents(hourlyRateCents, workedMinutes);
    if (payoutCents === null || totalPayoutCents + payoutCents > MAX_CENTS) {
      return {
        ok: false,
        error:
          "Review the hourly rate and hours: the calculated payout is outside the supported range.",
      };
    }
    totalPayoutCents += payoutCents;
    crewMembers.push({ memberId, hourlyRateCents, workedMinutes });
  }
  return { ok: true, crewMembers };
}

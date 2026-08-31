import { SchedulingDomainError } from "./errors";
import { requireSchedulingServiceKey } from "./service-keys";
import type { ScheduleDemand } from "./types";

export const MAX_SCHEDULE_DURATION_MINUTES = 24 * 60;
export const MAX_TRAVEL_BUFFER_MINUTES = 24 * 60;
export const MAX_CAPACITY_UNITS = 100;

const CAPACITY_POOL_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

function requireIntegerInRange(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new SchedulingDomainError(
      "invalid_demand",
      `The scheduling ${field} is invalid.`,
    );
  }
  return value;
}

export function createScheduleDemand(input: {
  serviceKey: unknown;
  durationMinutes: unknown;
  travelBufferMinutes: unknown;
  capacityPoolKey: unknown;
  capacityUnits: unknown;
  allowsInstantConfirmation?: unknown;
}): ScheduleDemand {
  const serviceKey = requireSchedulingServiceKey(input.serviceKey);
  const durationMinutes = requireIntegerInRange(
    input.durationMinutes,
    "duration",
    15,
    MAX_SCHEDULE_DURATION_MINUTES,
  );
  const travelBufferMinutes = requireIntegerInRange(
    input.travelBufferMinutes,
    "travel buffer",
    0,
    MAX_TRAVEL_BUFFER_MINUTES,
  );
  const capacityUnits = requireIntegerInRange(
    input.capacityUnits,
    "capacity demand",
    1,
    MAX_CAPACITY_UNITS,
  );
  const capacityPoolKey =
    typeof input.capacityPoolKey === "string"
      ? input.capacityPoolKey.trim().toLowerCase()
      : "";
  if (!CAPACITY_POOL_KEY_PATTERN.test(capacityPoolKey)) {
    throw new SchedulingDomainError(
      "invalid_demand",
      "The scheduling capacity pool is invalid.",
    );
  }
  if (
    input.allowsInstantConfirmation !== undefined &&
    typeof input.allowsInstantConfirmation !== "boolean"
  ) {
    throw new SchedulingDomainError(
      "invalid_demand",
      "The instant-confirm setting is invalid.",
    );
  }

  return Object.freeze({
    serviceKey,
    durationMinutes,
    travelBufferMinutes,
    capacityPoolKey,
    capacityUnits,
    // An omitted profile flag must never silently elevate a booking from
    // requested/manual review to confirmed.
    allowsInstantConfirmation: input.allowsInstantConfirmation === true,
  });
}

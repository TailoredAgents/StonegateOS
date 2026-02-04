export const DEFAULT_APPOINTMENT_CAPACITY = 2;

export function getAppointmentCapacity(): number {
  const raw =
    (process.env["APPOINTMENT_CAPACITY"] ?? process.env["BOOKING_CAPACITY"] ?? "").trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(8, Math.floor(parsed));
  }
  return DEFAULT_APPOINTMENT_CAPACITY;
}


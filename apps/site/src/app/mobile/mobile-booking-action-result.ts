export type MobileBookingActionResult =
  | { ok: true; appointmentId: string; version: string; message: string }
  | { ok: false; error: string; uncertain?: boolean; submitted?: boolean };

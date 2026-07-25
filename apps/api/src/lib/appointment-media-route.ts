import { NextResponse } from "next/server";
import { AppointmentMediaError } from "@/lib/appointment-media";

export function appointmentMediaErrorResponse(error: unknown): NextResponse {
  if (error instanceof AppointmentMediaError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  const message =
    error instanceof Error ? error.message : "appointment_media_failed";
  if (message === "media_storage_credentials_missing") {
    return NextResponse.json(
      { error: "media_storage_not_configured" },
      { status: 503 },
    );
  }
  console.error("[appointment-media]", error);
  return NextResponse.json(
    { error: "appointment_media_failed" },
    { status: 500 },
  );
}
export function actorMemberId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalized,
  )
    ? normalized
    : null;
}

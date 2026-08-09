import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

/**
 * The legacy appointment attachment path stored caller-provided URLs and data
 * URLs directly in PostgreSQL without private object storage, signature/MIME
 * verification, scanning, quotas, or signed reads. It is intentionally closed
 * until the appointment-media object-storage pipeline replaces it. Historical
 * records remain readable to authorized appointment consumers; this endpoint
 * can no longer create unsafe records.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(
    request,
    "appointments.update",
  );
  if (permissionError) return permissionError;

  return NextResponse.json(
    {
      error: "appointment_attachments_retired",
      message:
        "Legacy appointment attachments are disabled. Use the private appointment media workflow.",
      retryable: false,
    },
    { status: 410 },
  );
}

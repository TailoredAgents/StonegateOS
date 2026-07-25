import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppointmentMediaContentUrl } from "@/lib/appointment-media";
import { appointmentMediaErrorResponse } from "@/lib/appointment-media-route";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const VariantSchema = z.enum(["original", "display", "thumbnail"]);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.read");
  if (permissionError) return permissionError;
  const { id: mediaId } = await context.params;
  const parsed = VariantSchema.safeParse(
    request.nextUrl.searchParams.get("variant") ?? "display",
  );
  if (!mediaId || !parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const url = await getAppointmentMediaContentUrl({
      mediaId,
      variant: parsed.data,
    });
    return NextResponse.redirect(url, {
      status: 307,
      headers: {
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    return appointmentMediaErrorResponse(error);
  }
}

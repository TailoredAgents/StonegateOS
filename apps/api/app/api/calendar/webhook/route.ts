import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { recordCalendarNotification, syncGoogleCalendar } from "@/lib/calendar-sync";
import { isGoogleCalendarEnabled } from "@/lib/calendar";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isGoogleCalendarEnabled()) {
    return new NextResponse(null, { status: 204 });
  }

  const channelId = request.headers.get("x-goog-channel-id");
  const resourceId = request.headers.get("x-goog-resource-id");
  const resourceState = request.headers.get("x-goog-resource-state");
  const expiration = request.headers.get("x-goog-channel-expiration");

  await recordCalendarNotification({
    channelId,
    resourceId,
    channelExpiration: expiration
  });

  if (resourceState && ["sync", "exists", "not_exists"].includes(resourceState)) {
    syncGoogleCalendar({ reason: "webhook", channelId, resourceState }).catch((error) => {
      console.error("[calendar-sync] sync_failed", { error: String(error) });
    });
  }

  return new NextResponse(null, { status: 204 });
}

export function GET(): NextResponse {
  return NextResponse.json({ ok: true });
}

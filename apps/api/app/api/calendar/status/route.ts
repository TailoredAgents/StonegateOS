import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, calendarSyncState } from "@/db";
import { getCalendarConfig, isGoogleCalendarEnabled } from "@/lib/calendar";
import { isAdminRequest } from "../../web/admin";

interface CalendarStatusPayload {
  ok: boolean;
  config: {
    calendarId: string | null;
    webhookConfigured: boolean;
  };
  status: {
    calendarId: string;
    syncTokenPresent: boolean;
    channelId: string | null;
    resourceId: string | null;
    channelExpiresAt: string | null;
    lastSyncedAt: string | null;
    lastNotificationAt: string | null;
    updatedAt: string | null;
  } | null;
  error?: string;
}

export async function GET(request: NextRequest): Promise<NextResponse<CalendarStatusPayload>> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({
      ok: false,
      config: {
        calendarId: null,
        webhookConfigured: Boolean(process.env["GOOGLE_CALENDAR_WEBHOOK_URL"])
      },
      status: null,
      error: "unauthorized"
    }, { status: 401 });
  }

  try {
    if (!isGoogleCalendarEnabled()) {
      return NextResponse.json({
        ok: true,
        config: {
          calendarId: null,
          webhookConfigured: false
        },
        status: null
      });
    }

    const config = getCalendarConfig();
    const db = getDb();
    const calendarId = config?.calendarId ?? process.env["GOOGLE_CALENDAR_ID"] ?? null;

    if (!calendarId) {
      return NextResponse.json({
        ok: true,
        config: {
          calendarId: null,
          webhookConfigured: Boolean(process.env["GOOGLE_CALENDAR_WEBHOOK_URL"])
        },
        status: null
      });
    }

    const [state] = await db
      .select({
        calendarId: calendarSyncState.calendarId,
        syncToken: calendarSyncState.syncToken,
        channelId: calendarSyncState.channelId,
        resourceId: calendarSyncState.resourceId,
        channelExpiresAt: calendarSyncState.channelExpiresAt,
        lastSyncedAt: calendarSyncState.lastSyncedAt,
        lastNotificationAt: calendarSyncState.lastNotificationAt,
        updatedAt: calendarSyncState.updatedAt
      })
      .from(calendarSyncState)
      .where(eq(calendarSyncState.calendarId, calendarId))
      .limit(1);

    return NextResponse.json({
      ok: true,
      config: {
        calendarId,
        webhookConfigured: Boolean(process.env["GOOGLE_CALENDAR_WEBHOOK_URL"])
      },
      status: state
        ? {
            calendarId: state.calendarId,
            syncTokenPresent: Boolean(state.syncToken),
            channelId: state.channelId,
            resourceId: state.resourceId,
            channelExpiresAt: state.channelExpiresAt ? state.channelExpiresAt.toISOString() : null,
            lastSyncedAt: state.lastSyncedAt ? state.lastSyncedAt.toISOString() : null,
            lastNotificationAt: state.lastNotificationAt ? state.lastNotificationAt.toISOString() : null,
            updatedAt: state.updatedAt ? state.updatedAt.toISOString() : null
          }
        : null
    });
  } catch (error) {
    console.error("[calendar-status] failed", { error: String(error) });
    return NextResponse.json({
      ok: false,
      config: {
        calendarId: null,
        webhookConfigured: Boolean(process.env["GOOGLE_CALENDAR_WEBHOOK_URL"])
      },
      status: null,
      error: "internal_error"
    }, { status: 500 });
  }
}

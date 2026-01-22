import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, outboxEvents } from "@/db";
import { isAdminRequest } from "../../../../web/admin";

function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const daysRaw =
    body && typeof body === "object" && "days" in body ? (body as Record<string, unknown>)["days"] : undefined;
  const days =
    typeof daysRaw === "number"
      ? daysRaw
      : typeof daysRaw === "string"
        ? Number(daysRaw)
        : NaN;

  const sinceRaw =
    body && typeof body === "object" && "since" in body ? (body as Record<string, unknown>)["since"] : undefined;
  const untilRaw =
    body && typeof body === "object" && "until" in body ? (body as Record<string, unknown>)["until"] : undefined;

  const since = typeof sinceRaw === "string" && isIsoDateString(sinceRaw) ? sinceRaw : null;
  const until = typeof untilRaw === "string" && isIsoDateString(untilRaw) ? untilRaw : null;

  const payload: Record<string, unknown> =
    since && until && since <= until
      ? { since, until }
      : {
          days: Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 30) : 14
        };

  const db = getDb();
  const [event] = await db
    .insert(outboxEvents)
    .values({
      type: "google.ads_insights.sync",
      payload
    })
    .returning({ id: outboxEvents.id });

  return NextResponse.json({ ok: true, queued: true, id: event?.id ?? null, payload });
}

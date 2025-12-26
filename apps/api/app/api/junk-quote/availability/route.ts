import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { DateTime } from "luxon";
import { and, eq, gte, lte, ne } from "drizzle-orm";
import { getDb, appointments, instantQuotes, properties } from "@/db";
import { forwardGeocode } from "@/lib/geocode";
import {
  getBookingRulesPolicy,
  getOutOfAreaMessage,
  getServiceAreaPolicy,
  isPostalCodeAllowed,
  normalizePostalCode
} from "@/lib/policy";
import { APPOINTMENT_TIME_ZONE, DEFAULT_TRAVEL_BUFFER_MIN } from "../../web/scheduling";

const RAW_ALLOWED_ORIGINS =
  process.env["CORS_ALLOW_ORIGINS"] ?? process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "*";

function resolveOrigin(requestOrigin: string | null): string {
  if (RAW_ALLOWED_ORIGINS === "*") return "*";
  const allowed = RAW_ALLOWED_ORIGINS.split(",").map((o) => o.trim().replace(/\/+$/u, "")).filter(Boolean);
  if (!allowed.length) return "*";
  const origin = requestOrigin?.trim().replace(/\/+$/u, "") ?? null;
  if (origin && allowed.includes(origin)) return origin;
  return allowed[0] ?? "*";
}

function applyCors(response: NextResponse, requestOrigin: string | null): NextResponse {
  const origin = resolveOrigin(requestOrigin);
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "*");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

function corsJson(body: unknown, requestOrigin: string | null, init?: ResponseInit): NextResponse {
  return applyCors(NextResponse.json(body, init), requestOrigin);
}

export function OPTIONS(request: NextRequest): NextResponse {
  return applyCors(new NextResponse(null, { status: 204 }), request.headers.get("origin"));
}

const AvailabilitySchema = z.object({
  instantQuoteId: z.string().uuid(),
  addressLine1: z.string().min(5),
  city: z.string().min(2),
  state: z.string().min(2).max(2),
  postalCode: z.string().min(3),
  targetLat: z.number().optional(),
  targetLng: z.number().optional()
});

type Suggestion = {
  startAt: string;
  endAt: string;
  reason: string;
};

const WINDOW_DAYS = 14;
const START_HOUR = 8;
const END_HOUR = 18;
const SLOT_INTERVAL_MIN = 60;
const DEFAULT_CAPACITY = 2;
const DEFAULT_RADIUS_KM = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatDayLocal(date: Date): string {
  return (
    DateTime.fromJSDate(date, { zone: "utc" }).setZone(APPOINTMENT_TIME_ZONE).toISODate() ??
    date.toISOString().slice(0, 10)
  );
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function overlapsCount(
  blocks: Array<{ start: Date; end: Date }>,
  start: Date,
  end: Date
): number {
  let count = 0;
  for (const block of blocks) {
    if (overlaps(start, end, block.start, block.end)) count += 1;
  }
  return count;
}

function distanceKm(block: { lat: number | null; lng: number | null }, targetLat: number, targetLng: number): number {
  if (block.lat === null || block.lng === null) return Infinity;
  const R = 6371;
  const dLat = deg2rad(targetLat - block.lat);
  const dLon = deg2rad(targetLng - block.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(block.lat)) *
      Math.cos(deg2rad(targetLat)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function deg2rad(deg: number): number {
  return deg * (Math.PI / 180);
}

function nearestDistanceKm(blocks: Array<{ lat: number | null; lng: number | null }>, targetLat: number, targetLng: number): number | null {
  let best: number | null = null;
  for (const b of blocks) {
    const d = distanceKm(b, targetLat, targetLng);
    if (!Number.isFinite(d)) continue;
    if (best === null || d < best) best = d;
  }
  return best;
}

function sortSuggestions(list: Suggestion[]): Suggestion[] {
  return [...list].sort((a, b) => {
    const extractCount = (reason: string): number => {
      const match = reason.match(/Aligned with (\d+)/i);
      return match ? Number(match[1]) : 0;
    };
    const extractNearest = (reason: string): number => {
      const match = reason.match(/Nearest scheduled job ~([\d.]+)/i);
      return match ? Number(match[1]) : Infinity;
    };
    const aCount = extractCount(a.reason);
    const bCount = extractCount(b.reason);
    if (aCount !== bCount) return bCount - aCount;
    const aDist = extractNearest(a.reason);
    const bDist = extractNearest(b.reason);
    if (aDist !== bDist) return aDist - bDist;
    return Date.parse(a.startAt) - Date.parse(b.startAt);
  });
}

function uniqByStart(list: Suggestion[], limit: number): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (seen.has(item.startAt)) continue;
    seen.add(item.startAt);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function deriveDurationMinutes(quote: { aiResult: unknown; perceivedSize: string }): {
  durationMinutes: number;
  maxUnits: number | null;
  loads: number;
} {
  const ai = isRecord(quote.aiResult) ? quote.aiResult : null;
  const priceHigh = typeof ai?.["priceHigh"] === "number" ? ai["priceHigh"] : null;
  const maxUnits =
    typeof priceHigh === "number" && Number.isFinite(priceHigh) && priceHigh > 0 ? Math.round(priceHigh / 200) : null;

  const fallbackUnits = (() => {
    switch (quote.perceivedSize) {
      case "few_items":
      case "small_area":
        return 2;
      case "one_room_or_half_garage":
        return 3;
      case "big_cleanout":
        return 6;
      default:
        return 3;
    }
  })();

  const units = maxUnits ?? fallbackUnits;
  if (units <= 2) {
    return { durationMinutes: 120, maxUnits, loads: 1 };
  }
  if (units <= 4) {
    return { durationMinutes: 180, maxUnits, loads: 1 };
  }
  const loads = Math.max(2, Math.ceil(units / 4));
  return { durationMinutes: loads * 240, maxUnits, loads };
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  try {
    const parsed = AvailabilitySchema.safeParse(await request.json());
    if (!parsed.success) {
      return corsJson({ ok: false, error: "invalid_payload", details: parsed.error.flatten() }, requestOrigin, {
        status: 400
      });
    }

    const body = parsed.data;
    const normalizedPostalCode = normalizePostalCode(body.postalCode);
    const serviceArea = await getServiceAreaPolicy();
    if (normalizedPostalCode && !isPostalCodeAllowed(normalizedPostalCode, serviceArea)) {
      return corsJson(
        {
          ok: false,
          error: await getOutOfAreaMessage("web")
        },
        requestOrigin,
        { status: 400 }
      );
    }

    const db = getDb();
    const bookingRules = await getBookingRulesPolicy(db);
    const windowDays =
      typeof bookingRules.bookingWindowDays === "number" && bookingRules.bookingWindowDays > 0
        ? Math.min(Math.floor(bookingRules.bookingWindowDays), 90)
        : WINDOW_DAYS;
    const [quote] = await db
      .select({ id: instantQuotes.id, aiResult: instantQuotes.aiResult, perceivedSize: instantQuotes.perceivedSize })
      .from(instantQuotes)
      .where(eq(instantQuotes.id, body.instantQuoteId))
      .limit(1);

    if (!quote) {
      return corsJson({ ok: false, error: "quote_not_found" }, requestOrigin, { status: 404 });
    }

    const durationInfo = deriveDurationMinutes(quote);
    const durationMinutes = durationInfo.durationMinutes;
    const travelBufferMinutes =
      typeof bookingRules.bufferMinutes === "number" && Number.isFinite(bookingRules.bufferMinutes)
        ? bookingRules.bufferMinutes
        : DEFAULT_TRAVEL_BUFFER_MIN;
    const capacity = DEFAULT_CAPACITY;

    let resolvedLat: number | null = typeof body.targetLat === "number" ? body.targetLat : null;
    let resolvedLng: number | null = typeof body.targetLng === "number" ? body.targetLng : null;

    if (resolvedLat === null && resolvedLng === null) {
      const geo = await forwardGeocode({
        addressLine1: body.addressLine1,
        city: body.city,
        state: body.state,
        postalCode: body.postalCode
      });
      if (geo) {
        resolvedLat = geo.lat;
        resolvedLng = geo.lng;
      }
    }

    const nowUtc = new Date();
    const lookbackStart = new Date(nowUtc.getTime() - 24 * 60 * 60 * 1000);
    const windowEnd = new Date(nowUtc.getTime() + windowDays * 24 * 60 * 60 * 1000);

    const existing = await db
      .select({
        id: appointments.id,
        startAt: appointments.startAt,
        durationMinutes: appointments.durationMinutes,
        travelBufferMinutes: appointments.travelBufferMinutes,
        status: appointments.status,
        city: properties.city,
        state: properties.state,
        lat: properties.lat,
        lng: properties.lng
      })
      .from(appointments)
      .leftJoin(properties, eq(appointments.propertyId, properties.id))
      .where(
        and(
          gte(appointments.startAt, lookbackStart),
          lte(appointments.startAt, windowEnd),
          ne(appointments.status, "canceled")
        )
      );

    const blocks = existing
      .filter((row) => row.startAt)
      .map((row) => {
        const start = row.startAt as Date;
        const dur = (row.durationMinutes ?? durationMinutes) + (row.travelBufferMinutes ?? travelBufferMinutes);
        const city = typeof row.city === "string" ? row.city.toLowerCase().trim() : null;
        const state = typeof row.state === "string" ? row.state.toLowerCase().trim() : null;
        const lat = row.lat ? Number(row.lat) : null;
        const lng = row.lng ? Number(row.lng) : null;
        return { start, end: new Date(start.getTime() + dur * 60_000), city, state, lat, lng };
      });

    const dayTotals = new Map<string, number>();
    for (const block of blocks) {
      const dayKey = formatDayLocal(block.start);
      dayTotals.set(dayKey, (dayTotals.get(dayKey) ?? 0) + 1);
    }

    const dayCityCounts = new Map<string, Map<string, number>>();
    for (const b of blocks) {
      if (!b.city || !b.state) continue;
      const dayKey = formatDayLocal(b.start);
      const locKey = `${b.city}:${b.state}`;
      const dayCounts = dayCityCounts.get(dayKey) ?? new Map<string, number>();
      dayCounts.set(locKey, (dayCounts.get(locKey) ?? 0) + 1);
      dayCityCounts.set(dayKey, dayCounts);
    }

    const suggestions: Suggestion[] = [];
    const days: Array<{ date: string; slots: Suggestion[] }> = [];
    const nowLocal = DateTime.now().setZone(APPOINTMENT_TIME_ZONE);

    for (let day = 0; day < windowDays; day++) {
      const baseDay = nowLocal.plus({ days: day }).startOf("day");
      if (baseDay.weekday === 7) continue;

      const dayKey = baseDay.toISODate();
      if (!dayKey) continue;
      const daySlots: Suggestion[] = [];
      if (bookingRules.maxJobsPerDay > 0 && (dayTotals.get(dayKey) ?? 0) >= bookingRules.maxJobsPerDay) {
        days.push({ date: dayKey, slots: daySlots });
        continue;
      }
      const dayBlocks = blocks.filter((b) => formatDayLocal(b.start) === dayKey);
      const dayCounts = dayCityCounts.get(dayKey);
      const topCount =
        dayCounts && dayCounts.size > 0
          ? [...dayCounts.values()].reduce((max, val) => (val > max ? val : max), 0)
          : 0;
      const nearest =
        resolvedLat !== null && resolvedLng !== null
          ? nearestDistanceKm(dayBlocks, resolvedLat, resolvedLng)
          : null;
      const withinRadius =
        resolvedLat !== null && resolvedLng !== null
          ? dayBlocks.filter((b) => distanceKm(b, resolvedLat!, resolvedLng!) <= DEFAULT_RADIUS_KM).length
          : null;

      for (
        let minutes = START_HOUR * 60;
        minutes + durationMinutes <= END_HOUR * 60;
        minutes += SLOT_INTERVAL_MIN
      ) {
        const slotStartLocal = baseDay.plus({ minutes });
        if (slotStartLocal < nowLocal) continue;

        const slotEndLocal = slotStartLocal.plus({ minutes: durationMinutes });
        const slotStart = slotStartLocal.toUTC().toJSDate();
        const slotEnd = slotEndLocal.toUTC().toJSDate();

        if (overlapsCount(blocks, slotStart, slotEnd) >= capacity) continue;

        const slot: Suggestion = {
          startAt: slotStart.toISOString(),
          endAt: slotEnd.toISOString(),
          reason:
            resolvedLat !== null && resolvedLng !== null && nearest !== null
              ? `Nearest scheduled job ~${nearest.toFixed(1)} km; ${withinRadius ?? 0} within ${DEFAULT_RADIUS_KM} km`
              : topCount && topCount > 0
                ? `Aligned with ${topCount} nearby job(s) on this day`
                : `No conflicts; ${durationMinutes} min slot`
        };
        suggestions.push(slot);
        daySlots.push(slot);
      }

      daySlots.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
      days.push({ date: dayKey, slots: daySlots });
    }

    const clusterPicks = sortSuggestions(suggestions).slice(0, 3);
    const soonestPicks = [...suggestions]
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
      .slice(0, 8);
    const merged = uniqByStart([...clusterPicks, ...soonestPicks], 8);

    return corsJson(
      {
        ok: true,
        timezone: APPOINTMENT_TIME_ZONE,
        durationMinutes,
        travelBufferMinutes,
        capacity,
        slotIntervalMinutes: SLOT_INTERVAL_MIN,
        suggestions: merged,
        days
      },
      requestOrigin
    );
  } catch (error) {
    console.error("[junk-quote-availability] server_error", error);
    return corsJson({ ok: false, error: "server_error" }, requestOrigin, { status: 500 });
  }
}

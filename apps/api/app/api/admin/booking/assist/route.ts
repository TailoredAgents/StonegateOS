import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, gte, lte, eq } from "drizzle-orm";
import { getDb, appointments, properties } from "@/db";
import { isAdminRequest } from "../../../web/admin";

type SuggestRequest = {
  durationMinutes?: number;
  windowDays?: number;
  startHour?: number;
  endHour?: number;
  targetLat?: number;
  targetLng?: number;
  radiusKm?: number;
};

type Suggestion = {
  startAt: string;
  endAt: string;
  reason: string;
};

type SuggestResponse = {
  ok: boolean;
  suggestions: Suggestion[];
};

const DEFAULT_DURATION_MIN = 60;
const DEFAULT_WINDOW_DAYS = 5;
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 18;

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, suggestions: [], error: "unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => ({}))) as SuggestRequest;
  const durationMinutes =
    typeof payload.durationMinutes === "number" && payload.durationMinutes > 0
      ? payload.durationMinutes
      : DEFAULT_DURATION_MIN;
  const windowDays =
    typeof payload.windowDays === "number" && payload.windowDays > 0 && payload.windowDays <= 30
      ? payload.windowDays
      : DEFAULT_WINDOW_DAYS;
  const startHour =
    typeof payload.startHour === "number" && payload.startHour >= 0 && payload.startHour < 24
      ? payload.startHour
      : DEFAULT_START_HOUR;
  const endHour =
    typeof payload.endHour === "number" && payload.endHour > startHour && payload.endHour <= 24
      ? payload.endHour
      : DEFAULT_END_HOUR;
  const targetLat = typeof payload.targetLat === "number" ? payload.targetLat : null;
  const targetLng = typeof payload.targetLng === "number" ? payload.targetLng : null;
  const radiusKm =
    typeof payload.radiusKm === "number" && payload.radiusKm > 0 ? payload.radiusKm : 30;

  const now = new Date();
  const windowStart = new Date(now);
  const windowEnd = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

  const db = getDb();
  const existing = await db
    .select({
      id: appointments.id,
      startAt: appointments.startAt,
      durationMinutes: appointments.durationMinutes,
      travelBufferMinutes: appointments.travelBufferMinutes,
      city: properties.city,
      state: properties.state,
      lat: properties.lat,
      lng: properties.lng
    })
    .from(appointments)
    .leftJoin(properties, eq(appointments.propertyId, properties.id))
    .where(and(gte(appointments.startAt, windowStart), lte(appointments.startAt, windowEnd)));

  const blocks = existing
    .filter((row) => row.startAt)
    .map((row) => {
      const start = row.startAt as Date;
      const dur = (row.durationMinutes ?? durationMinutes) + (row.travelBufferMinutes ?? 0);
      const city = typeof row.city === "string" ? row.city.toLowerCase().trim() : null;
      const state = typeof row.state === "string" ? row.state.toLowerCase().trim() : null;
      const lat = row.lat ? Number(row.lat) : null;
      const lng = row.lng ? Number(row.lng) : null;
      return { start, end: new Date(start.getTime() + dur * 60_000), city, state, lat, lng };
    });

  // Count how many appointments per day share the same city/state to favor clustering
  const dayCityCounts = new Map<string, Map<string, number>>();
  for (const block of blocks) {
    const dayKey = formatDay(block.start);
    if (!dayCityCounts.has(dayKey)) dayCityCounts.set(dayKey, new Map());
    const cityKey = block.city ?? "unknown";
    const current = dayCityCounts.get(dayKey)!.get(cityKey) ?? 0;
    dayCityCounts.get(dayKey)!.set(cityKey, current + 1);
  }

  const suggestions: Suggestion[] = [];
  for (let day = 0; day <= windowDays; day++) {
    const base = new Date(now.getTime() + day * 24 * 60 * 60 * 1000);
    const dayKey = formatDay(base);
    const dayCounts = dayCityCounts.get(dayKey);
    const topCount =
      dayCounts && [...dayCounts.values()].reduce((max, val) => (val > max ? val : max), 0);
    const dayBlocks = blocks.filter((b) => formatDay(b.start) === dayKey);
    const nearest = targetLat !== null && targetLng !== null ? nearestDistanceKm(dayBlocks, targetLat, targetLng) : null;
    const withinRadius =
      targetLat !== null && targetLng !== null
        ? dayBlocks.filter((b) => distanceKm(b, targetLat, targetLng) <= radiusKm).length
        : null;
    for (let hour = startHour; hour + durationMinutes / 60 <= endHour; hour += 2) {
      const slotStart = new Date(base);
      slotStart.setHours(hour, 0, 0, 0);
      if (slotStart < now) continue;
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000);
      if (conflictsWith(blocks, slotStart, slotEnd)) continue;
      suggestions.push({
        startAt: slotStart.toISOString(),
        endAt: slotEnd.toISOString(),
        reason:
          targetLat !== null && targetLng !== null && nearest !== null
            ? `Nearest existing appt ~${nearest.toFixed(1)} km; ${withinRadius ?? 0} within ${radiusKm} km`
            : topCount && topCount > 0
              ? `Aligned with ${topCount} nearby appointment(s) on this day`
              : `No conflicts; ${durationMinutes} min slot`
      });
      if (suggestions.length >= 5) {
        return NextResponse.json({ ok: true, suggestions: sortSuggestions(suggestions) } satisfies SuggestResponse);
      }
    }
  }

  return NextResponse.json({ ok: true, suggestions: sortSuggestions(suggestions) } satisfies SuggestResponse);
}

function conflictsWith(
  blocks: Array<{ start: Date; end: Date }>,
  start: Date,
  end: Date
): boolean {
  return blocks.some((block) => overlaps(start, end, block.start, block.end));
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sortSuggestions(list: Suggestion[]): Suggestion[] {
  return [...list].sort((a, b) => {
    // Extract counts/distances from reason if present
    const extractCount = (reason: string): number => {
      const match = reason.match(/Aligned with (\d+)/i);
      return match ? Number(match[1]) : 0;
    };
    const extractNearest = (reason: string): number => {
      const match = reason.match(/Nearest existing appt ~([\d.]+)/i);
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

function nearestDistanceKm(
  blocks: Array<{ lat: number | null; lng: number | null }>,
  targetLat: number,
  targetLng: number
): number | null {
  let best: number | null = null;
  for (const b of blocks) {
    const d = distanceKm(b, targetLat, targetLng);
    if (Number.isFinite(d)) {
      if (best === null || d < best) {
        best = d;
      }
    }
  }
  return best;
}

function distanceKm(
  block: { lat: number | null; lng: number | null },
  targetLat: number,
  targetLng: number
): number {
  if (block.lat === null || block.lng === null) return Infinity;
  const R = 6371; // km
  const dLat = deg2rad(targetLat - block.lat);
  const dLon = deg2rad(targetLng - block.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(block.lat)) * Math.cos(deg2rad(targetLat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function deg2rad(deg: number): number {
  return deg * (Math.PI / 180);
}

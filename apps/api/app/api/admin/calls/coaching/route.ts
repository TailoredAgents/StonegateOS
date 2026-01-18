import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { callCoaching, callRecords, contacts, getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

function clampInt(value: string | null, fallback: number, { min, max }: { min: number; max: number }): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  return Math.min(max, Math.max(min, rounded));
}

function buildContactName(first: string | null, last: string | null): string {
  const parts = [first ?? "", last ?? ""].map((v) => v.trim()).filter(Boolean);
  return parts.length ? parts.join(" ") : "Unknown contact";
}

type CoachingRow = {
  rubric: "inbound" | "outbound";
  scoreOverall: number;
  wins: string[];
  improvements: string[];
};

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const url = new URL(request.url);
  const memberId = url.searchParams.get("memberId")?.trim() ?? "";
  const rangeDays = clampInt(url.searchParams.get("rangeDays"), 7, { min: 1, max: 60 });

  if (!memberId) {
    return NextResponse.json({ error: "member_id_required" }, { status: 400 });
  }

  const now = new Date();
  const since = new Date(now.getTime() - rangeDays * 24 * 60_000 * 60);

  let recentCoaching:
    | Array<{
        callRecordId: string;
        rubric: "inbound" | "outbound";
        scoreOverall: number;
        wins: string[] | null;
        improvements: string[] | null;
        createdAt: Date;
      }>
    | null = null;

  try {
    recentCoaching = await db
      .select({
        callRecordId: callCoaching.callRecordId,
        rubric: callCoaching.rubric,
        scoreOverall: callCoaching.scoreOverall,
        wins: callCoaching.wins,
        improvements: callCoaching.improvements,
        createdAt: callCoaching.createdAt
      })
      .from(callCoaching)
      .where(and(eq(callCoaching.memberId, memberId), eq(callCoaching.version, 1), gte(callCoaching.createdAt, since)))
      .orderBy(desc(callCoaching.createdAt))
      .limit(200);
  } catch (error) {
    const dbError = error as { code?: string } | null;
    if (dbError?.code === "42P01") {
      return NextResponse.json({
        ok: true,
        schemaReady: false,
        memberId,
        rangeDays,
        since: since.toISOString(),
        summary: {
          inbound: { avgScore: null, count: 0 },
          outbound: { avgScore: null, count: 0 }
        },
        items: []
      });
    }
    throw error;
  }

  const uniqueCallIds: string[] = [];
  for (const row of recentCoaching ?? []) {
    const id = row.callRecordId;
    if (!id) continue;
    if (uniqueCallIds.includes(id)) continue;
    uniqueCallIds.push(id);
    if (uniqueCallIds.length >= 50) break;
  }

  const recentCalls =
    uniqueCallIds.length > 0
      ? await db
    .select({
      id: callRecords.id,
      createdAt: callRecords.createdAt,
      durationSec: callRecords.callDurationSec,
      contactId: callRecords.contactId,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactSource: contacts.source
    })
    .from(callRecords)
    .leftJoin(contacts, eq(callRecords.contactId, contacts.id))
    .where(and(gte(callRecords.createdAt, since), inArray(callRecords.id, uniqueCallIds)))
    .orderBy(desc(callRecords.createdAt))
    .limit(50)
      : [];

  const callIds = recentCalls.map((row) => row.id).filter((id) => typeof id === "string");
  const coachingRows = (recentCoaching ?? []).filter((row) => row.callRecordId && callIds.includes(row.callRecordId));

  const byCall = new Map<string, Partial<Record<"inbound" | "outbound", CoachingRow>>>();
  for (const row of coachingRows) {
    const callId = row.callRecordId;
    if (!callId) continue;
    const rubric = row.rubric === "outbound" ? "outbound" : "inbound";
    const existing = byCall.get(callId) ?? {};
    existing[rubric] = {
      rubric,
      scoreOverall: row.scoreOverall,
      wins: Array.isArray(row.wins) ? row.wins : [],
      improvements: Array.isArray(row.improvements) ? row.improvements : []
    };
    byCall.set(callId, existing);
  }

  const items = recentCalls
    .map((row) => {
      const contactId = row.contactId ?? null;
      const name = buildContactName(row.contactFirstName ?? null, row.contactLastName ?? null);
      const source = row.contactSource ?? null;
      const isOutbound = typeof source === "string" && source.toLowerCase().startsWith("outbound:");
      const primaryRubric: "inbound" | "outbound" = isOutbound ? "outbound" : "inbound";
      const coaching = byCall.get(row.id) ?? {};
      const inbound = coaching.inbound ?? null;
      const outbound = coaching.outbound ?? null;
      const primary = primaryRubric === "outbound" ? outbound : inbound;
      const secondary = primaryRubric === "outbound" ? inbound : outbound;
      return {
        callRecordId: row.id,
        createdAt: row.createdAt.toISOString(),
        durationSec: row.durationSec ?? null,
        contact: { id: contactId, name, source },
        primaryRubric,
        primary,
        secondary
      };
    })
    .filter((item) => item.primary !== null || item.secondary !== null)
    .slice(0, 10);

  const scoresInbound = coachingRows.filter((r) => r.rubric === "inbound").map((r) => r.scoreOverall);
  const scoresOutbound = coachingRows.filter((r) => r.rubric === "outbound").map((r) => r.scoreOverall);
  const avg = (values: number[]) =>
    values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;

  return NextResponse.json({
    ok: true,
    memberId,
    rangeDays,
    since: since.toISOString(),
    summary: {
      inbound: { avgScore: avg(scoresInbound), count: scoresInbound.length },
      outbound: { avgScore: avg(scoresOutbound), count: scoresOutbound.length }
    },
    items
  });
}

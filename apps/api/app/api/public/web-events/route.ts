import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { LRUCache } from "lru-cache";
import { z } from "zod";
import { lt, sql } from "drizzle-orm";
import { getDb, webEventCountsDaily, webEvents, webVitals } from "@/db";
import { getServiceAreaPolicy, isGeorgiaPostalCode, isPostalCodeAllowed, normalizePostalCode } from "@/lib/policy";

const RAW_ALLOWED_ORIGINS =
  process.env["CORS_ALLOW_ORIGINS"] ?? process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "*";

const MAX_EVENTS_PER_REQUEST = 50;
const MAX_META_KEYS = 24;
const RETAIN_DAYS = 30;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const rateLimiter = new LRUCache<string, { count: number }>({
  max: 2000,
  ttl: 60_000
});

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
  response.headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
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

function checkRateLimit(key: string): boolean {
  if (process.env["NODE_ENV"] === "test" || process.env["E2E_RUN_ID"]) {
    return false;
  }

  if (key === "unknown") {
    return false;
  }

  const existing = rateLimiter.get(key);
  if (existing && existing.count >= 120) {
    return true;
  }

  if (existing) {
    existing.count += 1;
    rateLimiter.set(key, existing, { ttl: 60_000 });
  } else {
    rateLimiter.set(key, { count: 1 });
  }

  return false;
}

function resolveClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const ip = forwardedFor.split(",")[0]?.trim();
    if (ip) return ip;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp && realIp.trim()) return realIp.trim();
  return "unknown";
}

function normalizePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  if (trimmed.startsWith("/")) return trimmed.split("?")[0] ?? "/";
  try {
    const url = new URL(trimmed);
    return url.pathname || "/";
  } catch {
    return "/";
  }
}

function normalizeReferrerDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.hostname || null;
  } catch {
    return null;
  }
}

function normalizeUtmField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 120);
}

function normalizeMeta(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const result: Record<string, unknown> = {};
  for (const [key, raw] of entries.slice(0, MAX_META_KEYS)) {
    const k = key.trim().slice(0, 64);
    if (!k) continue;
    if (typeof raw === "string") {
      result[k] = raw.slice(0, 220);
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      result[k] = raw;
    } else if (typeof raw === "boolean") {
      result[k] = raw;
    } else if (raw === null) {
      result[k] = null;
    }
  }
  return result;
}

async function resolveAreaBucket(zip: string | null): Promise<string | null> {
  if (!zip) return null;
  const normalized = normalizePostalCode(zip);
  if (!normalized) return null;
  if (!isGeorgiaPostalCode(normalized)) return "out_of_area";
  const policy = await getServiceAreaPolicy();
  return isPostalCodeAllowed(normalized, policy) ? "in_area" : "borderline";
}

let lastPruneAtMs = 0;
async function maybePruneOldRows(db = getDb()): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAtMs < PRUNE_INTERVAL_MS) return;
  lastPruneAtMs = now;
  try {
    const cutoff = sql`now() - interval '${RETAIN_DAYS} days'`;
    await db.delete(webEvents).where(lt(webEvents.createdAt, cutoff));
    await db.delete(webVitals).where(lt(webVitals.createdAt, cutoff));
  } catch (error) {
    console.warn("[web.analytics] prune_failed", { error: String(error) });
  }
}

const EventSchema = z.object({
  sessionId: z.string().min(8).max(80),
  visitId: z.string().min(8).max(80),
  event: z.string().min(2).max(40),
  path: z.string().min(1).max(500),
  key: z.string().max(120).optional(),
  referrer: z.string().max(800).optional(),
  utm: z
    .object({
      source: z.string().max(120).optional(),
      medium: z.string().max(120).optional(),
      campaign: z.string().max(120).optional(),
      term: z.string().max(120).optional(),
      content: z.string().max(120).optional()
    })
    .optional(),
  device: z.enum(["mobile", "desktop", "tablet", "unknown"]).optional(),
  zip: z.string().max(32).optional(),
  meta: z.record(z.unknown()).optional(),
  value: z.number().finite().optional()
});

const PayloadSchema = z.union([
  z.object({ events: z.array(EventSchema).min(1).max(MAX_EVENTS_PER_REQUEST) }),
  EventSchema
]);

export async function POST(request: NextRequest): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  if (RAW_ALLOWED_ORIGINS !== "*" && resolveOrigin(requestOrigin) !== (requestOrigin ?? "").replace(/\/+$/u, "")) {
    return corsJson({ ok: false, error: "forbidden_origin" }, requestOrigin, { status: 403 });
  }

  const ip = resolveClientIp(request);
  if (checkRateLimit(ip)) {
    return corsJson({ ok: false, error: "rate_limited" }, requestOrigin, { status: 429 });
  }

  const parsed = PayloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return corsJson({ ok: false, error: "invalid_payload" }, requestOrigin, { status: 400 });
  }

  const events = "events" in parsed.data ? parsed.data.events : [parsed.data];
  const tz = process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";
  const dateStart = DateTime.now().setZone(tz).toISODate();
  if (!dateStart) {
    return corsJson({ ok: false, error: "invalid_time" }, requestOrigin, { status: 500 });
  }

  const db = getDb();
  await maybePruneOldRows(db);

  const serviceAreaPolicyPromise = getServiceAreaPolicy();

  const inserts: Array<typeof webEvents.$inferInsert> = [];
  const vitalsInserts: Array<typeof webVitals.$inferInsert> = [];
  const countUpserts: Array<typeof webEventCountsDaily.$inferInsert> = [];

  for (const evt of events) {
    const path = normalizePath(evt.path);
    const referrerDomain = normalizeReferrerDomain(evt.referrer) ?? null;
    const meta = normalizeMeta(evt.meta);
    const utm = evt.utm ?? {};

    const normalizedZip = evt.zip ? normalizePostalCode(evt.zip) : null;
    const policy = await serviceAreaPolicyPromise;
    const inAreaBucket =
      normalizedZip && isGeorgiaPostalCode(normalizedZip)
        ? isPostalCodeAllowed(normalizedZip, policy)
          ? "in_area"
          : "borderline"
        : normalizedZip
          ? "out_of_area"
          : null;

    const device = evt.device ?? null;
    const key = evt.key?.trim() ? evt.key.trim().slice(0, 120) : null;

    inserts.push({
      sessionId: evt.sessionId,
      visitId: evt.visitId,
      event: evt.event,
      path,
      key,
      referrerDomain,
      utmSource: normalizeUtmField(utm.source),
      utmMedium: normalizeUtmField(utm.medium),
      utmCampaign: normalizeUtmField(utm.campaign),
      utmTerm: normalizeUtmField(utm.term),
      utmContent: normalizeUtmField(utm.content),
      device,
      inAreaBucket,
      meta
    });

    if (evt.event === "web_vital" && typeof evt.value === "number" && Number.isFinite(evt.value)) {
      vitalsInserts.push({
        sessionId: evt.sessionId,
        visitId: evt.visitId,
        path,
        metric: key ?? "unknown",
        value: evt.value,
        rating: typeof meta["rating"] === "string" ? String(meta["rating"]).slice(0, 20) : null,
        device
      });
    }

    countUpserts.push({
      dateStart,
      event: evt.event,
      path,
      key: key ?? "",
      device: device ?? "",
      inAreaBucket: inAreaBucket ?? "",
      utmSource: normalizeUtmField(utm.source) ?? "",
      utmMedium: normalizeUtmField(utm.medium) ?? "",
      utmCampaign: normalizeUtmField(utm.campaign) ?? "",
      utmTerm: normalizeUtmField(utm.term) ?? "",
      utmContent: normalizeUtmField(utm.content) ?? ""
    });
  }

  try {
    if (inserts.length) {
      await db.insert(webEvents).values(inserts);
    }
    if (vitalsInserts.length) {
      await db.insert(webVitals).values(vitalsInserts);
    }
    for (const row of countUpserts) {
      await db
        .insert(webEventCountsDaily)
        .values({ ...row, count: 1 })
        .onConflictDoUpdate({
          target: [
            webEventCountsDaily.dateStart,
            webEventCountsDaily.event,
            webEventCountsDaily.path,
            webEventCountsDaily.key,
            webEventCountsDaily.device,
            webEventCountsDaily.inAreaBucket,
            webEventCountsDaily.utmSource,
            webEventCountsDaily.utmMedium,
            webEventCountsDaily.utmCampaign,
            webEventCountsDaily.utmTerm,
            webEventCountsDaily.utmContent
          ],
          set: {
            count: sql`${webEventCountsDaily.count} + 1`,
            updatedAt: new Date()
          }
        });
    }
  } catch (error) {
    console.warn("[web.analytics] ingest_failed", { error: String(error) });
    return corsJson({ ok: false, error: "server_error" }, requestOrigin, { status: 500 });
  }

  return corsJson({ ok: true }, requestOrigin);
}

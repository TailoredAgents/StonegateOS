import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { LRUCache } from "lru-cache";
import { z } from "zod";
import { lt, sql } from "drizzle-orm";
import { getDb, webEventCountsDaily, webEvents, webVitals } from "@/db";
import { sanitizeFirstPartyAnalyticsMeta } from "@/lib/analytics-privacy";
import {
  isPartnerAnalyticsSurface,
  normalizePartnerProductEvent,
  sanitizePartnerAnalyticsPath,
} from "@/lib/partner-product-analytics";
import {
  getServiceAreaPolicy,
  isGeorgiaPostalCode,
  isPostalCodeAllowed,
  normalizePostalCode,
} from "@/lib/policy";

const RAW_ALLOWED_ORIGINS =
  process.env["CORS_ALLOW_ORIGINS"] ??
  process.env["NEXT_PUBLIC_SITE_URL"] ??
  process.env["SITE_URL"] ??
  "*";

const MAX_EVENTS_PER_REQUEST = 50;
const MAX_META_KEYS = 24;
const RETAIN_DAYS = 30;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEVELOPMENT_ANALYTICS_ID_SECRET =
  "stonegate-development-partner-analytics-id-secret-v1";

const rateLimiter = new LRUCache<string, { count: number }>({
  max: 2000,
  ttl: 60_000,
});

function resolveOrigin(requestOrigin: string | null): string {
  if (RAW_ALLOWED_ORIGINS === "*") return "*";
  const allowed = RAW_ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim().replace(/\/+$/u, ""))
    .filter(Boolean);
  if (!allowed.length) return "*";
  const origin = requestOrigin?.trim().replace(/\/+$/u, "") ?? null;
  if (origin && allowed.includes(origin)) return origin;
  return allowed[0] ?? "*";
}

function applyCors(
  response: NextResponse,
  requestOrigin: string | null,
): NextResponse {
  const origin = resolveOrigin(requestOrigin);
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  // Avoid wildcard headers; some browsers won't proceed with the actual request.
  response.headers.set("Access-Control-Allow-Headers", "content-type");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

function corsJson(
  body: unknown,
  requestOrigin: string | null,
  init?: ResponseInit,
): NextResponse {
  return applyCors(NextResponse.json(body, init), requestOrigin);
}

export function OPTIONS(request: NextRequest): NextResponse {
  return applyCors(
    new NextResponse(null, { status: 204 }),
    request.headers.get("origin"),
  );
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

function normalizeReferrerDomain(
  raw: string | null | undefined,
): string | null {
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

function pseudonymizePartnerAnalyticsId(value: string): string | null {
  const configuredSecret =
    process.env["WEB_ANALYTICS_ID_HMAC_SECRET"]?.trim() ??
    process.env["QUOTE_RATE_LIMIT_HMAC_SECRET"]?.trim();
  const secret =
    configuredSecret && configuredSecret.length >= 32
      ? configuredSecret
      : process.env["NODE_ENV"] === "production"
        ? null
        : DEVELOPMENT_ANALYTICS_ID_SECRET;
  if (!secret) return null;

  return `pa_${createHmac("sha256", secret)
    .update("partner-analytics-id-v1\0", "utf8")
    .update(value, "utf8")
    .digest("base64url")}`;
}

let lastPruneAtMs = 0;
async function maybePruneOldRows(db = getDb()): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAtMs < PRUNE_INTERVAL_MS) return;
  lastPruneAtMs = now;
  try {
    const cutoff = sql`now() - (${RETAIN_DAYS} * interval '1 day')`;
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
      content: z.string().max(120).optional(),
    })
    .optional(),
  device: z.enum(["mobile", "desktop", "tablet", "unknown"]).optional(),
  zip: z.string().max(32).optional(),
  meta: z.record(z.unknown()).optional(),
  value: z.number().finite().optional(),
});

const PayloadSchema = z.union([
  z.object({ events: z.array(EventSchema).min(1).max(MAX_EVENTS_PER_REQUEST) }),
  EventSchema,
]);

export async function POST(request: NextRequest): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  // Some clients may omit Origin; accept and rely on rate-limits + payload limits.
  if (
    requestOrigin &&
    RAW_ALLOWED_ORIGINS !== "*" &&
    resolveOrigin(requestOrigin) !== (requestOrigin ?? "").replace(/\/+$/u, "")
  ) {
    return corsJson({ ok: false, error: "forbidden_origin" }, requestOrigin, {
      status: 403,
    });
  }

  const ip = resolveClientIp(request);
  if (checkRateLimit(ip)) {
    return corsJson({ ok: false, error: "rate_limited" }, requestOrigin, {
      status: 429,
    });
  }

  const contentType = request.headers.get("content-type") ?? "";
  let body: unknown = null;
  if (/application\/json/i.test(contentType) || /\+json/i.test(contentType)) {
    try {
      body = (await request.json()) as unknown;
    } catch {
      body = null;
    }
  } else {
    const raw = await request.text().catch(() => "");
    if (raw) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = null;
      }
    }
  }

  const parsed = PayloadSchema.safeParse(body);
  if (!parsed.success) {
    return corsJson({ ok: false, error: "invalid_payload" }, requestOrigin, {
      status: 400,
    });
  }

  const events = "events" in parsed.data ? parsed.data.events : [parsed.data];
  const tz = process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";
  const dateStart = DateTime.now().setZone(tz).toISODate();
  if (!dateStart) {
    return corsJson({ ok: false, error: "invalid_time" }, requestOrigin, {
      status: 500,
    });
  }

  const db = getDb();
  await maybePruneOldRows(db);

  let serviceAreaPolicyPromise: ReturnType<typeof getServiceAreaPolicy> | null =
    null;

  const inserts: Array<typeof webEvents.$inferInsert> = [];
  const vitalsInserts: Array<typeof webVitals.$inferInsert> = [];
  const countUpserts: Array<typeof webEventCountsDaily.$inferInsert> = [];

  for (const evt of events) {
    const rawPath = normalizePath(evt.path);
    const protectsPartnerData = isPartnerAnalyticsSurface(evt.event, rawPath);
    const partnerProductEvent = protectsPartnerData
      ? normalizePartnerProductEvent({
          event: evt.event,
          path: rawPath,
          key: evt.key,
          meta: evt.meta,
          value: evt.value,
        })
      : null;
    // Unknown or malformed Partner events are ignored instead of allowing a
    // stale or hostile client to expand the product telemetry schema.
    if (protectsPartnerData && !partnerProductEvent) continue;

    const sessionId = protectsPartnerData
      ? pseudonymizePartnerAnalyticsId(evt.sessionId)
      : evt.sessionId;
    const visitId = protectsPartnerData
      ? pseudonymizePartnerAnalyticsId(evt.visitId)
      : evt.visitId;
    // Partner telemetry fails closed when its server-side pseudonymization
    // key is unavailable. Raw client identifiers must never reach storage.
    if (!sessionId || !visitId) continue;

    const event = partnerProductEvent?.event ?? evt.event;
    const path = partnerProductEvent
      ? partnerProductEvent.path
      : protectsPartnerData
        ? sanitizePartnerAnalyticsPath(rawPath)
        : rawPath;
    const referrerDomain = protectsPartnerData
      ? null
      : (normalizeReferrerDomain(evt.referrer) ?? null);
    const meta = partnerProductEvent
      ? partnerProductEvent.meta
      : sanitizeFirstPartyAnalyticsMeta(evt.meta, MAX_META_KEYS);
    const utm: NonNullable<typeof evt.utm> = protectsPartnerData
      ? {}
      : (evt.utm ?? {});

    const normalizedZip =
      !protectsPartnerData && evt.zip ? normalizePostalCode(evt.zip) : null;
    let inAreaBucket: "in_area" | "borderline" | "out_of_area" | null = null;
    if (normalizedZip) {
      const policy = await (serviceAreaPolicyPromise ??=
        getServiceAreaPolicy());
      inAreaBucket = isGeorgiaPostalCode(normalizedZip)
        ? isPostalCodeAllowed(normalizedZip, policy)
          ? "in_area"
          : "borderline"
        : "out_of_area";
    }

    const device = evt.device ?? null;
    const key = partnerProductEvent
      ? partnerProductEvent.key
      : evt.key?.trim()
        ? evt.key.trim().slice(0, 120)
        : null;
    const value =
      partnerProductEvent?.event === "web_vital"
        ? partnerProductEvent.value
        : evt.value;

    inserts.push({
      sessionId,
      visitId,
      event,
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
      meta,
    });

    if (
      event === "web_vital" &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      vitalsInserts.push({
        sessionId,
        visitId,
        path,
        metric: key ?? "unknown",
        value,
        rating:
          typeof meta["rating"] === "string"
            ? String(meta["rating"]).slice(0, 20)
            : null,
        device,
      });
    }

    countUpserts.push({
      dateStart,
      event,
      path,
      key: key ?? "",
      device: device ?? "",
      inAreaBucket: inAreaBucket ?? "",
      utmSource: normalizeUtmField(utm.source) ?? "",
      utmMedium: normalizeUtmField(utm.medium) ?? "",
      utmCampaign: normalizeUtmField(utm.campaign) ?? "",
      utmTerm: normalizeUtmField(utm.term) ?? "",
      utmContent: normalizeUtmField(utm.content) ?? "",
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
            webEventCountsDaily.utmContent,
          ],
          set: {
            count: sql`${webEventCountsDaily.count} + 1`,
            updatedAt: new Date(),
          },
        });
    }
  } catch (error) {
    console.warn("[web.analytics] ingest_failed", { error: String(error) });
    return corsJson({ ok: false, error: "server_error" }, requestOrigin, {
      status: 500,
    });
  }

  return corsJson({ ok: true }, requestOrigin);
}

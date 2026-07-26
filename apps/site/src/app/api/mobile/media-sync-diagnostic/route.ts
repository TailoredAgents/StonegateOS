import { NextResponse } from "next/server";
import {
  hasMobilePermission,
  resolveMobileSessionFromCookies,
} from "@/app/mobile/lib/session";

const MAX_BODY_LENGTH = 4_096;
const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const allowed = {
  source: new Set(["window", "service_worker"]),
  phase: new Set([
    "preflight",
    "session",
    "lease_acquire",
    "lease_acquired",
    "reclaim",
    "queue_scan",
    "lease_renew",
    "row_prepare",
    "intent",
    "release",
  ]),
  outcome: new Set(["started", "ok", "busy", "retry", "error"]),
  errorCode: new Set([
    "none",
    "indexeddb",
    "lease_busy",
    "lease_lost",
    "network",
    "timeout",
    "session",
    "permission",
    "server",
    "unknown",
  ]),
};

type DiagnosticInput = {
  schemaVersion?: unknown;
  runId?: unknown;
  source?: unknown;
  phase?: unknown;
  outcome?: unknown;
  errorCode?: unknown;
  queueTotal?: unknown;
  queuedCount?: unknown;
  uploadingCount?: unknown;
  finalizingCount?: unknown;
  failedCount?: unknown;
  leaseVersion?: unknown;
  eventAt?: unknown;
};

function allowedString(value: unknown, values: Set<string>): string | null {
  return typeof value === "string" && values.has(value) ? value : null;
}

function queueCount(value: unknown): number | null {
  return Number.isInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= 10_000
    ? Number(value)
    : null;
}

export async function POST(request: Request): Promise<Response> {
  const session = await resolveMobileSessionFromCookies();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  if (
    !hasMobilePermission(session.teamMember.permissions, "appointments.read")
  ) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_LENGTH) {
    return NextResponse.json(
      { ok: false, error: "payload_too_large" },
      { status: 413 },
    );
  }
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_LENGTH) {
    return NextResponse.json(
      { ok: false, error: "payload_too_large" },
      { status: 413 },
    );
  }

  let input: DiagnosticInput;
  try {
    input = JSON.parse(rawBody) as DiagnosticInput;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }

  const event = {
    schemaVersion: input.schemaVersion,
    runId:
      typeof input.runId === "string" && RUN_ID_PATTERN.test(input.runId)
        ? input.runId
        : null,
    source: allowedString(input.source, allowed.source),
    phase: allowedString(input.phase, allowed.phase),
    outcome: allowedString(input.outcome, allowed.outcome),
    errorCode: allowedString(input.errorCode, allowed.errorCode),
    queueTotal: queueCount(input.queueTotal),
    queuedCount: queueCount(input.queuedCount),
    uploadingCount: queueCount(input.uploadingCount),
    finalizingCount: queueCount(input.finalizingCount),
    failedCount: queueCount(input.failedCount),
    leaseVersion:
      Number.isInteger(input.leaseVersion) &&
      Number(input.leaseVersion) >= 1 &&
      Number(input.leaseVersion) <= 100
        ? Number(input.leaseVersion)
        : null,
    eventAt:
      typeof input.eventAt === "string" &&
      Number.isFinite(Date.parse(input.eventAt))
        ? input.eventAt
        : null,
  };
  if (
    event.schemaVersion !== 1 ||
    !event.runId ||
    !event.source ||
    !event.phase ||
    !event.outcome ||
    !event.errorCode ||
    event.leaseVersion === null ||
    !event.eventAt
  ) {
    return NextResponse.json(
      { ok: false, error: "invalid_diagnostic" },
      { status: 400 },
    );
  }

  console.info("[mobile-media-sync]", JSON.stringify(event));
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
}

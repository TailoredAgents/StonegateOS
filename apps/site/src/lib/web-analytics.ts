type WebDevice = "mobile" | "desktop" | "tablet" | "unknown";

export type WebEventName =
  | "visit_start"
  | "page_view"
  | "cta_click"
  | "lead_form_step_view"
  | "lead_form_step1_submit"
  | "lead_form_photo_upload_start"
  | "lead_form_photo_upload_success"
  | "lead_form_photo_upload_fail"
  | "lead_form_quote_start"
  | "lead_form_quote_success"
  | "lead_form_quote_fail"
  | "lead_form_booking_attempt"
  | "lead_form_booking_success"
  | "lead_form_booking_fail"
  | "book_step_view"
  | "book_step1_submit"
  | "book_photo_upload_start"
  | "book_photo_upload_success"
  | "book_photo_upload_fail"
  | "book_quote_start"
  | "book_quote_success"
  | "book_quote_fail"
  | "book_booking_attempt"
  | "book_booking_success"
  | "book_booking_fail"
  | "web_vital";

export type WebAnalyticsEvent = {
  event: WebEventName;
  path: string;
  key?: string;
  zip?: string;
  meta?: Record<string, unknown>;
  value?: number;
  referrer?: string;
};

type UTM = {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
};

type PayloadEvent = {
  sessionId: string;
  visitId: string;
  event: string;
  path: string;
  key?: string;
  referrer?: string;
  utm?: UTM;
  device?: WebDevice;
  zip?: string;
  meta?: Record<string, unknown>;
  value?: number;
};

const SESSION_STORAGE_KEY = "sg:session";
const VISIT_STORAGE_KEY = "sg:visit";
const VISIT_LAST_KEY = "sg:visit_last";
const UTM_STORAGE_KEY = "sg:utm";
const VISIT_STARTED_KEY = "sg:visit_started";

const VISIT_IDLE_MS = 30 * 60 * 1000;
const SESSION_ROTATE_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_QUEUE = 50;
const FLUSH_BATCH = 20;
const FLUSH_DEBOUNCE_MS = 2_000;

let queue: PayloadEvent[] = [];
let flushInFlight = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function nowMs(): number {
  return Date.now();
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function randomId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    const hex = Array.from(buf)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `${prefix}_${hex}`;
  }
  return `${prefix}_${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
}

function resolveApiBase(): string | null {
  const base = (process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "").trim();
  if (!base) return null;
  return base.replace(/\/+$/u, "");
}

function resolveDevice(): WebDevice {
  if (typeof window === "undefined") return "unknown";
  const width = window.innerWidth;
  if (!Number.isFinite(width)) return "unknown";
  if (width <= 767) return "mobile";
  if (width <= 1024) return "tablet";
  return "desktop";
}

function normalizePath(raw: string): string {
  if (!raw) return "/";
  if (raw.startsWith("/")) return raw.split("?")[0] ?? "/";
  try {
    const url = new URL(raw);
    return url.pathname || "/";
  } catch {
    return "/";
  }
}

function readUtmFromLocation(): UTM | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const utm: UTM = {};
  const fields: Array<keyof UTM> = ["source", "medium", "campaign", "term", "content"];
  for (const field of fields) {
    const value = params.get(`utm_${field}`);
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    utm[field] = trimmed.slice(0, 120);
  }
  return Object.keys(utm).length ? utm : null;
}

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return randomId("sess");
  const stored = safeJsonParse<{ id: string; createdAt: number }>(localStorage.getItem(SESSION_STORAGE_KEY));
  const now = nowMs();
  if (stored?.id && typeof stored.createdAt === "number" && now - stored.createdAt < SESSION_ROTATE_MS) {
    return stored.id;
  }
  const next = { id: randomId("sess"), createdAt: now };
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next.id;
}

function getOrCreateVisitId(): string {
  if (typeof window === "undefined") return randomId("visit");
  const now = nowMs();
  const last = Number(sessionStorage.getItem(VISIT_LAST_KEY) ?? "0");
  const existing = sessionStorage.getItem(VISIT_STORAGE_KEY);
  if (existing && Number.isFinite(last) && now - last < VISIT_IDLE_MS) {
    return existing;
  }
  const next = randomId("visit");
  try {
    sessionStorage.setItem(VISIT_STORAGE_KEY, next);
    sessionStorage.setItem(VISIT_LAST_KEY, String(now));
  } catch {
    // ignore
  }
  return next;
}

function touchVisit(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(VISIT_LAST_KEY, String(nowMs()));
  } catch {
    // ignore
  }
}

function getOrCreateUtm(): UTM | undefined {
  if (typeof window === "undefined") return undefined;
  const current = readUtmFromLocation();
  if (current) {
    try {
      sessionStorage.setItem(UTM_STORAGE_KEY, JSON.stringify(current));
    } catch {
      // ignore
    }
    return current;
  }
  const stored = safeJsonParse<UTM>(sessionStorage.getItem(UTM_STORAGE_KEY));
  if (stored && Object.keys(stored).length) return stored;
  return undefined;
}

function enqueue(event: PayloadEvent): void {
  queue.push(event);
  if (queue.length > MAX_QUEUE) {
    queue = queue.slice(queue.length - MAX_QUEUE);
  }
}

function buildPayload(events: PayloadEvent[]): Blob | string {
  const json = JSON.stringify({ events });
  if (typeof Blob !== "undefined") {
    return new Blob([json], { type: "application/json" });
  }
  return json;
}

async function flushQueue(): Promise<void> {
  if (flushInFlight) return;
  if (queue.length === 0) return;
  const apiBase = resolveApiBase();
  if (!apiBase) return;

  flushInFlight = true;
  try {
    const events = queue.splice(0, FLUSH_BATCH);
    const payload = buildPayload(events);
    const url = `${apiBase}/api/public/web-events`;

    let ok = false;
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function" && payload instanceof Blob) {
      ok = navigator.sendBeacon(url, payload);
    }
    if (!ok && typeof fetch === "function") {
      await fetch(url, {
        method: "POST",
        headers: payload instanceof Blob ? undefined : { "Content-Type": "application/json" },
        body: payload instanceof Blob ? payload : (payload as string),
        keepalive: true
      }).catch(() => null);
    }
  } finally {
    flushInFlight = false;
    if (queue.length) {
      queueMicrotask(() => void flushQueue());
    }
  }
}

function scheduleFlush(): void {
  if (typeof window === "undefined") return;
  if (flushInFlight) return;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, FLUSH_DEBOUNCE_MS);
}

export function trackWebEvent(input: WebAnalyticsEvent): void {
  if (typeof window === "undefined") return;

  const sessionId = getOrCreateSessionId();
  const visitId = getOrCreateVisitId();
  const device = resolveDevice();
  touchVisit();

  const path = normalizePath(input.path);
  const event: PayloadEvent = {
    sessionId,
    visitId,
    event: input.event,
    path,
    key: input.key?.trim() ? input.key.trim().slice(0, 120) : undefined,
    referrer: input.referrer,
    utm: getOrCreateUtm(),
    device,
    zip: input.zip?.trim() ? input.zip.trim().slice(0, 32) : undefined,
    meta: input.meta,
    value: typeof input.value === "number" && Number.isFinite(input.value) ? input.value : undefined
  };

  enqueue(event);

  if (queue.length >= 10) {
    void flushQueue();
  } else {
    scheduleFlush();
  }
}

export function flushWebAnalytics(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  void flushQueue();
}

export function ensureVisitStarted(pathname: string): void {
  if (typeof window === "undefined") return;
  const visitId = getOrCreateVisitId();
  const startedFor = sessionStorage.getItem(VISIT_STARTED_KEY);
  if (startedFor === visitId) return;
  sessionStorage.setItem(VISIT_STARTED_KEY, visitId);
  trackWebEvent({ event: "visit_start", path: pathname, referrer: document.referrer });
}

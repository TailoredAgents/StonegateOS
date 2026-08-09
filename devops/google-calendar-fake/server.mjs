import { randomUUID } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";

const port = Number(process.env["PORT"] ?? 4012);
const host = process.env["HOST"] === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
const MAX_CAPTURED_REQUESTS = 100;
const MAX_PROVIDER_BODY_BYTES = 1024 * 1024;
const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_SCENARIO_DELAY_MS = 60_000;
const DEFAULT_TIMEOUT_DELAY_MS = 10_000;

const OPERATIONS = Object.freeze([
  "token",
  "create",
  "update",
  "delete",
  "get",
  "list",
  "watch",
]);
const SCENARIO_NAMES = new Set([
  "success",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "provider_error",
  "malformed_json",
  "empty_success",
  "timeout",
]);
const DEFAULT_SCENARIO = Object.freeze({
  name: "success",
  delayMs: 0,
  remaining: null,
  status: null,
});

const scenarios = Object.fromEntries(
  OPERATIONS.map((operation) => [operation, { ...DEFAULT_SCENARIO }]),
);
const capturedRequests = [];
let eventCounter = 1;
let eventIds = new Set(["google-calendar-e2e-seeded"]);

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, contentType, payload) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  });
  response.end(payload);
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximumBytes) {
      const error = new Error("request_body_too_large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value, maximum = 160) {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

function authorizationKind(value) {
  if (typeof value !== "string" || !value.trim()) return "missing";
  return /^Bearer\s+\S+/iu.test(value) ? "bearer" : "other";
}

function captureMetadata(request, operation, bodyBytes, url, route) {
  const metadata = {
    id: randomUUID(),
    operation,
    method: request.method ?? "UNKNOWN",
    receivedAt: new Date().toISOString(),
    contentType: boundedString(request.headers["content-type"]),
    bodyBytes,
    authorization: authorizationKind(request.headers.authorization),
    queryKeys: Array.from(new Set(url.searchParams.keys())).sort().slice(0, 20),
    calendarIdPresent: Boolean(route.calendarId),
    eventIdPresent: Boolean(route.eventId),
  };

  capturedRequests.unshift(metadata);
  if (capturedRequests.length > MAX_CAPTURED_REQUESTS) {
    capturedRequests.length = MAX_CAPTURED_REQUESTS;
  }
  return metadata;
}

function resetState() {
  for (const operation of OPERATIONS) {
    scenarios[operation] = { ...DEFAULT_SCENARIO };
  }
  capturedRequests.length = 0;
  eventCounter = 1;
  eventIds = new Set(["google-calendar-e2e-seeded"]);
}

function currentScenario(operation) {
  const active = scenarios[operation];
  const result = { ...active };
  if (typeof active.remaining === "number") {
    active.remaining -= 1;
    if (active.remaining <= 0) {
      scenarios[operation] = { ...DEFAULT_SCENARIO };
    }
  }
  return result;
}

async function applyDelay(scenario) {
  const delayMs =
    scenario.name === "timeout" && scenario.delayMs === 0
      ? DEFAULT_TIMEOUT_DELAY_MS
      : scenario.delayMs;
  if (delayMs <= 0) return;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

function providerError(response, status, reason) {
  sendJson(response, status, {
    error: {
      code: status,
      message: `Deterministic Google Calendar fake ${reason}.`,
      status: reason,
    },
  });
}

function deterministicEvent(eventId) {
  return {
    id: eventId,
    status: "confirmed",
    summary: "Deterministic calendar event",
    updated: "2026-08-08T12:00:00.000Z",
    start: {
      dateTime: "2026-08-08T13:00:00.000Z",
      timeZone: "America/New_York",
    },
    end: {
      dateTime: "2026-08-08T14:15:00.000Z",
      timeZone: "America/New_York",
    },
    extendedProperties: {
      private: {
        appointmentId: "00000000-0000-4000-8000-000000000001",
        travelBufferMinutes: "15",
        durationMinutes: "60",
      },
    },
  };
}

function classifyRoute(request, url) {
  if (url.pathname === "/token" && request.method === "POST") {
    return { operation: "token", calendarId: null, eventId: null };
  }

  const match = url.pathname.match(
    /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/(watch|[^/]+))?$/u,
  );
  if (!match) return null;
  const calendarId = match[1] ?? null;
  const tail = match[2] ?? null;

  if (tail === "watch" && request.method === "POST") {
    return { operation: "watch", calendarId, eventId: null };
  }
  if (!tail && request.method === "POST") {
    return { operation: "create", calendarId, eventId: null };
  }
  if (!tail && request.method === "GET") {
    return { operation: "list", calendarId, eventId: null };
  }
  if (tail && request.method === "GET") {
    return { operation: "get", calendarId, eventId: tail };
  }
  if (tail && ["PATCH", "PUT"].includes(request.method ?? "")) {
    return { operation: "update", calendarId, eventId: tail };
  }
  if (tail && request.method === "DELETE") {
    return { operation: "delete", calendarId, eventId: tail };
  }
  return null;
}

function emptySuccess(response, operation) {
  if (operation === "delete") {
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
    return;
  }
  if (operation === "list") {
    sendJson(response, 200, { items: [], nextSyncToken: "sync-e2e-empty" });
    return;
  }
  sendJson(response, 200, {});
}

function successResponse(response, route, requestedEventId = null) {
  if (route.operation === "token") {
    sendJson(response, 200, {
      access_token: "google-calendar-e2e-access-token",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/calendar",
    });
    return;
  }
  if (route.operation === "watch") {
    sendJson(response, 200, {
      resourceId: "google-calendar-e2e-resource",
      expiration: "1786204800000",
    });
    return;
  }
  if (route.operation === "create") {
    const eventId =
      requestedEventId ??
      `google-calendar-e2e-${String(eventCounter).padStart(4, "0")}`;
    if (eventIds.has(eventId)) {
      providerError(response, 409, "conflict");
      return;
    }
    if (!requestedEventId) eventCounter += 1;
    eventIds.add(eventId);
    sendJson(response, 200, deterministicEvent(eventId));
    return;
  }
  if (route.operation === "list") {
    sendJson(response, 200, {
      items: Array.from(eventIds).sort().map(deterministicEvent),
      nextSyncToken: "sync-e2e-next",
    });
    return;
  }

  const eventId = route.eventId;
  if (!eventId || !eventIds.has(eventId)) {
    providerError(response, 404, "not_found");
    return;
  }
  if (route.operation === "delete") {
    eventIds.delete(eventId);
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
    return;
  }
  sendJson(response, 200, deterministicEvent(eventId));
}

async function respondForScenario(
  response,
  route,
  scenario,
  requestedEventId = null,
) {
  await applyDelay(scenario);

  const failures = {
    unauthorized: [401, "unauthorized"],
    forbidden: [403, "forbidden"],
    not_found: [404, "not_found"],
    conflict: [409, "conflict"],
    rate_limited: [429, "rate_limited"],
    provider_error: [scenario.status ?? 500, "provider_error"],
  };
  if (Object.prototype.hasOwnProperty.call(failures, scenario.name)) {
    const [status, reason] = failures[scenario.name];
    providerError(response, status, reason);
    return;
  }
  if (scenario.name === "malformed_json") {
    sendText(
      response,
      200,
      "application/json; charset=utf-8",
      "{malformed-json",
    );
    return;
  }
  if (scenario.name === "empty_success") {
    emptySuccess(response, route.operation);
    return;
  }
  successResponse(response, route, requestedEventId);
}

async function handleControl(request, response, url) {
  if (url.pathname === "/__control/reset" && request.method === "POST") {
    await readBody(request, MAX_CONTROL_BODY_BYTES);
    resetState();
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/__control/requests" && request.method === "GET") {
    sendJson(response, 200, {
      requests: capturedRequests,
      retained: capturedRequests.length,
      limit: MAX_CAPTURED_REQUESTS,
    });
    return true;
  }
  if (url.pathname === "/__control/scenario" && request.method === "PUT") {
    const payload = parseJson(await readBody(request, MAX_CONTROL_BODY_BYTES));
    const operation = isRecord(payload) ? payload.operation : null;
    const name = isRecord(payload) ? payload.scenario : null;
    if (!OPERATIONS.includes(operation) || !SCENARIO_NAMES.has(name)) {
      sendJson(response, 422, {
        ok: false,
        error: "operation and scenario must be supported values",
        operations: OPERATIONS,
        scenarios: Array.from(SCENARIO_NAMES),
      });
      return true;
    }

    const repeat = payload.repeat;
    if (
      repeat !== undefined &&
      (!Number.isInteger(repeat) || repeat < 1 || repeat > 100)
    ) {
      sendJson(response, 422, { ok: false, error: "repeat must be 1-100" });
      return true;
    }
    const delayMs = payload.delayMs ?? 0;
    if (
      !Number.isInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > MAX_SCENARIO_DELAY_MS
    ) {
      sendJson(response, 422, {
        ok: false,
        error: `delayMs must be 0-${MAX_SCENARIO_DELAY_MS}`,
      });
      return true;
    }
    const status = payload.status ?? null;
    if (
      status !== null &&
      (!Number.isInteger(status) || status < 500 || status > 599)
    ) {
      sendJson(response, 422, {
        ok: false,
        error: "status must be a 5xx integer",
      });
      return true;
    }

    scenarios[operation] = {
      name,
      delayMs,
      remaining: repeat ?? null,
      status,
    };
    sendJson(response, 200, {
      ok: true,
      operation,
      scenario: { name, delayMs, repeat: repeat ?? null, status },
    });
    return true;
  }
  return false;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(
      request.url ?? "/",
      "http://google-calendar-fake.local",
    );
    if (url.pathname === "/healthz" && request.method === "GET") {
      sendJson(response, 200, { ok: true, service: "google-calendar-fake" });
      return;
    }
    if (await handleControl(request, response, url)) return;

    const route = classifyRoute(request, url);
    if (!route) {
      providerError(response, 404, "unknown_endpoint");
      return;
    }

    const body = await readBody(request, MAX_PROVIDER_BODY_BYTES);
    const capture = captureMetadata(
      request,
      route.operation,
      body.byteLength,
      url,
      route,
    );
    if (route.operation !== "token" && capture.authorization !== "bearer") {
      providerError(response, 401, "unauthorized");
      return;
    }

    const scenario = currentScenario(route.operation);
    const createPayload =
      route.operation === "create" ? parseJson(body.toString("utf8")) : null;
    const requestedEventId =
      isRecord(createPayload) &&
      typeof createPayload.id === "string" &&
      /^[0-9a-v]{5,1024}$/u.test(createPayload.id)
        ? createPayload.id
        : null;
    await respondForScenario(response, route, scenario, requestedEventId);
    console.info("[google-calendar-fake] request", {
      operation: route.operation,
      method: request.method,
      bodyBytes: body.byteLength,
      scenario: scenario.name,
    });
  } catch (error) {
    if (error?.code === "BODY_TOO_LARGE") {
      providerError(response, 413, "request_body_too_large");
      return;
    }
    console.error("[google-calendar-fake] internal_error", {
      message: error instanceof Error ? error.message : "unknown_error",
    });
    if (!response.headersSent) {
      providerError(response, 500, "internal_error");
    } else if (!response.writableEnded) {
      response.end();
    }
  }
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(port, host, () => {
  console.info(`[google-calendar-fake] listening on ${host}:${port}`);
});

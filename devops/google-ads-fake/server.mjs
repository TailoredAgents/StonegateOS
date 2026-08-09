import { randomUUID } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";

const port = Number(process.env["PORT"] ?? 4014);
const host = process.env["HOST"] === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
const MAX_CAPTURED_REQUESTS = 100;
const MAX_PROVIDER_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_SCENARIO_DELAY_MS = 60_000;
const DEFAULT_TIMEOUT_DELAY_MS = 25_000;

const OPERATIONS = Object.freeze([
  "token",
  "accessible_customers",
  "search_stream",
  "mutate_negative_keyword",
]);
const SCENARIO_NAMES = new Set([
  "success",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "unprocessable",
  "rate_limited",
  "provider_error",
  "malformed_json",
  "empty_success",
  "invalid_success",
  "no_results",
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

function presence(value) {
  return typeof value === "string" && value.trim() ? "present" : "missing";
}

function classifyQuery(payload) {
  const query =
    isRecord(payload) && typeof payload.query === "string"
      ? payload.query.toLowerCase()
      : "";
  if (!query) return "missing";
  if (query.includes("from conversion_action")) return "conversion_actions";
  if (query.includes("from search_term_view")) return "search_terms";
  if (
    query.includes("from campaign") &&
    query.includes("segments.conversion_action")
  ) {
    return "campaign_conversions";
  }
  if (query.includes("from campaign")) return "campaign_metrics";
  return "unknown";
}

function mutationOperationCount(payload) {
  return isRecord(payload) && Array.isArray(payload.operations)
    ? payload.operations.length
    : null;
}

function captureMetadata(request, route, body, parsedBody) {
  const metadata = {
    id: randomUUID(),
    operation: route.operation,
    method: request.method ?? "UNKNOWN",
    receivedAt: new Date().toISOString(),
    contentType: boundedString(request.headers["content-type"]),
    bodyBytes: body.byteLength,
    authorization: authorizationKind(request.headers.authorization),
    developerToken: presence(request.headers["developer-token"]),
    loginCustomerId: presence(request.headers["login-customer-id"]),
    apiVersion: route.apiVersion,
    customerIdPresent: route.customerIdPresent,
    queryKind:
      route.operation === "search_stream" ? classifyQuery(parsedBody) : null,
    operationCount:
      route.operation === "mutate_negative_keyword"
        ? mutationOperationCount(parsedBody)
        : null,
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
}

function currentScenario(operation) {
  const active = scenarios[operation];
  const result = { ...active };
  if (typeof active.remaining === "number") {
    active.remaining -= 1;
    if (active.remaining <= 0) scenarios[operation] = { ...DEFAULT_SCENARIO };
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
      status: reason,
      message: `Deterministic Google Ads fake ${reason}.`,
    },
  });
}

function classifyRoute(request, url) {
  if (url.pathname === "/token" && request.method === "POST") {
    return {
      operation: "token",
      apiVersion: null,
      customerIdPresent: false,
    };
  }
  const accessible = url.pathname.match(
    /^\/(v[1-9]\d*)\/customers:listAccessibleCustomers$/u,
  );
  if (accessible && request.method === "GET") {
    return {
      operation: "accessible_customers",
      apiVersion: accessible[1] ?? null,
      customerIdPresent: false,
    };
  }
  const customerEndpoint = url.pathname.match(
    /^\/(v[1-9]\d*)\/customers\/([^/]+)\/(googleAds:searchStream|customerNegativeCriteria:mutate)$/u,
  );
  if (!customerEndpoint || request.method !== "POST") return null;
  return {
    operation:
      customerEndpoint[3] === "googleAds:searchStream"
        ? "search_stream"
        : "mutate_negative_keyword",
    apiVersion: customerEndpoint[1] ?? null,
    customerIdPresent: Boolean(customerEndpoint[2]),
  };
}

function searchResponse(queryKind) {
  if (queryKind === "conversion_actions") {
    return [
      {
        results: [
          {
            conversionAction: {
              resourceName: "customers/0000000001/conversionActions/7000000001",
              id: "7000000001",
              name: "Deterministic phone lead",
              category: "PHONE_CALL_LEAD",
              type: "AD_CALL",
              status: "ENABLED",
            },
          },
        ],
      },
    ];
  }
  if (queryKind === "search_terms") {
    return [
      {
        results: [
          {
            segments: { date: "2026-08-08" },
            campaign: { id: "8000000001", name: "Deterministic campaign" },
            adGroup: { id: "8100000001" },
            searchTermView: { searchTerm: "deterministic search term" },
            metrics: {
              impressions: "12",
              clicks: "3",
              costMicros: "2500000",
              conversions: 1,
              conversionsValue: 125,
            },
          },
        ],
      },
    ];
  }
  if (queryKind === "campaign_conversions") {
    return [
      {
        results: [
          {
            segments: {
              date: "2026-08-08",
              conversionAction:
                "customers/0000000001/conversionActions/7000000001",
              conversionActionName: "Deterministic phone lead",
            },
            campaign: { id: "8000000001" },
            metrics: { conversions: 1, conversionsValue: 125 },
          },
        ],
      },
    ];
  }
  if (queryKind === "campaign_metrics") {
    return [
      {
        results: [
          {
            segments: { date: "2026-08-08" },
            campaign: { id: "8000000001", name: "Deterministic campaign" },
            metrics: {
              impressions: "100",
              clicks: "10",
              costMicros: "12500000",
              conversions: 2,
              conversionsValue: 250,
            },
          },
        ],
      },
    ];
  }
  return [];
}

function emptySuccess(response) {
  sendText(response, 200, "application/json; charset=utf-8", "");
}

function invalidSuccess(response, operation) {
  if (operation === "token") {
    sendJson(response, 200, { access_token: 123 });
    return;
  }
  if (operation === "accessible_customers") {
    sendJson(response, 200, {
      resourceNames: ["customers/0000000001", null],
    });
    return;
  }
  if (operation === "search_stream") {
    sendJson(response, 200, [{ results: [null] }]);
    return;
  }
  sendJson(response, 200, {
    results: [
      {
        resourceName:
          "customers/9999999999/customerNegativeCriteria/9000000001",
      },
    ],
  });
}

function noResults(response, operation) {
  if (operation === "accessible_customers") {
    sendJson(response, 200, { resourceNames: [] });
    return;
  }
  if (operation === "search_stream") {
    sendJson(response, 200, []);
    return;
  }
  providerError(response, 422, "no_results_not_supported");
}

function successResponse(response, route, parsedBody) {
  if (route.operation === "token") {
    sendJson(response, 200, {
      access_token: "google-ads-e2e-access-token",
      expires_in: 3600,
      token_type: "Bearer",
    });
    return;
  }
  if (route.operation === "accessible_customers") {
    sendJson(response, 200, { resourceNames: ["customers/0000000001"] });
    return;
  }
  if (route.operation === "search_stream") {
    const queryKind = classifyQuery(parsedBody);
    if (queryKind === "missing" || queryKind === "unknown") {
      providerError(response, 422, "unprocessable");
      return;
    }
    sendJson(response, 200, searchResponse(queryKind));
    return;
  }
  sendJson(response, 200, {
    results: [
      {
        resourceName:
          "customers/0000000001/customerNegativeCriteria/9000000001",
      },
    ],
  });
}

async function respondForScenario(response, route, scenario, parsedBody) {
  await applyDelay(scenario);
  const failures = {
    unauthorized: [401, "unauthorized"],
    forbidden: [403, "forbidden"],
    not_found: [404, "not_found"],
    conflict: [409, "conflict"],
    unprocessable: [422, "unprocessable"],
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
    emptySuccess(response);
    return;
  }
  if (scenario.name === "invalid_success") {
    invalidSuccess(response, route.operation);
    return;
  }
  if (scenario.name === "no_results") {
    noResults(response, route.operation);
    return;
  }
  successResponse(response, route, parsedBody);
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
    const url = new URL(request.url ?? "/", "http://google-ads-fake.local");
    if (url.pathname === "/healthz" && request.method === "GET") {
      sendJson(response, 200, { ok: true, service: "google-ads-fake" });
      return;
    }
    if (await handleControl(request, response, url)) return;

    const route = classifyRoute(request, url);
    if (!route) {
      providerError(response, 404, "unknown_endpoint");
      return;
    }
    const body = await readBody(request, MAX_PROVIDER_BODY_BYTES);
    const parsedBody = parseJson(body);
    const capture = captureMetadata(request, route, body, parsedBody);
    if (
      route.operation !== "token" &&
      (capture.authorization !== "bearer" ||
        capture.developerToken !== "present")
    ) {
      providerError(response, 401, "unauthorized");
      return;
    }

    const scenario = currentScenario(route.operation);
    await respondForScenario(response, route, scenario, parsedBody);
    console.info("[google-ads-fake] request", {
      operation: route.operation,
      method: request.method,
      bodyBytes: body.byteLength,
      scenario: scenario.name,
      queryKind: capture.queryKind,
      operationCount: capture.operationCount,
    });
  } catch (error) {
    if (error?.code === "BODY_TOO_LARGE") {
      providerError(response, 413, "request_body_too_large");
      return;
    }
    console.error("[google-ads-fake] internal_error", {
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
  console.info(`[google-ads-fake] listening on ${host}:${port}`);
});

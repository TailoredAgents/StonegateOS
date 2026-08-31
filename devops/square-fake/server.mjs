import { randomUUID } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";

const port = Number(process.env["PORT"] ?? 4015);
const host = process.env["HOST"] === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
const MAX_CAPTURED_REQUESTS = 100;
const MAX_PROVIDER_BODY_BYTES = 64 * 1024;
const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_SCENARIO_DELAY_MS = 60_000;
const DEFAULT_TIMEOUT_DELAY_MS = 25_000;

const OPERATIONS = Object.freeze([
  "retrieve_order",
  "retrieve_payment",
  "retrieve_refund",
  "list_payments",
  "list_refunds",
  "create_payment_link",
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
const FIXTURE = Object.freeze({
  orderId: "order-e2e-0001",
  paymentId: "payment-e2e-0001",
  refundId: "refund-e2e-0001",
  locationId: "location-e2e-0001",
  attemptId: "11111111-1111-4111-8111-111111111111",
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

function headerPresence(value) {
  return typeof value === "string" && value.trim() ? "present" : "missing";
}

function authorizationKind(value) {
  if (typeof value !== "string" || !value.trim()) return "missing";
  return /^Bearer\s+\S+/iu.test(value) ? "bearer" : "other";
}

function classifyRoute(request, url) {
  if (
    request.method === "POST" &&
    url.pathname === "/v2/online-checkout/payment-links"
  ) {
    return { operation: "create_payment_link", resourceId: null };
  }
  if (request.method !== "GET") return null;
  if (url.pathname === "/v2/payments") {
    return { operation: "list_payments", resourceId: null };
  }
  if (url.pathname === "/v2/refunds") {
    return { operation: "list_refunds", resourceId: null };
  }
  const resource = url.pathname.match(
    /^\/v2\/(orders|payments|refunds)\/([^/]+)$/u,
  );
  if (!resource) return null;
  const operation = {
    orders: "retrieve_order",
    payments: "retrieve_payment",
    refunds: "retrieve_refund",
  }[resource[1]];
  return {
    operation,
    resourceId: decodeURIComponent(resource[2] ?? ""),
  };
}

function captureMetadata(request, route, url, body) {
  const parsedBody = parseJson(body);
  const paymentLinkBody =
    route.operation === "create_payment_link" && isRecord(parsedBody)
      ? parsedBody
      : null;
  const serializedPaymentLinkBody = paymentLinkBody
    ? JSON.stringify(paymentLinkBody).toLowerCase()
    : "";
  const metadata = {
    id: randomUUID(),
    operation: route.operation,
    method: request.method ?? "UNKNOWN",
    receivedAt: new Date().toISOString(),
    bodyBytes: body.byteLength,
    authorization: authorizationKind(request.headers.authorization),
    squareVersion: headerPresence(request.headers["square-version"]),
    resourceIdPresent: Boolean(route.resourceId),
    locationFilterPresent: url.searchParams.has("location_id"),
    timeWindowPresent:
      url.searchParams.has("begin_time") && url.searchParams.has("end_time"),
    cursorPresent: url.searchParams.has("cursor"),
    idempotencyKeyPresent:
      typeof paymentLinkBody?.idempotency_key === "string" &&
      paymentLinkBody.idempotency_key.length > 0,
    quickPayPresent: isRecord(paymentLinkBody?.quick_pay),
    paymentNotePresent:
      typeof paymentLinkBody?.payment_note === "string" &&
      paymentLinkBody.payment_note.length > 0,
    rawPaymentSourcePresent:
      serializedPaymentLinkBody.includes('"source_id"') ||
      serializedPaymentLinkBody.includes('"card"') ||
      serializedPaymentLinkBody.includes('"bank_account"'),
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
    errors: [{ category: reason, code: `FAKE_${status}` }],
  });
}

function order(resourceId = FIXTURE.orderId) {
  return {
    id: resourceId,
    location_id: FIXTURE.locationId,
    state: "COMPLETED",
    total_money: { amount: 10_000, currency: "USD" },
    total_tip_money: { amount: 2_000, currency: "USD" },
    line_items: [
      {
        name: "Deterministic Stonegate job",
        note: `Stonegate appointment appointment-e2e; attempt ${FIXTURE.attemptId}`,
      },
    ],
    tenders: [
      {
        id: FIXTURE.paymentId,
        payment_id: FIXTURE.paymentId,
        type: "CARD",
        location_id: FIXTURE.locationId,
        amount_money: { amount: 12_000, currency: "USD" },
        tip_money: { amount: 2_000, currency: "USD" },
      },
    ],
  };
}

function payment(resourceId = FIXTURE.paymentId) {
  return {
    id: resourceId,
    order_id: FIXTURE.orderId,
    location_id: FIXTURE.locationId,
    status: "COMPLETED",
    source_type: "CARD",
    amount_money: { amount: 10_000, currency: "USD" },
    tip_money: { amount: 2_000, currency: "USD" },
    total_money: { amount: 12_000, currency: "USD" },
    refunded_money: { amount: 0, currency: "USD" },
    receipt_url: "https://squareup.com/receipt/e2e-receipt",
    created_at: "2026-08-08T12:00:00.000Z",
    updated_at: "2026-08-08T12:01:00.000Z",
    card_details: {
      entry_method: "CONTACTLESS",
      card: { card_brand: "VISA", last_4: "4242" },
    },
  };
}

function refund(resourceId = FIXTURE.refundId) {
  return {
    id: resourceId,
    payment_id: FIXTURE.paymentId,
    order_id: FIXTURE.orderId,
    location_id: FIXTURE.locationId,
    status: "COMPLETED",
    amount_money: { amount: 2_000, currency: "USD" },
    reason: "Deterministic correction",
    created_at: "2026-08-08T13:00:00.000Z",
    updated_at: "2026-08-08T13:01:00.000Z",
  };
}

function invalidSuccess(response, operation) {
  if (operation === "create_payment_link") {
    sendJson(response, 200, {
      payment_link: {
        id: 123,
        order_id: null,
        url: "javascript:unsafe",
      },
    });
    return;
  }
  if (operation === "retrieve_order") {
    sendJson(response, 200, { order: { id: 123 } });
    return;
  }
  if (operation === "retrieve_payment") {
    sendJson(response, 200, {
      payment: { id: 123, receipt_url: "javascript:unsafe" },
    });
    return;
  }
  if (operation === "retrieve_refund") {
    sendJson(response, 200, { refund: { id: 123 } });
    return;
  }
  sendJson(response, 200, {
    [operation === "list_payments" ? "payments" : "refunds"]: [null],
  });
}

function successResponse(response, route, url) {
  if (route.operation === "create_payment_link") {
    sendJson(response, 200, {
      payment_link: {
        id: "payment-link-e2e-0001",
        version: 1,
        order_id: FIXTURE.orderId,
        url: "https://sandbox.square.link/u/e2e-checkout",
        long_url: "https://checkout.square.site/e2e-checkout",
        created_at: "2026-08-30T12:00:01.000Z",
      },
    });
    return;
  }
  if (route.operation === "retrieve_order") {
    sendJson(response, 200, { order: order(route.resourceId) });
    return;
  }
  if (route.operation === "retrieve_payment") {
    sendJson(response, 200, { payment: payment(route.resourceId) });
    return;
  }
  if (route.operation === "retrieve_refund") {
    sendJson(response, 200, { refund: refund(route.resourceId) });
    return;
  }
  const collection =
    route.operation === "list_payments" ? "payments" : "refunds";
  if (url.searchParams.get("cursor") === "e2e-next-page") {
    sendJson(response, 200, {
      [collection]: [
        collection === "payments"
          ? payment("payment-e2e-0002")
          : refund("refund-e2e-0002"),
      ],
    });
    return;
  }
  sendJson(response, 200, {
    [collection]: [collection === "payments" ? payment() : refund()],
    cursor: "e2e-next-page",
  });
}

async function respondForScenario(response, route, url, scenario) {
  await applyDelay(scenario);
  const failures = {
    unauthorized: [401, "UNAUTHORIZED"],
    forbidden: [403, "FORBIDDEN"],
    not_found: [404, "NOT_FOUND"],
    conflict: [409, "CONFLICT"],
    unprocessable: [422, "UNPROCESSABLE"],
    rate_limited: [429, "RATE_LIMITED"],
    provider_error: [scenario.status ?? 500, "PROVIDER_ERROR"],
  };
  if (Object.prototype.hasOwnProperty.call(failures, scenario.name)) {
    const [status, reason] = failures[scenario.name];
    providerError(response, status, reason);
    return;
  }
  if (scenario.name === "malformed_json") {
    sendText(response, 200, "application/json; charset=utf-8", "{malformed");
    return;
  }
  if (scenario.name === "empty_success") {
    sendText(response, 200, "application/json; charset=utf-8", "");
    return;
  }
  if (scenario.name === "invalid_success") {
    invalidSuccess(response, route.operation);
    return;
  }
  if (scenario.name === "no_results") {
    if (route.operation === "list_payments") {
      sendJson(response, 200, { payments: [] });
    } else if (route.operation === "list_refunds") {
      sendJson(response, 200, { refunds: [] });
    } else {
      providerError(response, 422, "NO_RESULTS_UNSUPPORTED");
    }
    return;
  }
  successResponse(response, route, url);
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
    const url = new URL(request.url ?? "/", "http://square-fake.local");
    if (url.pathname === "/healthz" && request.method === "GET") {
      sendJson(response, 200, { ok: true, service: "square-fake" });
      return;
    }
    if (await handleControl(request, response, url)) return;

    const route = classifyRoute(request, url);
    if (!route) {
      providerError(response, 404, "UNKNOWN_ENDPOINT");
      return;
    }
    const body = await readBody(request, MAX_PROVIDER_BODY_BYTES);
    const capture = captureMetadata(request, route, url, body);
    if (
      capture.authorization !== "bearer" ||
      capture.squareVersion !== "present"
    ) {
      providerError(response, 401, "UNAUTHORIZED");
      return;
    }

    const scenario = currentScenario(route.operation);
    await respondForScenario(response, route, url, scenario);
    console.info("[square-fake] request", {
      operation: route.operation,
      method: request.method,
      bodyBytes: body.byteLength,
      scenario: scenario.name,
    });
  } catch (error) {
    if (error?.code === "BODY_TOO_LARGE") {
      providerError(response, 413, "REQUEST_BODY_TOO_LARGE");
      return;
    }
    console.error("[square-fake] internal_error", { kind: "internal_error" });
    if (!response.headersSent) {
      providerError(response, 500, "INTERNAL_ERROR");
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
  console.info(`[square-fake] listening on ${host}:${port}`);
});

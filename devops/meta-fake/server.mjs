import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";

const port = Number(process.env["PORT"] ?? 4013);
const host = process.env["HOST"] === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
const MAX_CAPTURED_REQUESTS = 100;
const MAX_PROVIDER_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_SCENARIO_DELAY_MS = 30_000;
const GRAPH_VERSION = "v24.0";

const VALID_SCENARIOS = new Set([
  "success",
  "oauth_denied",
  "permission_denied",
  "not_found",
  "conflict",
  "rate_limited",
  "provider_error",
  "malformed_json",
  "empty_success",
  "timeout",
  "media_partial_failure",
]);

const VALID_OPERATIONS = new Set([
  "all",
  "messenger.message",
  "messenger.typing",
  "messenger.media",
  "page_token.lookup",
  "identity.lookup",
  "lead.lookup",
  "token.debug",
  "page.subscriptions",
  "ads.insights",
  "conversions.events",
]);

const DEFAULT_SCENARIO = Object.freeze({
  name: "success",
  operation: "all",
  repeat: null,
  delayMs: 0,
  mediaFailureAt: 2,
  adsPages: 2,
});

let scenario = { ...DEFAULT_SCENARIO };
let mediaAttachmentAttempts = 0;
const capturedRequests = [];

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function sendMalformedJson(response) {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end("{malformed-json");
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error("request_body_too_large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(buffer) {
  if (buffer.byteLength === 0) return null;
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeHash(value) {
  if (typeof value !== "string" || !value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function boundedUnshift(target, value, maximum) {
  target.unshift(value);
  if (target.length > maximum) target.length = maximum;
}

function operationFor(request, url, parsedBody) {
  if (
    request.method === "POST" &&
    url.pathname === `/${GRAPH_VERSION}/me/messages`
  ) {
    if (typeof parsedBody?.sender_action === "string") {
      return "messenger.typing";
    }
    if (isRecord(parsedBody?.message?.attachment)) {
      return "messenger.media";
    }
    return "messenger.message";
  }
  if (request.method === "GET" && url.pathname === "/debug_token") {
    return "token.debug";
  }
  if (
    request.method === "GET" &&
    new RegExp(`^/${GRAPH_VERSION}/[^/]+/subscribed_apps$`, "u").test(
      url.pathname,
    )
  ) {
    return "page.subscriptions";
  }
  if (
    request.method === "GET" &&
    new RegExp(`^/${GRAPH_VERSION}/act_[^/]+/insights$`, "u").test(url.pathname)
  ) {
    return "ads.insights";
  }
  if (
    request.method === "POST" &&
    new RegExp(`^/${GRAPH_VERSION}/[^/]+/events$`, "u").test(url.pathname)
  ) {
    return "conversions.events";
  }
  if (
    request.method === "GET" &&
    new RegExp(`^/${GRAPH_VERSION}/[^/]+$`, "u").test(url.pathname)
  ) {
    const fields = url.searchParams.get("fields") ?? "";
    if (fields.split(",").includes("access_token")) {
      return "page_token.lookup";
    }
    if (fields.split(",").includes("field_data")) {
      return "lead.lookup";
    }
    return "identity.lookup";
  }
  return null;
}

function targetFromPath(url) {
  const segments = url.pathname.split("/").filter(Boolean);
  const candidate = segments[0] === GRAPH_VERSION ? segments[1] : null;
  if (!candidate || candidate === "me" || candidate.startsWith("act_")) {
    return candidate?.startsWith("act_") ? candidate.slice(4) : null;
  }
  return candidate;
}

function captureRequest(request, url, operation, body, parsedBody) {
  const recipientId = isRecord(parsedBody?.recipient)
    ? parsedBody.recipient.id
    : null;
  const targetId = targetFromPath(url);
  const message = isRecord(parsedBody?.message) ? parsedBody.message : null;
  const attachment = isRecord(message?.attachment) ? message.attachment : null;
  const attachmentPayload = isRecord(attachment?.payload)
    ? attachment.payload
    : null;
  const dispatchId = request.headers["x-stonegate-dispatch-id"];

  boundedUnshift(
    capturedRequests,
    {
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      method: request.method ?? "UNKNOWN",
      operation,
      scenario: scenario.name,
      bodyBytes: body.byteLength,
      contentType:
        typeof request.headers["content-type"] === "string"
          ? request.headers["content-type"].slice(0, 100)
          : null,
      credentialLocation:
        url.searchParams.has("access_token") ||
        url.searchParams.has("input_token")
          ? "query"
          : typeof request.headers.authorization === "string"
            ? "authorization"
            : "missing",
      queryKeys: [...new Set(url.searchParams.keys())].sort().slice(0, 20),
      targetIdHash: safeHash(targetId),
      recipientIdHash: safeHash(recipientId),
      textLength: typeof message?.text === "string" ? message.text.length : 0,
      senderAction:
        typeof parsedBody?.sender_action === "string"
          ? parsedBody.sender_action.slice(0, 20)
          : null,
      attachmentType:
        typeof attachment?.type === "string"
          ? attachment.type.slice(0, 20)
          : null,
      hasMediaUrl: typeof attachmentPayload?.url === "string",
      eventCount: Array.isArray(parsedBody?.data)
        ? Math.min(parsedBody.data.length, 1000)
        : null,
      dispatchIdHash:
        typeof dispatchId === "string" ? safeHash(dispatchId) : null,
    },
    MAX_CAPTURED_REQUESTS,
  );
}

function resetScenario() {
  scenario = { ...DEFAULT_SCENARIO };
  mediaAttachmentAttempts = 0;
}

function consumeScenario() {
  if (typeof scenario.repeat !== "number") return;
  scenario.repeat -= 1;
  if (scenario.repeat <= 0) resetScenario();
}

function scenarioApplies(operation) {
  return (
    scenario.name !== "success" &&
    (scenario.operation === "all" || scenario.operation === operation)
  );
}

async function applyScenario(request, response, operation) {
  if (!scenarioApplies(operation)) return false;

  const selected = { ...scenario };
  if (selected.name === "media_partial_failure") {
    if (operation !== "messenger.media") return false;
    mediaAttachmentAttempts += 1;
    if (mediaAttachmentAttempts !== selected.mediaFailureAt) return false;
  }
  consumeScenario();

  if (selected.delayMs > 0) {
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, selected.delayMs),
    );
  }
  if (selected.name === "timeout") {
    request.socket.destroy();
    return true;
  }
  if (selected.name === "malformed_json") {
    sendMalformedJson(response);
    return true;
  }
  if (selected.name === "empty_success") {
    sendJson(response, 200, {});
    return true;
  }

  const errors = {
    oauth_denied: [401, "OAuthException", 190, "Invalid OAuth access token."],
    permission_denied: [403, "OAuthException", 200, "Permission denied."],
    not_found: [404, "GraphMethodException", 100, "Object not found."],
    conflict: [409, "GraphConflictException", 409, "Conflicting operation."],
    rate_limited: [
      429,
      "OAuthException",
      4,
      "Application request limit reached.",
    ],
    provider_error: [503, "GraphProviderException", 2, "Provider unavailable."],
    media_partial_failure: [
      503,
      "GraphProviderException",
      2,
      "Media send failed.",
    ],
  };
  const selectedError = errors[selected.name];
  if (!selectedError) return false;
  const [status, type, code, message] = selectedError;
  sendJson(
    response,
    status,
    {
      error: {
        message: `Deterministic Meta fake: ${message}`,
        type,
        code,
        fbtrace_id: "meta-e2e-trace",
      },
    },
    status === 429 ? { "Retry-After": "1" } : {},
  );
  return true;
}

function successfulResponse(request, response, url, operation, parsedBody) {
  switch (operation) {
    case "messenger.message":
    case "messenger.media":
      return sendJson(response, 200, {
        recipient_id: "recipient-e2e",
        message_id: `mid.e2e.${randomUUID()}`,
      });
    case "messenger.typing":
      return sendJson(response, 200, { recipient_id: "recipient-e2e" });
    case "page_token.lookup":
      return sendJson(response, 200, {
        id: "page-e2e",
        name: "Stonegate E2E Page",
        access_token: "e2e-meta-page-token",
      });
    case "lead.lookup":
      return sendJson(response, 200, {
        id: "lead-e2e",
        created_time: "2026-08-08T12:00:00+0000",
        form_id: "form-e2e",
        ad_id: "ad-e2e",
        ad_name: "Deterministic E2E Ad",
        adset_id: "adset-e2e",
        adset_name: "Deterministic E2E Ad Set",
        campaign_id: "campaign-e2e",
        campaign_name: "Deterministic E2E Campaign",
        field_data: [
          { name: "first_name", values: ["E2E"] },
          { name: "last_name", values: ["Contact"] },
          { name: "email", values: ["customer@example.test"] },
          { name: "phone_number", values: ["+15555550123"] },
        ],
      });
    case "identity.lookup":
      return sendJson(response, 200, {
        id: "identity-e2e",
        name: "E2E Messenger Contact",
        first_name: "E2E",
        last_name: "Contact",
      });
    case "token.debug":
      return sendJson(response, 200, {
        data: {
          app_id: "app-e2e",
          type: "SYSTEM_USER",
          is_valid: true,
          scopes: ["pages_messaging", "leads_retrieval", "ads_read"],
        },
      });
    case "page.subscriptions":
      return sendJson(response, 200, {
        data: [{ id: "app-e2e", name: "Stonegate E2E App" }],
      });
    case "ads.insights": {
      const after = url.searchParams.get("after");
      const page = after ? 2 : 1;
      const payload = {
        data: [
          {
            date_start: "2026-08-08",
            date_stop: "2026-08-08",
            account_id: "000000000000001",
            account_currency: "USD",
            campaign_id: `campaign-e2e-${page}`,
            campaign_name: `Deterministic Campaign ${page}`,
            adset_id: `adset-e2e-${page}`,
            adset_name: `Deterministic Ad Set ${page}`,
            ad_id: `ad-e2e-${page}`,
            ad_name: `Deterministic Ad ${page}`,
            impressions: String(100 * page),
            clicks: String(10 * page),
            reach: String(80 * page),
            spend: (12.34 * page).toFixed(2),
          },
        ],
      };
      if (!after && scenario.adsPages > 1) {
        const next = new URL(url.toString());
        next.searchParams.set("after", "e2e-next");
        next.searchParams.set("access_token", "e2e-meta-marketing-token");
        payload.paging = { next: next.toString() };
      }
      return sendJson(response, 200, payload);
    }
    case "conversions.events":
      return sendJson(response, 200, {
        events_received: Array.isArray(parsedBody?.data)
          ? parsedBody.data.length
          : 0,
        messages: [],
        fbtrace_id: "meta-e2e-trace",
      });
    default:
      return sendJson(response, 404, {
        error: { code: 100, message: "Unsupported Meta fake endpoint." },
      });
  }
}

async function readControlJson(request) {
  const body = await readBody(request, MAX_CONTROL_BODY_BYTES);
  if (body.byteLength === 0) return {};
  const parsed = parseJson(body);
  if (!isRecord(parsed)) throw new Error("invalid_json");
  return parsed;
}

const server = http.createServer(async (request, response) => {
  const requestHost =
    typeof request.headers.host === "string" && request.headers.host
      ? request.headers.host
      : `127.0.0.1:${port}`;
  const url = new URL(request.url ?? "/", `http://${requestHost}`);

  if (request.method === "GET" && url.pathname === "/healthz") {
    return sendJson(response, 200, { ok: true, provider: "meta-fake" });
  }
  if (request.method === "GET" && url.pathname === "/__control/state") {
    return sendJson(response, 200, {
      scenario,
      retainedCaptures: capturedRequests.length,
      limits: { captures: MAX_CAPTURED_REQUESTS },
    });
  }
  if (request.method === "GET" && url.pathname === "/__control/requests") {
    return sendJson(response, 200, {
      requests: capturedRequests,
      retained: capturedRequests.length,
      limit: MAX_CAPTURED_REQUESTS,
    });
  }
  if (request.method === "POST" && url.pathname === "/__control/reset") {
    capturedRequests.length = 0;
    resetScenario();
    return sendJson(response, 200, { ok: true });
  }
  if (
    (request.method === "PUT" || request.method === "POST") &&
    url.pathname === "/__control/scenario"
  ) {
    try {
      const payload = await readControlJson(request);
      const name = typeof payload.name === "string" ? payload.name : "";
      const operation =
        typeof payload.operation === "string" ? payload.operation : "all";
      const repeat =
        payload.repeat === undefined || payload.repeat === null
          ? null
          : Number(payload.repeat);
      const delayMs =
        payload.delayMs === undefined ? 0 : Number(payload.delayMs);
      const mediaFailureAt =
        payload.mediaFailureAt === undefined
          ? 2
          : Number(payload.mediaFailureAt);
      const adsPages =
        payload.adsPages === undefined ? 2 : Number(payload.adsPages);
      if (
        !VALID_SCENARIOS.has(name) ||
        !VALID_OPERATIONS.has(operation) ||
        (repeat !== null &&
          (!Number.isInteger(repeat) || repeat < 1 || repeat > 100)) ||
        !Number.isInteger(delayMs) ||
        delayMs < 0 ||
        delayMs > MAX_SCENARIO_DELAY_MS ||
        !Number.isInteger(mediaFailureAt) ||
        mediaFailureAt < 1 ||
        mediaFailureAt > 100 ||
        !Number.isInteger(adsPages) ||
        adsPages < 1 ||
        adsPages > 2
      ) {
        return sendJson(response, 422, { error: "invalid_scenario" });
      }
      scenario = {
        name,
        operation,
        repeat,
        delayMs,
        mediaFailureAt,
        adsPages,
      };
      mediaAttachmentAttempts = 0;
      return sendJson(response, 200, { ok: true, scenario });
    } catch {
      return sendJson(response, 400, { error: "invalid_json" });
    }
  }

  let body;
  try {
    body = await readBody(request, MAX_PROVIDER_BODY_BYTES);
  } catch (error) {
    return sendJson(response, error?.code === "BODY_TOO_LARGE" ? 413 : 400, {
      error: { code: 100, message: "Invalid request body." },
    });
  }
  const parsedBody = parseJson(body);
  const operation = operationFor(request, url, parsedBody);
  if (!operation) {
    return sendJson(response, 404, {
      error: { code: 100, message: "Unsupported Meta fake endpoint." },
    });
  }
  if (
    request.method === "POST" &&
    body.byteLength > 0 &&
    !isRecord(parsedBody)
  ) {
    return sendJson(response, 400, {
      error: { code: 100, message: "JSON body required." },
    });
  }

  captureRequest(request, url, operation, body, parsedBody);
  if (await applyScenario(request, response, operation)) return;
  return successfulResponse(request, response, url, operation, parsedBody);
});

server.listen(port, host, () => {
  console.info(`Meta fake listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

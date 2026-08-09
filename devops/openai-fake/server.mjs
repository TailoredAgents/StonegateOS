import { randomUUID } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";

const port = Number(process.env["PORT"] ?? 4011);
const host = process.env["HOST"] === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
const MAX_CAPTURED_REQUESTS = 100;
const MAX_PROVIDER_BODY_BYTES = 30 * 1024 * 1024;
const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_SCENARIO_DELAY_MS = 60_000;

const DEFAULT_SCENARIO = Object.freeze({
  name: "success",
  delayMs: 0,
  remaining: null,
  status: null,
  responseBody: null,
  outputText: "Deterministic local OpenAI response.",
  transcriptionText: "Deterministic local transcription.",
});

const scenarios = {
  responses: { ...DEFAULT_SCENARIO },
  transcriptions: { ...DEFAULT_SCENARIO },
};
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

function boundedString(value, maximum = 100) {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

function authorizationKind(value) {
  if (typeof value !== "string" || !value.trim()) return "missing";
  return /^Bearer\s+\S+/iu.test(value) ? "bearer" : "other";
}

function captureMetadata(request, endpoint, body, parsedJson) {
  const contentType = boundedString(request.headers["content-type"], 160);
  const format =
    isRecord(parsedJson?.text) && isRecord(parsedJson.text.format)
      ? parsedJson.text.format
      : null;
  const modalities = Array.isArray(parsedJson?.modalities)
    ? parsedJson.modalities
        .filter((item) => typeof item === "string")
        .slice(0, 4)
    : [];
  const metadata = {
    id: randomUUID(),
    endpoint,
    method: request.method ?? "UNKNOWN",
    receivedAt: new Date().toISOString(),
    contentType,
    bodyBytes: body.byteLength,
    authorization: authorizationKind(request.headers.authorization),
    model: boundedString(parsedJson?.model, 100),
    schemaName: boundedString(format?.name, 100),
    inputItemCount: Array.isArray(parsedJson?.input)
      ? parsedJson.input.length
      : null,
    modalities,
    multipart: Boolean(
      contentType?.toLowerCase().startsWith("multipart/form-data"),
    ),
  };

  capturedRequests.unshift(metadata);
  if (capturedRequests.length > MAX_CAPTURED_REQUESTS) {
    capturedRequests.length = MAX_CAPTURED_REQUESTS;
  }
  return metadata;
}

function chooseNumber(key, schema, integer) {
  const lowerKey = key.toLowerCase();
  let value = integer ? 1 : 0.75;
  if (/price|amount|total|cost|deposit|revenue|value/u.test(lowerKey)) {
    value = /high|max/u.test(lowerKey) ? 300 : 150;
  } else if (/score/u.test(lowerKey)) {
    value = 85;
  } else if (/fraction|confidence|probability|rate|ratio/u.test(lowerKey)) {
    value = 0.75;
  } else if (/duration|minute/u.test(lowerKey)) {
    value = 60;
  }

  const minimum = Number.isFinite(schema.minimum) ? schema.minimum : null;
  const maximum = Number.isFinite(schema.maximum) ? schema.maximum : null;
  if (minimum !== null) value = Math.max(value, minimum);
  if (maximum !== null) value = Math.min(value, maximum);
  return integer ? Math.round(value) : value;
}

function chooseString(key, schema) {
  if (Array.isArray(schema.enum) && typeof schema.enum[0] === "string") {
    return schema.enum[0];
  }
  if (typeof schema.const === "string") return schema.const;

  const lowerKey = key.toLowerCase();
  let value = `Deterministic E2E ${key || "value"}.`;
  if (/email/u.test(lowerKey) || schema.format === "email") {
    value = "customer@example.test";
  } else if (/phone/u.test(lowerKey)) {
    value = "+15555550123";
  } else if (schema.format === "date-time") {
    value = "2026-08-08T12:00:00.000Z";
  } else if (schema.format === "date") {
    value = "2026-08-08";
  } else if (schema.format === "uri" || /url|link/u.test(lowerKey)) {
    value = "https://example.test/e2e";
  } else if (schema.format === "uuid" || /(^|_)id$/u.test(lowerKey)) {
    value = "00000000-0000-4000-8000-000000000001";
  }

  const minimum = Number.isInteger(schema.minLength) ? schema.minLength : 0;
  while (value.length < minimum) value += " e2e";
  const maximum = Number.isInteger(schema.maxLength) ? schema.maxLength : null;
  return maximum === null ? value : value.slice(0, maximum);
}

function valueForSchema(schema, key = "value", depth = 0) {
  if (!isRecord(schema) || depth > 12) return null;
  if (Object.prototype.hasOwnProperty.call(schema, "const"))
    return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0)
    return schema.enum[0];
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return valueForSchema(schema.oneOf[0], key, depth + 1);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const nonNull = schema.anyOf.find(
      (candidate) => candidate?.type !== "null",
    );
    return valueForSchema(nonNull ?? schema.anyOf[0], key, depth + 1);
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((candidate) => candidate && candidate !== "null");
  if (type === "string") return chooseString(key, schema);
  if (type === "integer") return chooseNumber(key, schema, true);
  if (type === "number") return chooseNumber(key, schema, false);
  if (type === "boolean") return false;
  if (type === "array") {
    const count = Math.max(
      1,
      Number.isInteger(schema.minItems) ? schema.minItems : 1,
    );
    return Array.from({ length: Math.min(count, 10) }, (_, index) =>
      valueForSchema(
        schema.items ?? { type: "string" },
        `${key}_${index + 1}`,
        depth + 1,
      ),
    );
  }
  if (type === "object" || isRecord(schema.properties)) {
    const result = {};
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [property, propertySchema] of Object.entries(properties)) {
      result[property] = valueForSchema(propertySchema, property, depth + 1);
    }
    return result;
  }
  return null;
}

function structuredOutput(parsedJson) {
  const format =
    isRecord(parsedJson?.text) && isRecord(parsedJson.text.format)
      ? parsedJson.text.format
      : null;
  if (!isRecord(format?.schema)) return null;
  return JSON.stringify(valueForSchema(format.schema));
}

function currentScenario(endpoint) {
  const active = scenarios[endpoint];
  const result = { ...active };
  if (typeof active.remaining === "number") {
    active.remaining -= 1;
    if (active.remaining <= 0) scenarios[endpoint] = { ...DEFAULT_SCENARIO };
  }
  return result;
}

async function applyDelay(milliseconds) {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function providerError(response, status, code, message) {
  sendJson(response, status, {
    error: { type: "openai_fake_error", code, message },
  });
}

async function respondForScenario(response, scenario, endpoint, parsedJson) {
  await applyDelay(scenario.delayMs);

  if (scenario.name === "rate_limited") {
    return providerError(
      response,
      429,
      "rate_limit_exceeded",
      "Deterministic rate limit from local OpenAI fake.",
    );
  }
  if (scenario.name === "provider_error") {
    return providerError(
      response,
      500,
      "provider_error",
      "Deterministic provider failure from local OpenAI fake.",
    );
  }
  if (scenario.name === "malformed_json") {
    return sendText(
      response,
      200,
      "application/json; charset=utf-8",
      "{malformed-json",
    );
  }
  if (scenario.name === "custom") {
    return sendJson(
      response,
      scenario.status ?? 200,
      scenario.responseBody ?? {},
    );
  }
  if (scenario.name === "empty") {
    return sendJson(
      response,
      200,
      endpoint === "responses" ? { output: [], output_text: "" } : { text: "" },
    );
  }

  if (endpoint === "transcriptions") {
    return sendJson(response, 200, {
      text: scenario.transcriptionText,
      usage: { type: "tokens", total_tokens: 1 },
    });
  }

  const outputText = structuredOutput(parsedJson) ?? scenario.outputText;
  const responsePayload = {
    id: `resp_${randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: boundedString(parsedJson?.model, 100) ?? "openai-fake",
    output_text: outputText,
    output: [
      {
        id: `msg_${randomUUID().replaceAll("-", "")}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: outputText, annotations: [] }],
      },
    ],
  };
  if (
    Array.isArray(parsedJson?.modalities) &&
    parsedJson.modalities.includes("audio")
  ) {
    responsePayload.output_audio = {
      data: Buffer.from("ID3 deterministic e2e audio", "utf8").toString(
        "base64",
      ),
      transcript: scenario.outputText,
    };
  }
  return sendJson(response, 200, responsePayload);
}

function publicScenario(scenario) {
  return {
    name: scenario.name,
    delayMs: scenario.delayMs,
    remaining: scenario.remaining,
    status: scenario.status,
    customBodyConfigured: scenario.responseBody !== null,
  };
}

function validateScenario(payload) {
  if (!isRecord(payload)) return { error: "scenario_body_required" };
  const endpoints =
    payload.endpoint === "all"
      ? ["responses", "transcriptions"]
      : [payload.endpoint];
  if (
    endpoints.some(
      (endpoint) => endpoint !== "responses" && endpoint !== "transcriptions",
    )
  ) {
    return { error: "invalid_endpoint" };
  }
  const allowed = [
    "success",
    "rate_limited",
    "provider_error",
    "malformed_json",
    "empty",
    "timeout",
    "custom",
  ];
  if (!allowed.includes(payload.scenario)) return { error: "invalid_scenario" };

  const requestedDelay =
    payload.scenario === "timeout" && payload.delayMs === undefined
      ? 30_000
      : Number(payload.delayMs ?? 0);
  if (
    !Number.isInteger(requestedDelay) ||
    requestedDelay < 0 ||
    requestedDelay > MAX_SCENARIO_DELAY_MS
  ) {
    return { error: "invalid_delay" };
  }
  const remaining =
    payload.repeat === "persistent" ? null : Number(payload.repeat ?? 1);
  if (
    remaining !== null &&
    (!Number.isInteger(remaining) || remaining < 1 || remaining > 1_000)
  ) {
    return { error: "invalid_repeat" };
  }
  const status = payload.status === undefined ? null : Number(payload.status);
  if (
    status !== null &&
    (!Number.isInteger(status) || status < 100 || status > 599)
  ) {
    return { error: "invalid_status" };
  }
  if (payload.scenario === "custom" && payload.responseBody === undefined) {
    return { error: "custom_response_body_required" };
  }

  return {
    endpoints,
    scenario: {
      name: payload.scenario,
      delayMs: requestedDelay,
      remaining,
      status,
      responseBody: payload.responseBody ?? null,
      outputText:
        boundedString(payload.outputText, 2_000) ?? DEFAULT_SCENARIO.outputText,
      transcriptionText:
        boundedString(payload.transcriptionText, 2_000) ??
        DEFAULT_SCENARIO.transcriptionText,
    },
  };
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://openai-fake.local");

  if (request.method === "GET" && url.pathname === "/healthz") {
    return sendJson(response, 200, { ok: true, service: "openai-fake" });
  }
  if (request.method === "GET" && url.pathname === "/__control/requests") {
    return sendJson(response, 200, {
      requests: capturedRequests,
      retained: capturedRequests.length,
      limit: MAX_CAPTURED_REQUESTS,
    });
  }
  if (request.method === "GET" && url.pathname === "/__control/scenario") {
    return sendJson(response, 200, {
      responses: publicScenario(scenarios.responses),
      transcriptions: publicScenario(scenarios.transcriptions),
    });
  }
  if (request.method === "POST" && url.pathname === "/__control/reset") {
    capturedRequests.length = 0;
    scenarios.responses = { ...DEFAULT_SCENARIO };
    scenarios.transcriptions = { ...DEFAULT_SCENARIO };
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "PUT" && url.pathname === "/__control/scenario") {
    let body;
    try {
      body = await readBody(request, MAX_CONTROL_BODY_BYTES);
    } catch {
      return sendJson(response, 413, { error: "control_body_too_large" });
    }
    const validation = validateScenario(parseJson(body));
    if (validation.error) return sendJson(response, 422, validation);
    for (const endpoint of validation.endpoints) {
      scenarios[endpoint] = { ...validation.scenario };
    }
    return sendJson(response, 200, {
      ok: true,
      endpoints: validation.endpoints,
      scenario: publicScenario(validation.scenario),
    });
  }

  const endpoint =
    url.pathname === "/v1/responses"
      ? "responses"
      : url.pathname === "/v1/audio/transcriptions"
        ? "transcriptions"
        : null;
  if (request.method !== "POST" || !endpoint) {
    return sendJson(response, 404, { error: "not_found" });
  }

  let body;
  try {
    body = await readBody(request, MAX_PROVIDER_BODY_BYTES);
  } catch {
    return sendJson(response, 413, { error: "request_body_too_large" });
  }
  const contentType = request.headers["content-type"] ?? "";
  const parsedJson = contentType.toLowerCase().includes("application/json")
    ? parseJson(body)
    : null;
  const capture = captureMetadata(request, endpoint, body, parsedJson);
  const scenario = currentScenario(endpoint);
  console.info("[openai-fake] request", {
    id: capture.id,
    endpoint: capture.endpoint,
    bodyBytes: capture.bodyBytes,
    scenario: scenario.name,
  });
  return respondForScenario(response, scenario, endpoint, parsedJson);
}

const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    console.error("[openai-fake] internal_error", {
      name: error instanceof Error ? error.name : "unknown",
      code:
        typeof error?.code === "string"
          ? error.code.slice(0, 80)
          : "unclassified",
    });
    if (!response.headersSent) {
      sendJson(response, 500, { error: "openai_fake_internal_error" });
    } else {
      response.destroy();
    }
  });
});

server.listen(port, host, () => {
  console.info(`[openai-fake] listening on ${host}:${port}`);
});

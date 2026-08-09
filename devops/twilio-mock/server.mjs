import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";

const port = Number(process.env["PORT"] ?? 4010);
const host = process.env["HOST"] === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
const MAX_CAPTURED_REQUESTS = 100;
const MAX_PROVIDER_RECORDS = 200;
const MAX_REQUEST_BYTES = 1_000_000;
const OVERSIZED_JSON_BYTES = 1_000_001;
const OVERSIZED_AUDIO_BYTES = 25 * 1024 * 1024 + 1;
const SYNTHETIC_CALL_SID = `CA${"1".repeat(32)}`;
const SYNTHETIC_RECORDING_SID = `RE${"2".repeat(32)}`;
const VALID_SCENARIOS = new Set([
  "success",
  "rate_limited",
  "provider_error",
  "invalid_request",
  "malformed_json",
  "empty_success",
  "not_found",
  "oversized_json",
  "oversized_audio",
  "timeout",
]);

const messages = [];
const calls = [];
const capturedRequests = [];
let scenario = { name: "success", repeat: null, delayMs: 250 };
let recordingAvailable = false;

function generateSid(prefix) {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

function boundedUnshift(target, value, maximum) {
  target.unshift(value);
  if (target.length > maximum) target.length = maximum;
}

function safeHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("request_too_large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseForm(body) {
  return Object.fromEntries(new URLSearchParams(body).entries());
}

function json(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(status === 204 ? undefined : JSON.stringify(payload));
}

function text(response, status, payload) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(payload);
}

function currentScenario() {
  const selected = { name: scenario.name, delayMs: scenario.delayMs };
  if (typeof scenario.repeat === "number") {
    scenario.repeat -= 1;
    if (scenario.repeat <= 0) {
      scenario = { name: "success", repeat: null, delayMs: 250 };
    }
  }
  return selected;
}

async function applyScenario(request, response, successStatus) {
  const selected = currentScenario();
  switch (selected.name) {
    case "success":
      return false;
    case "rate_limited":
      json(
        response,
        429,
        {
          code: 20429,
          message: "Too many requests for the deterministic Twilio fake.",
          more_info: "https://www.twilio.com/docs/errors/20429",
          status: 429,
        },
        { "Retry-After": "1" },
      );
      return true;
    case "provider_error":
      json(response, 503, {
        code: 20500,
        message: "Deterministic provider failure.",
        status: 503,
      });
      return true;
    case "invalid_request":
      json(response, 400, {
        code: 21211,
        message: "The 'To' phone number is not valid.",
        status: 400,
      });
      return true;
    case "malformed_json":
      text(response, successStatus, "{malformed-json");
      return true;
    case "empty_success":
      json(response, successStatus, {});
      return true;
    case "not_found":
      json(response, 404, { code: 20404, status: 404 });
      return true;
    case "oversized_json":
      json(response, successStatus, {
        padding: "x".repeat(OVERSIZED_JSON_BYTES),
      });
      return true;
    case "oversized_audio":
      response.writeHead(successStatus, {
        "Cache-Control": "no-store",
        "Content-Length": String(OVERSIZED_AUDIO_BYTES),
        "Content-Type": "audio/wav",
      });
      response.end(Buffer.from("synthetic-oversized-audio-marker", "utf8"));
      return true;
    case "timeout":
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, selected.delayMs),
      );
      request.socket.destroy();
      return true;
    default:
      json(response, 500, { error: "unknown_scenario" });
      return true;
  }
}

function operationFor(pathname, method) {
  if (/\/Messages\.json$/u.test(pathname)) return "messages.create";
  if (/\/Calls\.json$/u.test(pathname)) return "calls.create";
  if (/\/Calls\/[^/]+\/Recordings\.json$/u.test(pathname)) {
    return "recordings.list";
  }
  if (/\/Recordings\/[^/]+\.(?:wav|mp3)$/u.test(pathname)) {
    return "recordings.download";
  }
  if (method === "DELETE" && /\/Recordings\/[^/]+\.json$/u.test(pathname)) {
    return "recordings.delete";
  }
  return null;
}

function captureProviderRequest(request, url, operation, form, rawBody) {
  const accountSid = url.pathname.split("/")[3] ?? null;
  boundedUnshift(
    capturedRequests,
    {
      id: generateSid("RQ"),
      at: new Date().toISOString(),
      method: request.method,
      operation,
      scenario: scenario.name,
      accountSidHash: accountSid ? safeHash(accountSid) : null,
      authorization:
        typeof request.headers.authorization === "string" &&
        request.headers.authorization.startsWith("Basic ")
          ? "basic"
          : "missing",
      contentType: request.headers["content-type"] ?? null,
      bodyBytes: Buffer.byteLength(rawBody),
      bodyHash: rawBody ? safeHash(rawBody) : null,
      toHash: form?.To ? safeHash(form.To) : null,
      fromHash: form?.From ? safeHash(form.From) : null,
      messageLength: form?.Body?.length ?? 0,
      mediaCount: new URLSearchParams(rawBody).getAll("MediaUrl").length,
    },
    MAX_CAPTURED_REQUESTS,
  );
}

async function readJsonControl(request) {
  const body = await readBody(request);
  if (!body) return {};
  return JSON.parse(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://twilio-fake.local");

  if (request.method === "GET" && url.pathname === "/healthz") {
    return json(response, 200, { ok: true, provider: "twilio-fake" });
  }

  if (request.method === "GET" && url.pathname === "/__control/state") {
    return json(response, 200, {
      scenario,
      retainedCaptures: capturedRequests.length,
      retainedMessages: messages.length,
      retainedCalls: calls.length,
      retainedRecordings: recordingAvailable ? 1 : 0,
      limits: {
        captures: MAX_CAPTURED_REQUESTS,
        providerRecords: MAX_PROVIDER_RECORDS,
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/__control/requests") {
    return json(response, 200, {
      requests: capturedRequests,
      retained: capturedRequests.length,
      limit: MAX_CAPTURED_REQUESTS,
    });
  }

  if (request.method === "POST" && url.pathname === "/__control/reset") {
    messages.length = 0;
    calls.length = 0;
    capturedRequests.length = 0;
    recordingAvailable = false;
    scenario = { name: "success", repeat: null, delayMs: 250 };
    return json(response, 200, { ok: true });
  }

  if (
    (request.method === "PUT" || request.method === "POST") &&
    url.pathname === "/__control/scenario"
  ) {
    try {
      const payload = await readJsonControl(request);
      const name = typeof payload.name === "string" ? payload.name : "";
      const repeat =
        payload.repeat === undefined || payload.repeat === null
          ? null
          : Number(payload.repeat);
      const delayMs =
        payload.delayMs === undefined ? 250 : Number(payload.delayMs);
      if (
        !VALID_SCENARIOS.has(name) ||
        (repeat !== null &&
          (!Number.isInteger(repeat) || repeat < 1 || repeat > 100)) ||
        !Number.isInteger(delayMs) ||
        delayMs < 1 ||
        delayMs > 30_000
      ) {
        return json(response, 422, { error: "invalid_scenario" });
      }
      scenario = { name, repeat, delayMs };
      return json(response, 200, { ok: true, scenario });
    } catch {
      return json(response, 400, { error: "invalid_json" });
    }
  }

  if (
    request.method === "POST" &&
    url.pathname === "/__control/recordings/seed"
  ) {
    recordingAvailable = true;
    return json(response, 200, {
      ok: true,
      callSid: SYNTHETIC_CALL_SID,
      recordingSid: SYNTHETIC_RECORDING_SID,
    });
  }

  if (request.method === "GET" && url.pathname === "/messages") {
    return json(response, 200, { messages });
  }
  if (request.method === "DELETE" && url.pathname === "/messages") {
    messages.length = 0;
    return json(response, 204, {});
  }
  if (request.method === "GET" && url.pathname === "/calls") {
    return json(response, 200, { calls });
  }

  const operation = operationFor(url.pathname, request.method ?? "GET");
  if (!operation) {
    return json(response, 404, { error: "not_found" });
  }

  let rawBody = "";
  let form = null;
  try {
    if (request.method === "POST") {
      rawBody = await readBody(request);
      if (
        !String(request.headers["content-type"] ?? "").includes(
          "application/x-www-form-urlencoded",
        )
      ) {
        return json(response, 415, { error: "unsupported_content_type" });
      }
      form = parseForm(rawBody);
    }
  } catch (error) {
    return json(response, 413, {
      error: error instanceof Error ? error.message : "invalid_body",
    });
  }

  captureProviderRequest(request, url, operation, form, rawBody);
  const creation = operation.endsWith(".create");
  if (await applyScenario(request, response, creation ? 201 : 200)) return;

  const accountSid =
    url.pathname.split("/")[3] ?? "AC00000000000000000000000000000000";
  if (operation === "messages.create") {
    const sid = generateSid("SM");
    const record = {
      sid,
      account_sid: accountSid,
      to: form?.To ?? null,
      from: form?.From ?? null,
      body: form?.Body ?? "",
      status: "queued",
      direction: "outbound-api",
      date_created: new Date().toISOString(),
      uri: `/2010-04-01/Accounts/${accountSid}/Messages/${sid}.json`,
    };
    boundedUnshift(messages, record, MAX_PROVIDER_RECORDS);
    console.info("[twilio-fake] messages.create", { status: "queued" });
    return json(response, 201, record);
  }

  if (operation === "calls.create") {
    const sid = generateSid("CA");
    const record = {
      sid,
      account_sid: accountSid,
      to: form?.To ?? null,
      from: form?.From ?? null,
      status: "queued",
      direction: "outbound-api",
      date_created: new Date().toISOString(),
      uri: `/2010-04-01/Accounts/${accountSid}/Calls/${sid}.json`,
    };
    boundedUnshift(
      calls,
      {
        accountSidHash: safeHash(accountSid),
        toHash: form?.To ? safeHash(form.To) : null,
        fromHash: form?.From ? safeHash(form.From) : null,
        status: record.status,
        direction: record.direction,
        date_created: record.date_created,
      },
      MAX_PROVIDER_RECORDS,
    );
    console.info("[twilio-fake] calls.create", { status: "queued" });
    return json(response, 201, record);
  }

  if (operation === "recordings.list") {
    const callSid = url.pathname.match(
      /\/Calls\/([^/]+)\/Recordings\.json$/u,
    )?.[1];
    return json(response, 200, {
      recordings:
        recordingAvailable && callSid === SYNTHETIC_CALL_SID
          ? [
              {
                sid: SYNTHETIC_RECORDING_SID,
                duration: "42",
                date_created: "Sat, 08 Aug 2026 12:00:00 +0000",
              },
            ]
          : [],
      next_page_uri: null,
    });
  }
  if (operation === "recordings.delete") {
    const recordingSid = url.pathname.match(
      /\/Recordings\/([^/]+)\.json$/u,
    )?.[1];
    if (!recordingAvailable || recordingSid !== SYNTHETIC_RECORDING_SID) {
      return json(response, 404, { code: 20404, status: 404 });
    }
    recordingAvailable = false;
    return json(response, 204, {});
  }
  if (operation === "recordings.download") {
    const match = url.pathname.match(/\/Recordings\/([^/.]+)\.(wav|mp3)$/u);
    if (!recordingAvailable || match?.[1] !== SYNTHETIC_RECORDING_SID) {
      return json(response, 404, { code: 20404, status: 404 });
    }
    const format = match[2];
    const payload = Buffer.from(
      "synthetic-audio-without-customer-data",
      "utf8",
    );
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": String(payload.byteLength),
      "Content-Type": format === "mp3" ? "audio/mpeg" : "audio/wav",
    });
    response.end(payload);
    return;
  }
  return json(response, 404, { error: "recording_not_found" });
});

server.listen(port, host, () => {
  console.log(`[twilio-fake] listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

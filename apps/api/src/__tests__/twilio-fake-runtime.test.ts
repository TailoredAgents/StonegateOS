import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { sendSmsMessage as SendSmsMessage } from "@/lib/messaging";
import type { createTwilioOutboundCall as CreateTwilioOutboundCall } from "@/lib/twilio-calls";
import type {
  deleteTwilioRecording as DeleteTwilioRecording,
  downloadTwilioRecordingAudio as DownloadTwilioRecordingAudio,
  listTwilioRecordingsForCall as ListTwilioRecordingsForCall,
} from "@/lib/twilio-recordings";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const port = 44_200 + (process.pid % 1_000);
const origin = `http://127.0.0.1:${port}`;
const accountSid = "AC00000000000000000000000000000000";
let server: ReturnType<typeof spawn>;
let stderr = "";
let stdout = "";
let sendSmsMessage: typeof SendSmsMessage;
let createTwilioOutboundCall: typeof CreateTwilioOutboundCall;
let listTwilioRecordingsForCall: typeof ListTwilioRecordingsForCall;
let downloadTwilioRecordingAudio: typeof DownloadTwilioRecordingAudio;
let deleteTwilioRecording: typeof DeleteTwilioRecording;
const twilioEnvironment = {
  accountSid: process.env["TWILIO_ACCOUNT_SID"],
  authToken: process.env["TWILIO_AUTH_TOKEN"],
  from: process.env["TWILIO_FROM"],
  baseUrl: process.env["TWILIO_API_BASE_URL"],
  webhookBaseUrl: process.env["TWILIO_WEBHOOK_PUBLIC_BASE_URL"],
  e2eRunId: process.env["E2E_RUN_ID"],
  auditMode: process.env["TEAM_CRM_AUDIT_MODE"],
  externalSendsKill: process.env["TEAM_KILL_EXTERNAL_SENDS"],
};

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Twilio fake exited early: ${stderr}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // The process may still be binding its loopback socket.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Twilio fake did not become ready: ${stderr}`);
}

async function setScenario(
  payload: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${origin}/__control/scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function createMessage(
  body = "Synthetic audit message",
): Promise<Response> {
  return fetch(`${origin}/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic private-auth-value",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: "+15555550199",
      From: "+15555550123",
      Body: body,
    }),
  });
}

async function seedRecording(): Promise<{
  callSid: string;
  recordingSid: string;
}> {
  const response = await fetch(`${origin}/__control/recordings/seed`, {
    method: "POST",
  });
  expect(response.status).toBe(200);
  const payload = await jsonRecord(response);
  if (
    typeof payload["callSid"] !== "string" ||
    typeof payload["recordingSid"] !== "string"
  ) {
    throw new Error("recording_seed_invalid");
  }
  return {
    callSid: payload["callSid"],
    recordingSid: payload["recordingSid"],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function jsonRecord(
  response: Response,
): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("fake_response_not_an_object");
  return payload;
}

beforeAll(async () => {
  server = spawn(
    process.execPath,
    [resolve(REPOSITORY_ROOT, "devops/twilio-mock/server.mjs")],
    {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-20_000);
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
  });
  await waitUntilReady();
  process.env["TWILIO_ACCOUNT_SID"] = accountSid;
  process.env["TWILIO_AUTH_TOKEN"] = "twilio-test-token";
  process.env["TWILIO_FROM"] = "+15555550123";
  process.env["TWILIO_API_BASE_URL"] = origin;
  process.env["TWILIO_WEBHOOK_PUBLIC_BASE_URL"] = "http://127.0.0.1:3001";
  // A nonproduction provider override is intentionally inert unless the
  // process declares itself to be an isolated provider-test runtime.
  process.env["E2E_RUN_ID"] = `twilio-fake-${process.pid}`;
  process.env["TEAM_CRM_AUDIT_MODE"] = "1";
  delete process.env["TEAM_KILL_EXTERNAL_SENDS"];
  ({ sendSmsMessage } = await import("@/lib/messaging"));
  ({ createTwilioOutboundCall } = await import("@/lib/twilio-calls"));
  ({
    listTwilioRecordingsForCall,
    downloadTwilioRecordingAudio,
    deleteTwilioRecording,
  } = await import("@/lib/twilio-recordings"));
}, 10_000);

afterAll(async () => {
  for (const [name, value] of Object.entries({
    TWILIO_ACCOUNT_SID: twilioEnvironment.accountSid,
    TWILIO_AUTH_TOKEN: twilioEnvironment.authToken,
    TWILIO_FROM: twilioEnvironment.from,
    TWILIO_API_BASE_URL: twilioEnvironment.baseUrl,
    TWILIO_WEBHOOK_PUBLIC_BASE_URL: twilioEnvironment.webhookBaseUrl,
    E2E_RUN_ID: twilioEnvironment.e2eRunId,
    TEAM_CRM_AUDIT_MODE: twilioEnvironment.auditMode,
    TEAM_KILL_EXTERNAL_SENDS: twilioEnvironment.externalSendsKill,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (!server || server.exitCode !== null) return;
  await new Promise<void>((resolveExit) => {
    server.once("exit", () => resolveExit());
    server.kill("SIGTERM");
    setTimeout(resolveExit, 1_000).unref();
  });
});

beforeEach(async () => {
  const response = await fetch(`${origin}/__control/reset`, { method: "POST" });
  expect(response.ok).toBe(true);
  stdout = "";
});

describe("local Twilio fake runtime", () => {
  it("supports SMS and call creation without retaining secrets or message content in captures or logs", async () => {
    const privateMessage = "private-customer-marker-must-not-leak";
    const messageResponse = await createMessage(privateMessage);
    expect(messageResponse.status).toBe(201);
    const messagePayload = await jsonRecord(messageResponse);
    expect(messagePayload["sid"]).toMatch(/^SM/u);
    expect(messagePayload["status"]).toBe("queued");

    const callResponse = await fetch(
      `${origin}/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic another-private-auth-value",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: "+15555550198",
          From: "+15555550123",
          Url: "http://127.0.0.1:3001/api/webhooks/twilio/connect",
        }),
      },
    );
    expect(callResponse.status).toBe(201);
    const callPayload = await jsonRecord(callResponse);
    expect(callPayload["sid"]).toMatch(/^CA/u);
    expect(callPayload["status"]).toBe("queued");

    const captures = await fetch(`${origin}/__control/requests`).then(
      (response) =>
        response.json() as Promise<{
          requests: Array<Record<string, unknown>>;
        }>,
    );
    expect(captures.requests).toHaveLength(2);
    expect(captures.requests[0]).toMatchObject({
      authorization: "basic",
      operation: "calls.create",
    });
    expect(captures.requests[0]?.["accountSidHash"]).toMatch(/^[0-9a-f]{16}$/u);
    expect(captures.requests[0]?.["toHash"]).toMatch(/^[0-9a-f]{16}$/u);
    expect(captures.requests[0]?.["fromHash"]).toMatch(/^[0-9a-f]{16}$/u);
    expect(captures.requests[1]).toMatchObject({
      authorization: "basic",
      operation: "messages.create",
      messageLength: privateMessage.length,
    });
    const serialized = JSON.stringify(captures);
    expect(serialized).not.toContain(privateMessage);
    expect(serialized).not.toContain("private-auth-value");
    expect(serialized).not.toContain("toSuffix");
    expect(serialized).not.toContain("fromSuffix");
    expect(stdout).not.toContain(privateMessage);
    expect(stdout).not.toContain("private-auth-value");

    const retainedCalls = await fetch(`${origin}/calls`).then(
      (response) =>
        response.json() as Promise<{
          calls: Array<Record<string, unknown>>;
        }>,
    );
    expect(retainedCalls.calls[0]?.["accountSidHash"]).toMatch(
      /^[0-9a-f]{16}$/u,
    );
    expect(retainedCalls.calls[0]?.["toHash"]).toMatch(/^[0-9a-f]{16}$/u);
    expect(retainedCalls.calls[0]?.["fromHash"]).toMatch(/^[0-9a-f]{16}$/u);
    expect(retainedCalls.calls[0]).not.toHaveProperty("account_sid");
    expect(retainedCalls.calls[0]).not.toHaveProperty("sid");
    expect(retainedCalls.calls[0]).not.toHaveProperty("to");
    expect(retainedCalls.calls[0]).not.toHaveProperty("from");
  });

  it("supports deterministic one-shot rate limits, provider failures, malformed success, and recovery", async () => {
    expect(
      (await setScenario({ name: "rate_limited", repeat: 1 })).status,
    ).toBe(200);
    const rateLimited = await createMessage();
    expect(rateLimited.status).toBe(429);
    expect(await rateLimited.json()).toMatchObject({ code: 20429 });

    expect((await createMessage()).status).toBe(201);

    await setScenario({ name: "provider_error" });
    const providerFailure = await createMessage();
    expect(providerFailure.status).toBe(503);
    expect(await providerFailure.json()).toMatchObject({ code: 20500 });

    await setScenario({ name: "malformed_json", repeat: 1 });
    const malformed = await createMessage();
    expect(malformed.status).toBe(201);
    expect(await malformed.text()).toBe("{malformed-json");
    expect((await createMessage()).status).toBe(201);
  });

  it("drives the production SMS adapter through truthful certainty outcomes", async () => {
    const accepted = await sendSmsMessage(
      "+15555550199",
      "Production adapter synthetic message",
    );
    expect(accepted).toMatchObject({
      ok: true,
      provider: "twilio",
      deliveryCertainty: "accepted",
    });
    expect(accepted.providerMessageId).toMatch(/^SM[0-9a-f]{32}$/iu);

    await setScenario({ name: "rate_limited", repeat: 1 });
    await expect(
      sendSmsMessage("+15555550199", "rate limit"),
    ).resolves.toMatchObject({
      ok: false,
      deliveryCertainty: "not_sent",
      detail: "sms_failed:429",
    });

    await setScenario({ name: "provider_error", repeat: 1 });
    await expect(
      sendSmsMessage("+15555550199", "provider error"),
    ).resolves.toMatchObject({
      ok: false,
      deliveryCertainty: "uncertain",
      detail: "sms_failed:503",
    });

    await setScenario({ name: "empty_success", repeat: 1 });
    await expect(
      sendSmsMessage("+15555550199", "missing SID"),
    ).resolves.toMatchObject({
      ok: false,
      deliveryCertainty: "uncertain",
      detail: "sms_response_invalid",
    });

    await setScenario({ name: "timeout", repeat: 1, delayMs: 10 });
    await expect(
      sendSmsMessage("+15555550199", "transport timeout"),
    ).resolves.toMatchObject({
      ok: false,
      deliveryCertainty: "uncertain",
      detail: "sms_transport_error",
    });
  });

  it("drives the production call adapter through accepted and uncertain outcomes", async () => {
    const callInput = {
      to: "+15555550198",
      requestUrl:
        "http://127.0.0.1:3001/api/webhooks/twilio/connect?requestKey=11111111-1111-4111-8111-111111111111",
      statusCallbackUrl:
        "http://127.0.0.1:3001/api/webhooks/twilio/call-status?leg=agent&requestKey=11111111-1111-4111-8111-111111111111",
    };
    const acceptedCall = await createTwilioOutboundCall(callInput);
    expect(acceptedCall).toMatchObject({
      ok: true,
      deliveryCertainty: "accepted",
    });
    expect(acceptedCall.callSid).toMatch(/^CA[0-9a-f]{32}$/iu);

    await setScenario({ name: "empty_success", repeat: 1 });
    await expect(createTwilioOutboundCall(callInput)).resolves.toMatchObject({
      ok: false,
      deliveryCertainty: "uncertain",
      detail: "twilio_call_response_invalid",
    });

    await setScenario({ name: "provider_error", repeat: 1 });
    await expect(createTwilioOutboundCall(callInput)).resolves.toMatchObject({
      ok: false,
      deliveryCertainty: "uncertain",
      detail: "twilio_call_failed:503",
    });

    await setScenario({ name: "timeout", repeat: 1, delayMs: 10 });
    await expect(createTwilioOutboundCall(callInput)).resolves.toMatchObject({
      ok: false,
      deliveryCertainty: "uncertain",
      detail: "twilio_call_transport_error",
    });
  });

  it("distinguishes a real empty recording list and exercises list, download, and idempotent delete", async () => {
    const synthetic = await seedRecording();

    await expect(
      listTwilioRecordingsForCall(`CA${"9".repeat(32)}`),
    ).resolves.toEqual({ ok: true, recordings: [], empty: true });
    const listed = await listTwilioRecordingsForCall(synthetic.callSid);
    expect(listed).toMatchObject({ ok: true, empty: false });
    if (!listed.ok) throw new Error("recording_list_failed");
    expect(listed.recordings).toEqual([
      {
        sid: synthetic.recordingSid,
        durationSec: 42,
        dateCreated: "2026-08-08T12:00:00.000Z",
      },
    ]);

    const downloaded = await downloadTwilioRecordingAudio(
      synthetic.recordingSid,
    );
    expect(downloaded).toMatchObject({
      ok: true,
      contentType: "audio/wav",
      filename: "call.wav",
    });
    if (!downloaded.ok) throw new Error("recording_download_failed");
    expect(downloaded.buffer.toString("utf8")).toBe(
      "synthetic-audio-without-customer-data",
    );

    await expect(
      deleteTwilioRecording(synthetic.recordingSid),
    ).resolves.toEqual({
      ok: true,
      deleted: true,
      alreadyAbsent: false,
      status: 204,
    });
    await expect(
      deleteTwilioRecording(synthetic.recordingSid),
    ).resolves.toEqual({
      ok: true,
      deleted: false,
      alreadyAbsent: true,
      status: 404,
    });

    const captures = await fetch(`${origin}/__control/requests`).then(
      (response) =>
        response.json() as Promise<{
          requests: Array<Record<string, unknown>>;
        }>,
    );
    expect(captures.requests.map((request) => request["operation"])).toEqual(
      expect.arrayContaining([
        "recordings.list",
        "recordings.download",
        "recordings.delete",
      ]),
    );
    expect(JSON.stringify(captures)).not.toContain(synthetic.callSid);
    expect(JSON.stringify(captures)).not.toContain(synthetic.recordingSid);
    expect(stdout).not.toContain(synthetic.callSid);
    expect(stdout).not.toContain(synthetic.recordingSid);
  });

  it("keeps recording provider, malformed, oversized, and transport failures distinct from empty/success", async () => {
    const synthetic = await seedRecording();

    await setScenario({ name: "malformed_json", repeat: 1 });
    await expect(
      listTwilioRecordingsForCall(synthetic.callSid),
    ).resolves.toMatchObject({ ok: false, code: "malformed_response" });

    await setScenario({ name: "oversized_json", repeat: 1 });
    await expect(
      listTwilioRecordingsForCall(synthetic.callSid),
    ).resolves.toMatchObject({ ok: false, code: "response_too_large" });

    await setScenario({ name: "rate_limited", repeat: 1 });
    await expect(
      listTwilioRecordingsForCall(synthetic.callSid),
    ).resolves.toMatchObject({
      ok: false,
      code: "rate_limited",
      retryable: true,
    });

    await setScenario({ name: "oversized_audio", repeat: 1 });
    await expect(
      downloadTwilioRecordingAudio(synthetic.recordingSid),
    ).resolves.toMatchObject({ ok: false, code: "response_too_large" });

    await setScenario({ name: "provider_error", repeat: 1 });
    await expect(
      deleteTwilioRecording(synthetic.recordingSid),
    ).resolves.toMatchObject({
      ok: false,
      code: "provider_failed",
      certainty: "uncertain",
    });

    await setScenario({ name: "timeout", repeat: 1, delayMs: 10 });
    await expect(
      deleteTwilioRecording(synthetic.recordingSid),
    ).resolves.toMatchObject({
      ok: false,
      code: "transport_error",
      certainty: "uncertain",
    });
  });

  it("can simulate a transport timeout and validates control inputs", async () => {
    expect(
      (await setScenario({ name: "timeout", repeat: 1, delayMs: 10 })).status,
    ).toBe(200);
    await expect(createMessage()).rejects.toThrow();
    expect((await createMessage()).status).toBe(201);

    const invalid = await setScenario({ name: "not-a-scenario" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: "invalid_scenario" });
  });

  it("bounds retained metadata and reset clears provider and control state", async () => {
    for (let batch = 0; batch < 11; batch += 1) {
      await Promise.all(
        Array.from({ length: 10 }, () => createMessage("bounded synthetic")),
      );
    }

    const beforeReset = await fetch(`${origin}/__control/requests`).then(
      (response) =>
        response.json() as Promise<{
          requests: unknown[];
          retained: number;
          limit: number;
        }>,
    );
    expect(beforeReset.limit).toBe(100);
    expect(beforeReset.retained).toBe(100);
    expect(beforeReset.requests).toHaveLength(100);

    await fetch(`${origin}/__control/reset`, { method: "POST" });
    const afterReset = await fetch(`${origin}/__control/state`).then(
      (response) =>
        response.json() as Promise<{
          retainedCaptures: number;
          retainedMessages: number;
          retainedCalls: number;
          scenario: { name: string };
        }>,
    );
    expect(afterReset).toMatchObject({
      retainedCaptures: 0,
      retainedMessages: 0,
      retainedCalls: 0,
      scenario: { name: "success" },
    });
  });
});

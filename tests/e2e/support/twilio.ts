import { createHmac } from "node:crypto";
import { getOptionalEnvVar } from "./env";

const twilioBase = (
  getOptionalEnvVar("TWILIO_API_BASE_URL", "http://localhost:4010") ??
  "http://localhost:4010"
).replace(/\/$/, "");
const twilioControlBase = (
  getOptionalEnvVar("TWILIO_FAKE_CONTROL_URL", twilioBase) ?? twilioBase
).replace(/\/$/, "");

export function signTwilioWebhookRequest(input: {
  externalUrl: string;
  form?: URLSearchParams;
  authToken?: string;
}): string {
  const authToken = input.authToken ?? getOptionalEnvVar("TWILIO_AUTH_TOKEN");
  if (!authToken) {
    throw new Error("TWILIO_AUTH_TOKEN is required to sign a webhook fixture.");
  }
  const form = input.form ?? new URLSearchParams();
  const names = new Set<string>();
  form.forEach((_value, name) => names.add(name));
  const data = [...names].sort().reduce((result, name) => {
    const values = [...new Set(form.getAll(name))].sort();
    return `${result}${values.map((value) => `${name}${value}`).join("")}`;
  }, input.externalUrl);
  return createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf8"))
    .digest("base64");
}

export type TwilioFakeScenario =
  | "success"
  | "rate_limited"
  | "provider_error"
  | "invalid_request"
  | "malformed_json"
  | "empty_success"
  | "not_found"
  | "oversized_json"
  | "oversized_audio"
  | "timeout";

type TwilioMessage = {
  sid: string;
  to: string;
  from: string;
  body: string;
  status: string;
  date_created: string;
};

export async function fetchTwilioMessages(): Promise<TwilioMessage[]> {
  const response = await fetch(`${twilioBase}/messages`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Twilio mock messages (${response.status})`,
    );
  }
  const payload = (await response.json()) as { messages: TwilioMessage[] };
  return payload.messages ?? [];
}

export async function clearTwilioMessages(): Promise<void> {
  const response = await fetch(`${twilioControlBase}/__control/reset`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to reset Twilio fake (${response.status})`);
  }
}

export async function setTwilioFakeScenario(
  name: TwilioFakeScenario,
  options: { repeat?: number; delayMs?: number } = {},
): Promise<void> {
  const response = await fetch(`${twilioControlBase}/__control/scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...options }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to configure Twilio fake scenario (${response.status})`,
    );
  }
}

export async function fetchTwilioFakeRequests(): Promise<
  Array<Record<string, unknown>>
> {
  const response = await fetch(`${twilioControlBase}/__control/requests`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Twilio fake evidence (${response.status})`,
    );
  }
  const payload = (await response.json()) as {
    requests?: Array<Record<string, unknown>>;
  };
  return payload.requests ?? [];
}

export async function seedTwilioFakeRecording(): Promise<{
  callSid: string;
  recordingSid: string;
}> {
  const response = await fetch(
    `${twilioControlBase}/__control/recordings/seed`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to seed Twilio recording fixture (${response.status})`,
    );
  }
  const payload = (await response.json()) as {
    callSid?: unknown;
    recordingSid?: unknown;
  };
  if (
    typeof payload.callSid !== "string" ||
    typeof payload.recordingSid !== "string"
  ) {
    throw new Error("Twilio recording fixture returned malformed identifiers");
  }
  return { callSid: payload.callSid, recordingSid: payload.recordingSid };
}

export async function waitForTwilioMessage(
  matcher: (message: TwilioMessage) => boolean,
  {
    timeoutMs = 15_000,
    intervalMs = 500,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<TwilioMessage> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const messages = await fetchTwilioMessages();
    const match = messages.find(matcher);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for Twilio message");
}

import { getOptionalEnvVar } from "./env";

const emailControlBase = (
  getOptionalEnvVar("EMAIL_FAKE_CONTROL_URL", "http://127.0.0.1:4016") ??
  "http://127.0.0.1:4016"
).replace(/\/$/u, "");

export type EmailFakeScenario =
  | "success"
  | "temporary_rejection"
  | "permanent_rejection"
  | "partial_acceptance"
  | "data_temporary_error"
  | "data_permanent_error"
  | "disconnect_after_send"
  | "timeout"
  | "malformed_response";

export type EmailFakeRequest = {
  id: string;
  operation: "send_email";
  scenario: EmailFakeScenario;
  receivedAt: string;
  bodyBytes: number;
  recipientCount: number;
  acceptedRecipientCount: number;
  rejectedRecipientCount: number;
  authenticated: boolean;
  subjectHeaderPresent: boolean;
  messageIdHeaderPresent: boolean;
  dispatchHeaderPresent: boolean;
  attachmentHeaderPresent: boolean;
  forwarded: boolean;
  outcome: "accepted" | "rejected" | "ambiguous";
};

export async function resetEmailFake(): Promise<void> {
  const response = await fetch(`${emailControlBase}/__control/reset`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to reset email fake (${response.status})`);
  }
}

export async function setEmailFakeScenario(
  scenario: EmailFakeScenario,
  options: { repeat?: number; delayMs?: number } = {},
): Promise<void> {
  const response = await fetch(`${emailControlBase}/__control/scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "send_email", scenario, ...options }),
  });
  if (!response.ok) {
    throw new Error(`Failed to configure email fake (${response.status})`);
  }
}

export async function fetchEmailFakeRequests(): Promise<EmailFakeRequest[]> {
  const response = await fetch(`${emailControlBase}/__control/requests`);
  if (!response.ok) {
    throw new Error(`Failed to fetch email fake evidence (${response.status})`);
  }
  const payload = (await response.json()) as { requests?: EmailFakeRequest[] };
  return payload.requests ?? [];
}

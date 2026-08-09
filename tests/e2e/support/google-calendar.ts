import { getOptionalEnvVar } from "./env";

const googleCalendarControlBase = (
  getOptionalEnvVar(
    "GOOGLE_CALENDAR_FAKE_CONTROL_URL",
    "http://127.0.0.1:4012",
  ) ?? "http://127.0.0.1:4012"
).replace(/\/$/u, "");

export type GoogleCalendarFakeOperation =
  | "token"
  | "create"
  | "list"
  | "get"
  | "update"
  | "delete"
  | "watch";

export type GoogleCalendarFakeScenario =
  | "success"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "provider_error"
  | "malformed_json"
  | "empty_success"
  | "timeout";

export type GoogleCalendarFakeRequest = {
  id: string;
  operation: GoogleCalendarFakeOperation;
  method: string;
  receivedAt: string;
  contentType: string | null;
  bodyBytes: number;
  authorization: "missing" | "bearer" | "other";
  queryKeys: string[];
  calendarIdPresent: boolean;
  eventIdPresent: boolean;
};

export async function resetGoogleCalendarFake(): Promise<void> {
  const response = await fetch(`${googleCalendarControlBase}/__control/reset`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to reset Google Calendar fake (${response.status})`,
    );
  }
}

export async function setGoogleCalendarFakeScenario(
  operation: GoogleCalendarFakeOperation,
  scenario: GoogleCalendarFakeScenario,
  options: { repeat?: number; delayMs?: number; status?: number } = {},
): Promise<void> {
  const response = await fetch(
    `${googleCalendarControlBase}/__control/scenario`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, scenario, ...options }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to configure Google Calendar fake (${response.status})`,
    );
  }
}

export async function fetchGoogleCalendarFakeRequests(): Promise<
  GoogleCalendarFakeRequest[]
> {
  const response = await fetch(
    `${googleCalendarControlBase}/__control/requests`,
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Google Calendar fake evidence (${response.status})`,
    );
  }
  const payload = (await response.json()) as {
    requests?: GoogleCalendarFakeRequest[];
  };
  return payload.requests ?? [];
}

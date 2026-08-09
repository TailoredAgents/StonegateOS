import { getOptionalEnvVar } from "./env";

const squareControlBase = (
  getOptionalEnvVar("SQUARE_FAKE_CONTROL_URL", "http://127.0.0.1:4015") ??
  "http://127.0.0.1:4015"
).replace(/\/$/u, "");

export type SquareFakeOperation =
  | "retrieve_order"
  | "retrieve_payment"
  | "retrieve_refund"
  | "list_payments"
  | "list_refunds";

export type SquareFakeScenario =
  | "success"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unprocessable"
  | "rate_limited"
  | "provider_error"
  | "malformed_json"
  | "empty_success"
  | "invalid_success"
  | "no_results"
  | "timeout";

export type SquareFakeRequest = {
  id: string;
  operation: SquareFakeOperation;
  method: string;
  receivedAt: string;
  bodyBytes: number;
  authorization: "missing" | "bearer" | "other";
  squareVersion: "missing" | "present";
  resourceIdPresent: boolean;
  locationFilterPresent: boolean;
  timeWindowPresent: boolean;
  cursorPresent: boolean;
};

export async function resetSquareFake(): Promise<void> {
  const response = await fetch(`${squareControlBase}/__control/reset`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to reset Square fake (${response.status})`);
  }
}

export async function setSquareFakeScenario(
  operation: SquareFakeOperation,
  scenario: SquareFakeScenario,
  options: { repeat?: number; delayMs?: number; status?: number } = {},
): Promise<void> {
  const response = await fetch(`${squareControlBase}/__control/scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, scenario, ...options }),
  });
  if (!response.ok) {
    throw new Error(`Failed to configure Square fake (${response.status})`);
  }
}

export async function fetchSquareFakeRequests(): Promise<SquareFakeRequest[]> {
  const response = await fetch(`${squareControlBase}/__control/requests`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Square fake evidence (${response.status})`,
    );
  }
  const payload = (await response.json()) as {
    requests?: SquareFakeRequest[];
  };
  return payload.requests ?? [];
}

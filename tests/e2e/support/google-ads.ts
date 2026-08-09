import { getOptionalEnvVar } from "./env";

const googleAdsControlBase = (
  getOptionalEnvVar("GOOGLE_ADS_FAKE_CONTROL_URL", "http://127.0.0.1:4014") ??
  "http://127.0.0.1:4014"
).replace(/\/$/u, "");

export type GoogleAdsFakeOperation =
  | "token"
  | "accessible_customers"
  | "search_stream"
  | "mutate_negative_keyword";

export type GoogleAdsFakeScenario =
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

export type GoogleAdsFakeRequest = {
  id: string;
  operation: GoogleAdsFakeOperation;
  method: string;
  receivedAt: string;
  contentType: string | null;
  bodyBytes: number;
  authorization: "missing" | "bearer" | "other";
  developerToken: "missing" | "present";
  loginCustomerId: "missing" | "present";
  apiVersion: string | null;
  customerIdPresent: boolean;
  queryKind:
    | "missing"
    | "unknown"
    | "conversion_actions"
    | "campaign_metrics"
    | "search_terms"
    | "campaign_conversions"
    | null;
  operationCount: number | null;
};

export async function resetGoogleAdsFake(): Promise<void> {
  const response = await fetch(`${googleAdsControlBase}/__control/reset`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to reset Google Ads fake (${response.status})`);
  }
}

export async function setGoogleAdsFakeScenario(
  operation: GoogleAdsFakeOperation,
  scenario: GoogleAdsFakeScenario,
  options: { repeat?: number; delayMs?: number; status?: number } = {},
): Promise<void> {
  const response = await fetch(`${googleAdsControlBase}/__control/scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, scenario, ...options }),
  });
  if (!response.ok) {
    throw new Error(`Failed to configure Google Ads fake (${response.status})`);
  }
}

export async function fetchGoogleAdsFakeRequests(): Promise<
  GoogleAdsFakeRequest[]
> {
  const response = await fetch(`${googleAdsControlBase}/__control/requests`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Google Ads fake evidence (${response.status})`,
    );
  }
  const payload = (await response.json()) as {
    requests?: GoogleAdsFakeRequest[];
  };
  return payload.requests ?? [];
}

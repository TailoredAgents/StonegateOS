import { getOptionalEnvVar } from "./env";

const metaControlBase = (
  getOptionalEnvVar("META_FAKE_CONTROL_URL", "http://127.0.0.1:4013") ??
  "http://127.0.0.1:4013"
).replace(/\/$/u, "");

export type MetaFakeOperation =
  | "all"
  | "messenger.message"
  | "messenger.typing"
  | "messenger.media"
  | "page_token.lookup"
  | "identity.lookup"
  | "lead.lookup"
  | "token.debug"
  | "page.subscriptions"
  | "ads.insights"
  | "conversions.events";

export type MetaFakeScenario =
  | "success"
  | "oauth_denied"
  | "permission_denied"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "provider_error"
  | "malformed_json"
  | "empty_success"
  | "timeout"
  | "media_partial_failure";

export type MetaFakeRequest = {
  id: string;
  receivedAt: string;
  method: string;
  operation: Exclude<MetaFakeOperation, "all">;
  scenario: MetaFakeScenario;
  bodyBytes: number;
  contentType: string | null;
  credentialLocation: "query" | "authorization" | "missing";
  queryKeys: string[];
  targetIdHash: string | null;
  targetIdSuffix: string | null;
  recipientIdHash: string | null;
  recipientIdSuffix: string | null;
  textLength: number;
  senderAction: string | null;
  attachmentType: string | null;
  hasMediaUrl: boolean;
  eventCount: number | null;
  dispatchIdHash: string | null;
};

export async function resetMetaFake(): Promise<void> {
  const response = await fetch(`${metaControlBase}/__control/reset`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to reset Meta fake (${response.status})`);
  }
}

export async function setMetaFakeScenario(
  name: MetaFakeScenario,
  options: {
    operation?: MetaFakeOperation;
    repeat?: number;
    delayMs?: number;
    mediaFailureAt?: number;
    adsPages?: 1 | 2;
  } = {},
): Promise<void> {
  const response = await fetch(`${metaControlBase}/__control/scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...options }),
  });
  if (!response.ok) {
    throw new Error(`Failed to configure Meta fake (${response.status})`);
  }
}

export async function fetchMetaFakeRequests(): Promise<MetaFakeRequest[]> {
  const response = await fetch(`${metaControlBase}/__control/requests`);
  if (!response.ok) {
    throw new Error(`Failed to fetch Meta fake evidence (${response.status})`);
  }
  const payload = (await response.json()) as {
    requests?: MetaFakeRequest[];
  };
  return payload.requests ?? [];
}

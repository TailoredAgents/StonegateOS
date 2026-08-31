import { resolveMetaGraphApiEndpoint } from "@myst-os/sdk";
import { sendEmailThroughProvider } from "@/lib/email-provider";
import { createTwilioProviderMessage } from "@/lib/twilio-provider";

export type SendResult = {
  ok: boolean;
  provider?: string;
  providerMessageId?: string | null;
  providerOperationIds?: string[];
  providerIdempotencySupported?: boolean;
  deliveryCertainty?: "not_sent" | "accepted" | "uncertain";
  detail?: string;
};

export type SendRequestOptions = {
  /**
   * Stable Stonegate request key. Providers that do not explicitly document
   * idempotent handling still receive, at most, a correlation value; callers
   * must not treat this key as an exactly-once guarantee.
   */
  idempotencyKey?: string | null;
  emailAttachments?: Array<{
    filename: string;
    content: string;
    contentType: string;
    encoding?: "base64";
  }>;
  emailHtml?: string | null;
};

type FacebookPageTokenResponse = {
  access_token?: string;
  id?: string;
};

type FacebookSendResponse = {
  recipient_id?: string;
  message_id?: string;
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
};

export async function sendSmsMessage(
  to: string,
  body: string,
  mediaUrls?: string[] | null,
  options: SendRequestOptions = {},
): Promise<SendResult> {
  void options;
  const urls = Array.isArray(mediaUrls)
    ? mediaUrls.filter(
        (url): url is string =>
          typeof url === "string" && url.trim().length > 0,
      )
    : [];
  const result = await createTwilioProviderMessage({
    to,
    body: body ?? "",
    mediaUrls: urls,
  });
  if (result.ok) {
    return {
      ok: true,
      provider: "twilio",
      providerMessageId: result.messageSid,
      providerOperationIds: [result.messageSid],
      providerIdempotencySupported: false,
      deliveryCertainty: "accepted",
    };
  }

  const detail = (() => {
    if (result.code === "not_configured") return "sms_not_configured";
    if (result.code === "invalid_configuration")
      return "sms_invalid_configuration";
    if (result.code === "operation_disabled")
      return "sms_external_sends_disabled";
    if (result.code === "invalid_input") return "sms_invalid_input";
    if (result.code === "timeout") return "sms_timeout";
    if (result.code === "transport_error") return "sms_transport_error";
    if (result.code === "response_too_large") return "sms_response_too_large";
    if (result.code === "malformed_response") return "sms_response_invalid";
    return result.status === null
      ? "sms_provider_failed"
      : `sms_failed:${result.status}`;
  })();
  return {
    ok: false,
    provider: "twilio",
    providerMessageId: null,
    providerOperationIds: [],
    providerIdempotencySupported: false,
    deliveryCertainty:
      result.certainty === "uncertain" ? "uncertain" : "not_sent",
    detail,
  };
}

export async function sendEmailMessage(
  to: string,
  subject: string,
  textBody: string,
  options: SendRequestOptions = {},
): Promise<SendResult> {
  const result = await sendEmailThroughProvider({
    to,
    subject,
    text: textBody,
    html: options.emailHtml,
    idempotencyKey: options.idempotencyKey,
    attachments: options.emailAttachments,
  });
  return {
    ok: result.ok,
    provider: "smtp",
    providerMessageId: result.providerMessageId,
    providerOperationIds: result.providerMessageId
      ? [result.providerMessageId]
      : [],
    providerIdempotencySupported: false,
    deliveryCertainty:
      result.deliveryCertainty === "accepted"
        ? "accepted"
        : result.deliveryCertainty === "rejected"
          ? "not_sent"
          : "uncertain",
    detail: result.detail ?? undefined,
  };
}

type DmWebhookResponse = {
  id?: string;
  messageId?: string;
  providerMessageId?: string;
  ok?: boolean;
  error?: string;
};

function readDmWebhookConfig(): {
  url: string;
  token: string | null;
  from: string | null;
} | null {
  const url = process.env["DM_WEBHOOK_URL"];
  if (!url) return null;
  return {
    url,
    token: process.env["DM_WEBHOOK_TOKEN"] ?? null,
    from: process.env["DM_WEBHOOK_FROM"] ?? null,
  };
}

const PAGE_TOKEN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const pageAccessTokenCache = new Map<
  string,
  { token: string; fetchedAt: number }
>();

function getFacebookSystemUserToken(): string | null {
  const token =
    process.env["FB_MESSENGER_ACCESS_TOKEN"] ??
    process.env["FB_LEADGEN_ACCESS_TOKEN"] ??
    null;
  return token && token.trim().length > 0 ? token.trim() : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getDmProvider(
  metadata?: Record<string, unknown> | null,
): string | null {
  return (
    readString(metadata?.["dmProvider"]) ??
    readString(metadata?.["source"]) ??
    readString(metadata?.["provider"]) ??
    null
  );
}

function getFacebookPageId(
  metadata?: Record<string, unknown> | null,
): string | null {
  return (
    readString(metadata?.["dmPageId"]) ??
    readString(metadata?.["pageId"]) ??
    readString(metadata?.["recipientId"]) ??
    readString(metadata?.["page_id"]) ??
    readString(process.env["FB_PAGE_ID"]) ??
    null
  );
}

async function fetchFacebookPageAccessToken(
  pageId: string,
  systemUserToken: string,
): Promise<string> {
  const cached = pageAccessTokenCache.get(pageId);
  if (cached && Date.now() - cached.fetchedAt < PAGE_TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }

  const url = new URL(resolveMetaGraphApiEndpoint([pageId], process.env));
  url.searchParams.set("fields", "access_token");
  url.searchParams.set("access_token", systemUserToken);

  const response = await fetch(url.toString(), { method: "GET" });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`fb_page_token_failed:${response.status}`);
  }

  const json = (await response
    .json()
    .catch(() => null)) as FacebookPageTokenResponse | null;
  const pageToken =
    json && typeof json.access_token === "string"
      ? json.access_token.trim()
      : "";
  if (!pageToken) {
    throw new Error("fb_page_token_missing");
  }

  pageAccessTokenCache.set(pageId, { token: pageToken, fetchedAt: Date.now() });
  return pageToken;
}

async function sendFacebookDm(
  action: "message" | "typing_on" | "typing_off",
  input: {
    pageId: string;
    recipientId: string;
    body?: string;
    attachment?: { type: "image" | "video"; url: string; isReusable?: boolean };
  },
  options: SendRequestOptions = {},
): Promise<SendResult> {
  const systemUserToken = getFacebookSystemUserToken();
  if (!systemUserToken) {
    return {
      ok: false,
      provider: "facebook",
      providerIdempotencySupported: false,
      deliveryCertainty: "not_sent",
      detail: "facebook_dm_not_configured",
    };
  }

  let pageAccessToken: string;
  try {
    pageAccessToken = await fetchFacebookPageAccessToken(
      input.pageId,
      systemUserToken,
    );
  } catch {
    return {
      ok: false,
      provider: "facebook",
      providerIdempotencySupported: false,
      deliveryCertainty: "not_sent",
      detail: "facebook_dm_token_error",
    };
  }
  const url = new URL(
    resolveMetaGraphApiEndpoint(["me", "messages"], process.env),
  );
  url.searchParams.set("access_token", pageAccessToken);

  const payload: Record<string, unknown> = {
    recipient: { id: input.recipientId },
  };

  if (action === "message") {
    payload["messaging_type"] = "RESPONSE";
    if (input.attachment) {
      payload["message"] = {
        attachment: {
          type: input.attachment.type,
          payload: {
            url: input.attachment.url,
            is_reusable: Boolean(input.attachment.isReusable),
          },
        },
      };
    } else {
      payload["message"] = { text: input.body ?? "" };
    }
  } else {
    payload["sender_action"] = action;
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.idempotencyKey
          ? { "X-Stonegate-Dispatch-Id": options.idempotencyKey }
          : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      ok: false,
      provider: "facebook",
      providerIdempotencySupported: false,
      deliveryCertainty: "uncertain",
      detail: "facebook_dm_transport_error",
    };
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      provider: "facebook",
      providerIdempotencySupported: false,
      deliveryCertainty: response.status >= 500 ? "uncertain" : "not_sent",
      detail: `facebook_dm_failed:${response.status}`,
    };
  }

  const json = (await response
    .json()
    .catch(() => null)) as FacebookSendResponse | null;

  const providerMessageId =
    typeof json?.message_id === "string" && json.message_id.trim().length > 0
      ? json.message_id.trim()
      : null;
  if (action === "message" && !providerMessageId) {
    return {
      ok: false,
      provider: "facebook",
      providerMessageId: null,
      providerOperationIds: [],
      providerIdempotencySupported: false,
      deliveryCertainty: "uncertain",
      detail: "facebook_dm_response_missing_message_id",
    };
  }

  return {
    ok: true,
    provider: "facebook",
    providerMessageId,
    providerOperationIds: providerMessageId ? [providerMessageId] : [],
    providerIdempotencySupported: false,
    deliveryCertainty: "accepted",
  };
}

async function postDmWebhook(
  payload: Record<string, unknown>,
  options: SendRequestOptions = {},
): Promise<SendResult> {
  const config = readDmWebhookConfig();
  if (!config) {
    return {
      ok: false,
      provider: "dm_webhook",
      providerIdempotencySupported: false,
      deliveryCertainty: "not_sent",
      detail: "dm_not_configured",
    };
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.token) {
      headers["Authorization"] = `Bearer ${config.token}`;
    }
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
      headers["X-Stonegate-Dispatch-Id"] = options.idempotencyKey;
      payload["idempotencyKey"] = options.idempotencyKey;
    }

    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        provider: "dm_webhook",
        providerIdempotencySupported:
          process.env["DM_WEBHOOK_SUPPORTS_IDEMPOTENCY"] === "1",
        deliveryCertainty: response.status >= 500 ? "uncertain" : "not_sent",
        detail: `dm_failed:${response.status}`,
      };
    }

    const data = (await response
      .json()
      .catch(() => null)) as DmWebhookResponse | null;
    if (data?.ok === false) {
      return {
        ok: false,
        provider: "dm_webhook",
        providerIdempotencySupported:
          process.env["DM_WEBHOOK_SUPPORTS_IDEMPOTENCY"] === "1",
        deliveryCertainty: "not_sent",
        detail: "dm_provider_rejected",
      };
    }

    const providerMessageId =
      (typeof data?.providerMessageId === "string" && data.providerMessageId) ||
      (typeof data?.messageId === "string" && data.messageId) ||
      (typeof data?.id === "string" && data.id) ||
      null;

    return {
      ok: true,
      provider: "dm_webhook",
      providerMessageId,
      providerOperationIds: providerMessageId ? [providerMessageId] : [],
      providerIdempotencySupported:
        process.env["DM_WEBHOOK_SUPPORTS_IDEMPOTENCY"] === "1",
      deliveryCertainty: "accepted",
    };
  } catch {
    return {
      ok: false,
      provider: "dm_webhook",
      providerIdempotencySupported:
        process.env["DM_WEBHOOK_SUPPORTS_IDEMPOTENCY"] === "1",
      deliveryCertainty: "uncertain",
      detail: "dm_transport_error",
    };
  }
}

export async function sendDmMessage(
  to: string,
  body: string,
  metadata?: Record<string, unknown> | null,
  mediaUrls?: string[] | null,
  options: SendRequestOptions = {},
): Promise<SendResult> {
  const config = readDmWebhookConfig();
  if (config) {
    const payload: Record<string, unknown> = {
      action: "message",
      to,
      body,
      metadata: metadata ?? null,
      mediaUrls: Array.isArray(mediaUrls) ? mediaUrls : [],
    };
    if (config.from) {
      payload["from"] = config.from;
    }
    return postDmWebhook(payload, options);
  }

  const provider = getDmProvider(metadata);
  if (provider !== "facebook") {
    return {
      ok: false,
      provider: "dm",
      providerIdempotencySupported: false,
      deliveryCertainty: "not_sent",
      detail: "dm_not_configured",
    };
  }

  const pageId = getFacebookPageId(metadata);
  if (!pageId) {
    return {
      ok: false,
      provider: "facebook",
      providerIdempotencySupported: false,
      deliveryCertainty: "not_sent",
      detail: "facebook_dm_missing_page",
    };
  }

  try {
    const trimmed = typeof body === "string" ? body.trim() : "";
    const urls = Array.isArray(mediaUrls)
      ? mediaUrls.filter(
          (url): url is string =>
            typeof url === "string" && url.trim().length > 0,
        )
      : [];

    let last: SendResult | null = null;
    const providerOperationIds: string[] = [];
    const rememberOperation = (result: SendResult): void => {
      for (const operationId of [
        ...(result.providerOperationIds ?? []),
        result.providerMessageId,
      ]) {
        if (
          typeof operationId === "string" &&
          operationId.trim() &&
          !providerOperationIds.includes(operationId.trim())
        ) {
          providerOperationIds.push(operationId.trim());
        }
      }
    };
    const withPartialDeliverySafety = (result: SendResult): SendResult => {
      if (result.ok || providerOperationIds.length === 0) return result;
      return {
        ...result,
        providerOperationIds,
        providerMessageId:
          result.providerMessageId ?? providerOperationIds.at(-1) ?? null,
        deliveryCertainty: "uncertain",
        detail: `dm_partial_delivery:${result.detail ?? "unknown_failure"}`,
      };
    };
    if (trimmed.length > 0 || urls.length === 0) {
      last = await sendFacebookDm(
        "message",
        { pageId, recipientId: to, body: trimmed },
        options,
      );
      if (!last.ok) return withPartialDeliverySafety(last);
      rememberOperation(last);
    }

    const guessType = (url: string): "image" | "video" => {
      const lower = url.toLowerCase();
      if (
        lower.endsWith(".mp4") ||
        lower.endsWith(".mov") ||
        lower.endsWith(".webm")
      )
        return "video";
      return "image";
    };

    for (const url of urls) {
      const res = await sendFacebookDm(
        "message",
        {
          pageId,
          recipientId: to,
          attachment: { type: guessType(url), url, isReusable: true },
        },
        options,
      );
      if (!res.ok) return withPartialDeliverySafety(res);
      rememberOperation(res);
      last = res;
    }

    return last
      ? { ...last, providerOperationIds }
      : {
          ok: true,
          provider: "facebook",
          providerMessageId: null,
          providerOperationIds: [],
          providerIdempotencySupported: false,
          deliveryCertainty: "accepted",
        };
  } catch {
    return {
      ok: false,
      provider: "facebook",
      providerOperationIds: [],
      providerIdempotencySupported: false,
      deliveryCertainty: "uncertain",
      detail: "facebook_dm_transport_error",
    };
  }
}

export async function sendDmTyping(
  to: string,
  state: "typing_on" | "typing_off",
  metadata?: Record<string, unknown> | null,
): Promise<SendResult> {
  const config = readDmWebhookConfig();
  if (config) {
    const payload: Record<string, unknown> = {
      action: state,
      to,
      metadata: metadata ?? null,
    };
    if (config.from) {
      payload["from"] = config.from;
    }
    return postDmWebhook(payload);
  }

  const provider = getDmProvider(metadata);
  if (provider !== "facebook") {
    return { ok: false, provider: "dm", detail: "dm_not_configured" };
  }

  const pageId = getFacebookPageId(metadata);
  if (!pageId) {
    return {
      ok: false,
      provider: "facebook",
      detail: "facebook_dm_missing_page",
    };
  }

  try {
    return await sendFacebookDm(state, { pageId, recipientId: to });
  } catch {
    return {
      ok: false,
      provider: "facebook",
      providerIdempotencySupported: false,
      deliveryCertainty: "uncertain",
      detail: "facebook_dm_transport_error",
    };
  }
}

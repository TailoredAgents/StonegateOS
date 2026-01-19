import nodemailer from "nodemailer";

export type SendResult = {
  ok: boolean;
  provider?: string;
  providerMessageId?: string | null;
  detail?: string;
};

let cachedTransporter: nodemailer.Transporter | null = null;

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

function getTransport(): nodemailer.Transporter | null {
  if (cachedTransporter) {
    return cachedTransporter;
  }

  const host = process.env["SMTP_HOST"];
  const port = process.env["SMTP_PORT"];
  const user = process.env["SMTP_USER"];
  const pass = process.env["SMTP_PASS"];

  if (!host || !port || !user || !pass) {
    return null;
  }

  const parsedPort = Number(port);
  const secure = parsedPort === 465;

  cachedTransporter = nodemailer.createTransport({
    host,
    port: parsedPort,
    secure,
    auth: {
      user,
      pass
    }
  });

  return cachedTransporter;
}

export async function sendSmsMessage(
  to: string,
  body: string,
  mediaUrls?: string[] | null
): Promise<SendResult> {
  const sid = process.env["TWILIO_ACCOUNT_SID"];
  const token = process.env["TWILIO_AUTH_TOKEN"];
  const from = process.env["TWILIO_FROM"];

  if (!sid || !token || !from) {
    return { ok: false, provider: "twilio", detail: "sms_not_configured" };
  }

  const baseUrl = (process.env["TWILIO_API_BASE_URL"] ?? "https://api.twilio.com").replace(/\/$/, "");

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const formParams = new URLSearchParams({ From: from, To: to });
    formParams.set("Body", body ?? "");
    const urls = Array.isArray(mediaUrls)
      ? mediaUrls.filter((url): url is string => typeof url === "string" && url.trim().length > 0)
      : [];
    for (const url of urls) {
      formParams.append("MediaUrl", url.trim());
    }

    const response = await fetch(`${baseUrl}/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${auth}`
      },
      body: formParams.toString()
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, provider: "twilio", detail: `sms_failed:${response.status}:${text}` };
    }

    const payload = (await response.json().catch(() => null)) as { sid?: string } | null;
    return {
      ok: true,
      provider: "twilio",
      providerMessageId: payload?.sid ?? null
    };
  } catch (error) {
    return { ok: false, provider: "twilio", detail: `sms_error:${String(error)}` };
  }
}

export async function sendEmailMessage(
  to: string,
  subject: string,
  textBody: string
): Promise<SendResult> {
  const transporter = getTransport();
  const from = process.env["SMTP_FROM"];

  if (!transporter || !from) {
    return { ok: false, provider: "smtp", detail: "email_not_configured" };
  }

  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text: textBody
    });

    return {
      ok: true,
      provider: "smtp",
      providerMessageId:
        typeof (info as { messageId?: string }).messageId === "string"
          ? (info as { messageId?: string }).messageId
          : null
    };
  } catch (error) {
    return { ok: false, provider: "smtp", detail: `email_error:${String(error)}` };
  }
}

type DmWebhookResponse = {
  id?: string;
  messageId?: string;
  providerMessageId?: string;
  ok?: boolean;
  error?: string;
};

function readDmWebhookConfig(): { url: string; token: string | null; from: string | null } | null {
  const url = process.env["DM_WEBHOOK_URL"];
  if (!url) return null;
  return {
    url,
    token: process.env["DM_WEBHOOK_TOKEN"] ?? null,
    from: process.env["DM_WEBHOOK_FROM"] ?? null
  };
}

const FB_GRAPH_VERSION = "v24.0";
const PAGE_TOKEN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const pageAccessTokenCache = new Map<string, { token: string; fetchedAt: number }>();

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

function getDmProvider(metadata?: Record<string, unknown> | null): string | null {
  return (
    readString(metadata?.["dmProvider"]) ??
    readString(metadata?.["source"]) ??
    readString(metadata?.["provider"]) ??
    null
  );
}

function getFacebookPageId(metadata?: Record<string, unknown> | null): string | null {
  return (
    readString(metadata?.["dmPageId"]) ??
    readString(metadata?.["pageId"]) ??
    readString(metadata?.["recipientId"]) ??
    readString(metadata?.["page_id"]) ??
    readString(process.env["FB_PAGE_ID"]) ??
    null
  );
}

async function fetchFacebookPageAccessToken(pageId: string, systemUserToken: string): Promise<string> {
  const cached = pageAccessTokenCache.get(pageId);
  if (cached && Date.now() - cached.fetchedAt < PAGE_TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }

  const url = new URL(`https://graph.facebook.com/${FB_GRAPH_VERSION}/${pageId}`);
  url.searchParams.set("fields", "access_token");
  url.searchParams.set("access_token", systemUserToken);

  const response = await fetch(url.toString(), { method: "GET" });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`fb_page_token_failed:${response.status}:${text}`);
  }

  const json = (() => {
    try {
      return JSON.parse(text) as FacebookPageTokenResponse;
    } catch {
      return null;
    }
  })();
  const pageToken = json && typeof json.access_token === "string" ? json.access_token.trim() : "";
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
  }
): Promise<SendResult> {
  const systemUserToken = getFacebookSystemUserToken();
  if (!systemUserToken) {
    return { ok: false, provider: "facebook", detail: "facebook_dm_not_configured" };
  }

  const pageAccessToken = await fetchFacebookPageAccessToken(input.pageId, systemUserToken);
  const url = new URL(`https://graph.facebook.com/${FB_GRAPH_VERSION}/me/messages`);
  url.searchParams.set("access_token", pageAccessToken);

  const payload: Record<string, unknown> = {
    recipient: { id: input.recipientId }
  };

  if (action === "message") {
    payload["messaging_type"] = "RESPONSE";
    if (input.attachment) {
      payload["message"] = {
        attachment: {
          type: input.attachment.type,
          payload: {
            url: input.attachment.url,
            is_reusable: Boolean(input.attachment.isReusable)
          }
        }
      };
    } else {
      payload["message"] = { text: input.body ?? "" };
    }
  } else {
    payload["sender_action"] = action;
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  if (!response.ok) {
    return { ok: false, provider: "facebook", detail: `facebook_dm_failed:${response.status}:${text}` };
  }

  const json = (() => {
    try {
      return JSON.parse(text) as FacebookSendResponse;
    } catch {
      return null;
    }
  })();

  return {
    ok: true,
    provider: "facebook",
    providerMessageId: json?.message_id ?? null
  };
}

async function postDmWebhook(
  payload: Record<string, unknown>
): Promise<SendResult> {
  const config = readDmWebhookConfig();
  if (!config) {
    return { ok: false, provider: "dm_webhook", detail: "dm_not_configured" };
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (config.token) {
      headers["Authorization"] = `Bearer ${config.token}`;
    }

    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, provider: "dm_webhook", detail: `dm_failed:${response.status}:${text}` };
    }

    const data = (await response.json().catch(() => null)) as DmWebhookResponse | null;
    if (data?.ok === false) {
      return { ok: false, provider: "dm_webhook", detail: data.error ?? "dm_failed" };
    }

    const providerMessageId =
      (typeof data?.providerMessageId === "string" && data.providerMessageId) ||
      (typeof data?.messageId === "string" && data.messageId) ||
      (typeof data?.id === "string" && data.id) ||
      null;

    return {
      ok: true,
      provider: "dm_webhook",
      providerMessageId
    };
  } catch (error) {
    return { ok: false, provider: "dm_webhook", detail: `dm_error:${String(error)}` };
  }
}

export async function sendDmMessage(
  to: string,
  body: string,
  metadata?: Record<string, unknown> | null,
  mediaUrls?: string[] | null
): Promise<SendResult> {
  const config = readDmWebhookConfig();
  if (config) {
    const payload: Record<string, unknown> = {
      action: "message",
      to,
      body,
      metadata: metadata ?? null,
      mediaUrls: Array.isArray(mediaUrls) ? mediaUrls : []
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
    return { ok: false, provider: "facebook", detail: "facebook_dm_missing_page" };
  }

  try {
    const trimmed = typeof body === "string" ? body.trim() : "";
    const urls = Array.isArray(mediaUrls)
      ? mediaUrls.filter((url): url is string => typeof url === "string" && url.trim().length > 0)
      : [];

    let last: SendResult | null = null;
    if (trimmed.length > 0 || urls.length === 0) {
      last = await sendFacebookDm("message", { pageId, recipientId: to, body: trimmed });
      if (!last.ok) return last;
    }

    const guessType = (url: string): "image" | "video" => {
      const lower = url.toLowerCase();
      if (lower.endsWith(".mp4") || lower.endsWith(".mov") || lower.endsWith(".webm")) return "video";
      return "image";
    };

    for (const url of urls) {
      const res = await sendFacebookDm("message", {
        pageId,
        recipientId: to,
        attachment: { type: guessType(url), url, isReusable: true }
      });
      if (!res.ok) return res;
      last = res;
    }

    return last ?? { ok: true, provider: "facebook", providerMessageId: null };
  } catch (error) {
    return { ok: false, provider: "facebook", detail: `facebook_dm_error:${String(error)}` };
  }
}

export async function sendDmTyping(
  to: string,
  state: "typing_on" | "typing_off",
  metadata?: Record<string, unknown> | null
): Promise<SendResult> {
  const config = readDmWebhookConfig();
  if (config) {
    const payload: Record<string, unknown> = {
      action: state,
      to,
      metadata: metadata ?? null
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
    return { ok: false, provider: "facebook", detail: "facebook_dm_missing_page" };
  }

  try {
    return await sendFacebookDm(state, { pageId, recipientId: to });
  } catch (error) {
    return { ok: false, provider: "facebook", detail: `facebook_dm_error:${String(error)}` };
  }
}

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getDb, outboxEvents } from "@/db";

export const dynamic = "force-dynamic";

type FacebookMessageAttachment = {
  type?: string;
  payload?: { url?: string };
};

type FacebookMessage = {
  mid?: string;
  text?: string;
  is_echo?: boolean;
  attachments?: FacebookMessageAttachment[];
};

type FacebookPostback = {
  payload?: string;
  title?: string;
  referral?: Record<string, unknown>;
};

type FacebookMessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: FacebookMessage;
  postback?: FacebookPostback;
};

type FacebookLeadgenField = {
  name?: string;
  values?: string[];
};

type FacebookLeadgenChangeValue = {
  leadgen_id?: string;
  form_id?: string;
  ad_id?: string;
  adgroup_id?: string;
  adset_id?: string;
  campaign_id?: string;
  page_id?: string;
  created_time?: number;
};

type FacebookLeadgenChange = {
  field?: string;
  value?: FacebookLeadgenChangeValue;
};

type FacebookWebhookEntry = {
  id?: string;
  time?: number;
  messaging?: FacebookMessagingEvent[];
  changes?: FacebookLeadgenChange[];
};

type FacebookWebhookPayload = {
  object?: string;
  entry?: FacebookWebhookEntry[];
};

function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const trimmed = signature.split(",")[0]?.trim() ?? "";
  const [algoRaw, hash] = trimmed.split("=");
  const algo = algoRaw?.trim().toLowerCase();

  if (!hash || (algo !== "sha256" && algo !== "sha1")) {
    return false;
  }

  const expected = crypto.createHmac(algo, secret).update(rawBody, "utf8").digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function getMediaUrls(message?: FacebookMessage): string[] {
  const attachments = Array.isArray(message?.attachments) ? message?.attachments ?? [] : [];
  return attachments
    .map((attachment) => (typeof attachment?.payload?.url === "string" ? attachment.payload.url : null))
    .filter((url): url is string => Boolean(url));
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeFieldKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildFieldMap(fields?: FacebookLeadgenField[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  const items = Array.isArray(fields) ? fields : [];
  for (const field of items) {
    const label = typeof field.name === "string" ? field.name.trim() : "";
    const values = Array.isArray(field.values)
      ? field.values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (!label || values.length === 0) {
      continue;
    }
    map[normalizeFieldKey(label)] = values;
  }
  return map;
}

function buildCustomAnswers(
  fields?: FacebookLeadgenField[],
  standardKeys?: Set<string>
): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  const items = Array.isArray(fields) ? fields : [];
  for (const field of items) {
    const label = typeof field.name === "string" ? field.name.trim() : "";
    const values = Array.isArray(field.values)
      ? field.values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (!label || values.length === 0) {
      continue;
    }
    const normalized = normalizeFieldKey(label);
    if (standardKeys?.has(normalized)) {
      continue;
    }
    answers[label] = values;
  }
  return answers;
}

function firstFieldValue(map: Record<string, string[]>, keys: string[]): string | null {
  for (const key of keys) {
    const values = map[key];
    if (Array.isArray(values) && values.length > 0) {
      return values[0] ?? null;
    }
  }
  return null;
}

function parseLeadFormFilter(): Set<string> | null {
  const raw = process.env["FB_LEAD_FORM_IDS"];
  if (!raw) return null;
  const ids = raw
    .split(/[,\s]+/g)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return ids.length ? new Set(ids) : null;
}

export function GET(request: NextRequest): Response {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !challenge) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const verifyToken = process.env["FB_VERIFY_TOKEN"];
  if (!verifyToken || token !== verifyToken) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return new NextResponse(challenge, { status: 200 });
}

export async function POST(request: NextRequest): Promise<Response> {
  const rawBody = await request.text();
  const secret = process.env["FB_APP_SECRET"];
  const signature =
    request.headers.get("x-hub-signature-256") ?? request.headers.get("x-hub-signature");

  if (secret && !verifySignature(rawBody, signature, secret)) {
    console.warn("[webhooks][facebook] invalid_signature", {
      signatureHeader: signature?.split("=")[0] ?? null,
      traceId: request.headers.get("x-fb-trace-id") ?? null
    });
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const payload = parseJson<FacebookWebhookPayload>(rawBody);
  if (!payload || payload.object !== "page" || !Array.isArray(payload.entry)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const db = getDb();
  const queuedEvents: Array<typeof outboxEvents.$inferInsert> = [];
  let queued = 0;
  let skipped = 0;
  const leadFormFilter = parseLeadFormFilter();

  for (const entry of payload.entry) {
    const events = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of events) {
      const senderId = event.sender?.id ?? null;
      const recipientId = event.recipient?.id ?? null;
      if (!senderId) {
        skipped += 1;
        continue;
      }

      const message = event.message;
      const postback = event.postback;
      const receivedAt =
        typeof event.timestamp === "number" ? new Date(event.timestamp) : undefined;

      if (message && !message.is_echo) {
        queuedEvents.push({
          type: "facebook.dm.inbound",
          payload: {
            pageId: entry.id ?? null,
            senderId,
            recipientId,
            timestamp: receivedAt?.toISOString() ?? null,
            body: typeof message.text === "string" ? message.text : "",
            providerMessageId: typeof message.mid === "string" ? message.mid : null,
            mediaUrls: getMediaUrls(message)
          }
        });
        queued += 1;
        continue;
      }

      if (postback) {
        const payload = typeof postback.payload === "string" ? postback.payload : null;
        const title = typeof postback.title === "string" ? postback.title : null;
        const referral =
          postback.referral && typeof postback.referral === "object" ? postback.referral : null;
        queuedEvents.push({
          type: "facebook.dm.postback",
          payload: {
            pageId: entry.id ?? null,
            senderId,
            recipientId,
            timestamp: receivedAt?.toISOString() ?? null,
            payload,
            title,
            referral
          }
        });
        queued += 1;
        continue;
      }

      skipped += 1;
    }

    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change.field !== "leadgen") {
        continue;
      }
      const value = change.value;
      const leadgenId = typeof value?.leadgen_id === "string" ? value.leadgen_id : null;
      const formId = typeof value?.form_id === "string" ? value.form_id : null;
      if (!leadgenId) {
        skipped += 1;
        continue;
      }
      if (leadFormFilter && formId && !leadFormFilter.has(formId)) {
        skipped += 1;
        continue;
      }

      queuedEvents.push({
        type: "facebook.leadgen.created",
        payload: {
          leadgenId,
          formId,
          pageId: entry.id ?? null
        }
      });
      queued += 1;
    }
  }

  if (queuedEvents.length > 0) {
    await db.insert(outboxEvents).values(queuedEvents);
  }

  return NextResponse.json({ ok: true, queued, skipped, errors: 0 });
}

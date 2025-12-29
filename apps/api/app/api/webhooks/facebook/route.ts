import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { recordInboundMessage } from "@/lib/inbox";

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

type FacebookMessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: FacebookMessage;
};

type FacebookWebhookEntry = {
  id?: string;
  time?: number;
  messaging?: FacebookMessagingEvent[];
};

type FacebookWebhookPayload = {
  object?: string;
  entry?: FacebookWebhookEntry[];
};

function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const [algo, hash] = signature.split("=");
  if (algo !== "sha256" || !hash) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
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

export async function GET(request: NextRequest): Promise<Response> {
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
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const payload = parseJson<FacebookWebhookPayload>(rawBody);
  if (!payload || payload.object !== "page" || !Array.isArray(payload.entry)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of payload.entry) {
    const events = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of events) {
      const message = event.message;
      if (!message || message.is_echo) {
        skipped += 1;
        continue;
      }

      const senderId = event.sender?.id ?? null;
      const recipientId = event.recipient?.id ?? null;
      if (!senderId) {
        skipped += 1;
        continue;
      }

      const text = typeof message.text === "string" ? message.text : "";
      const mediaUrls = getMediaUrls(message);
      const receivedAt =
        typeof event.timestamp === "number" ? new Date(event.timestamp) : undefined;

      try {
        await recordInboundMessage({
          channel: "dm",
          body: text,
          subject: null,
          fromAddress: senderId,
          toAddress: recipientId,
          provider: "facebook",
          providerMessageId: typeof message.mid === "string" ? message.mid : null,
          mediaUrls,
          receivedAt,
          metadata: {
            source: "facebook",
            pageId: entry.id ?? null,
            senderId,
            recipientId
          }
        });
        processed += 1;
      } catch (error) {
        errors += 1;
        console.warn("[webhooks][facebook] inbound_failed", { error: String(error) });
      }
    }
  }

  return NextResponse.json({ ok: true, processed, skipped, errors });
}

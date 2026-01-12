import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { eq, or, sql } from "drizzle-orm";
import { recordInboundMessage } from "@/lib/inbox";
import { getDb, contacts, leads, outboxEvents } from "@/db";
import { getDefaultSalesAssigneeMemberId } from "@/lib/sales-scorecard";
import { normalizeName, normalizePhone } from "../../web/utils";
import { upsertContact, upsertProperty } from "../../web/persistence";

export const dynamic = "force-dynamic";

const DEFAULT_SERVICES = ["junk_removal_primary"];
const DEFAULT_PLACEHOLDER_CITY = "Unknown";
const DEFAULT_PLACEHOLDER_STATE = "NA";
const DEFAULT_PLACEHOLDER_POSTAL = "00000";

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

type FacebookLeadgenDetails = {
  id?: string;
  created_time?: string;
  field_data?: FacebookLeadgenField[];
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
};

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

const PAGE_TOKEN_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const pageTokenCache = new Map<string, { token: string; fetchedAt: number }>();

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

function resolveFacebookToken(): { systemUserToken: string | null; pageAccessToken: string | null } {
  const pageAccessToken =
    process.env["FB_PAGE_ACCESS_TOKEN"] ??
    process.env["FB_MESSENGER_ACCESS_TOKEN"] ??
    null;
  const systemUserToken =
    process.env["FB_MARKETING_ACCESS_TOKEN"] ??
    process.env["FB_LEADGEN_ACCESS_TOKEN"] ??
    null;
  return {
    systemUserToken: systemUserToken && systemUserToken.trim().length > 0 ? systemUserToken.trim() : null,
    pageAccessToken: pageAccessToken && pageAccessToken.trim().length > 0 ? pageAccessToken.trim() : null
  };
}

async function fetchPageAccessToken(pageId: string, systemUserToken: string): Promise<string | null> {
  const cached = pageTokenCache.get(pageId);
  if (cached && Date.now() - cached.fetchedAt < PAGE_TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }

  const url = new URL(`https://graph.facebook.com/v24.0/${pageId}`);
  url.searchParams.set("fields", "access_token");
  url.searchParams.set("access_token", systemUserToken);

  try {
    const response = await fetch(url.toString(), { method: "GET" });
    const text = await response.text();
    if (!response.ok) {
      console.warn("[webhooks][facebook] page_token_failed", { status: response.status, body: text });
      return null;
    }
    const data = JSON.parse(text) as { access_token?: string | null };
    const token = data.access_token?.trim() ?? null;
    if (token) {
      pageTokenCache.set(pageId, { token, fetchedAt: Date.now() });
    }
    return token;
  } catch (error) {
    console.warn("[webhooks][facebook] page_token_error", { error: String(error) });
    return null;
  }
}

async function fetchSenderName(pageId: string | null, senderId: string | null): Promise<string | null> {
  if (!senderId) return null;

  const { systemUserToken, pageAccessToken } = resolveFacebookToken();
  let accessToken: string | null = pageAccessToken ?? systemUserToken ?? null;

  if (!pageAccessToken && pageId && systemUserToken) {
    const pageToken = await fetchPageAccessToken(pageId, systemUserToken);
    if (pageToken) {
      accessToken = pageToken;
    }
  }

  if (!accessToken) return null;

  const url = new URL(`https://graph.facebook.com/v24.0/${senderId}`);
  url.searchParams.set("fields", "first_name,last_name,name");
  url.searchParams.set("access_token", accessToken);

  try {
    const response = await fetch(url.toString(), { method: "GET" });
    const text = await response.text();
    if (!response.ok) {
      console.warn("[webhooks][facebook] sender_lookup_failed", { status: response.status, body: text });
      return null;
    }
    const data = JSON.parse(text) as { name?: string; first_name?: string; last_name?: string };
    const full = typeof data.name === "string" && data.name.trim().length ? data.name.trim() : null;
    if (full) return full;
    const first = typeof data.first_name === "string" ? data.first_name.trim() : "";
    const last = typeof data.last_name === "string" ? data.last_name.trim() : "";
    const combined = `${first} ${last}`.trim();
    return combined.length ? combined : null;
  } catch (error) {
    console.warn("[webhooks][facebook] sender_lookup_error", { error: String(error) });
    return null;
  }
}

async function fetchLeadgenDetails(
  leadgenId: string,
  accessToken: string
): Promise<FacebookLeadgenDetails> {
  const url = new URL(`https://graph.facebook.com/v24.0/${leadgenId}`);
  url.searchParams.set(
    "fields",
    [
      "created_time",
      "field_data",
      "form_id",
      "ad_id",
      "ad_name",
      "adset_id",
      "adset_name",
      "campaign_id",
      "campaign_name"
    ].join(",")
  );
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString(), { method: "GET" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`leadgen_fetch_failed:${response.status}:${text}`);
  }

  return (await response.json()) as FacebookLeadgenDetails;
}

async function upsertFacebookContact(db: DbExecutor, input: {
  firstName: string;
  lastName: string;
  email: string | null;
  phoneRaw: string | null;
  phoneE164: string | null;
}): Promise<{ id: string }> {
  const email = input.email?.trim().toLowerCase() ?? null;
  const phoneRaw = input.phoneRaw?.trim() ?? null;
  const phoneE164 = input.phoneE164?.trim() ?? null;
  const defaultAssigneeMemberId = await getDefaultSalesAssigneeMemberId(db as any);

  if (phoneE164 && phoneRaw) {
    const contact = await upsertContact(db, {
      firstName: input.firstName,
      lastName: input.lastName,
      email,
      phoneRaw,
      phoneE164,
      source: "facebook_lead"
    });
    return { id: contact.id };
  }

  let contact =
    email
      ? await db
          .select({
            id: contacts.id,
            email: contacts.email,
            phone: contacts.phone,
            phoneE164: contacts.phoneE164,
            salespersonMemberId: contacts.salespersonMemberId
          })
          .from(contacts)
          .where(eq(contacts.email, email))
          .limit(1)
          .then((rows) => rows[0])
      : null;

  if (!contact && phoneRaw) {
    const predicates = [eq(contacts.phone, phoneRaw)];
    if (phoneE164) {
      predicates.push(eq(contacts.phoneE164, phoneE164));
    }
    contact = await db
      .select({
        id: contacts.id,
        email: contacts.email,
        phone: contacts.phone,
        phoneE164: contacts.phoneE164,
        salespersonMemberId: contacts.salespersonMemberId
      })
      .from(contacts)
      .where(or(...predicates))
      .limit(1)
      .then((rows) => rows[0]);
  }

  if (contact?.id) {
    const updatePayload: Record<string, unknown> = {
      firstName: input.firstName,
      lastName: input.lastName,
      updatedAt: new Date()
    };

    if (email && !contact.email) {
      updatePayload["email"] = email;
    }
    if (phoneRaw && !contact.phone) {
      updatePayload["phone"] = phoneRaw;
    }
    if (phoneE164 && !contact.phoneE164) {
      updatePayload["phoneE164"] = phoneE164;
    }
    if (!contact.salespersonMemberId) {
      updatePayload["salespersonMemberId"] = defaultAssigneeMemberId;
    }

    await db.update(contacts).set(updatePayload).where(eq(contacts.id, contact.id));
    return { id: contact.id };
  }

  const [created] = await db
    .insert(contacts)
    .values({
      firstName: input.firstName,
      lastName: input.lastName,
      email,
      phone: phoneRaw ?? null,
      phoneE164: phoneE164 ?? null,
      salespersonMemberId: defaultAssigneeMemberId,
      source: "facebook_lead"
    })
    .onConflictDoNothing()
    .returning({ id: contacts.id });

  if (created?.id) {
    return { id: created.id };
  }

  if (email) {
    const existing = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, email))
      .limit(1)
      .then((rows) => rows[0]);
    if (existing?.id) return existing;
  }

  if (phoneE164) {
    const existing = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.phoneE164, phoneE164))
      .limit(1)
      .then((rows) => rows[0]);
    if (existing?.id) return existing;
  }

  if (phoneRaw) {
    const existing = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.phone, phoneRaw))
      .limit(1)
      .then((rows) => rows[0]);
    if (existing?.id) return existing;
  }

  throw new Error("facebook_contact_failed");
}

async function recordLeadFromFacebook(input: {
  leadgenId: string;
  formId: string | null;
  pageId: string | null;
  details: FacebookLeadgenDetails;
}): Promise<{ leadId: string; duplicate: boolean }> {
  const db = getDb();
  const now = new Date();

  return await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(sql`(${leads.formPayload} ->> 'leadgenId') = ${input.leadgenId}`)
      .limit(1);

    if (existing[0]?.id) {
      return { leadId: existing[0].id, duplicate: true };
    }

    const fieldMap = buildFieldMap(input.details.field_data);
    const standardKeys = new Set([
      "full_name",
      "first_name",
      "last_name",
      "name",
      "email",
      "email_address",
      "phone_number",
      "phone",
      "mobile_phone",
      "street_address",
      "address",
      "city",
      "state",
      "zip",
      "zip_code",
      "postal_code"
    ]);
    const customAnswers = buildCustomAnswers(input.details.field_data, standardKeys);

    const fullName =
      firstFieldValue(fieldMap, ["full_name", "name"]) ??
      [firstFieldValue(fieldMap, ["first_name"]), firstFieldValue(fieldMap, ["last_name"])]
        .filter(Boolean)
        .join(" ")
        .trim();
    const firstName = firstFieldValue(fieldMap, ["first_name"]);
    const lastName = firstFieldValue(fieldMap, ["last_name"]);
    const resolvedName = normalizeName(fullName || "Stonegate Customer");
    const resolvedFirstName = firstName || resolvedName.firstName;
    const resolvedLastName = lastName || resolvedName.lastName;

    const email = firstFieldValue(fieldMap, ["email", "email_address"]);
    const rawPhone = firstFieldValue(fieldMap, ["phone_number", "phone", "mobile_phone"]);
    let normalizedPhone: ReturnType<typeof normalizePhone> | null = null;
    if (rawPhone) {
      try {
        normalizedPhone = normalizePhone(rawPhone);
      } catch {
        normalizedPhone = null;
      }
    }

    const contact = await upsertFacebookContact(tx, {
      firstName: resolvedFirstName,
      lastName: resolvedLastName,
      email: email ?? null,
      phoneRaw: normalizedPhone?.raw ?? rawPhone ?? null,
      phoneE164: normalizedPhone?.e164 ?? null
    });

    const addressLine1 = firstFieldValue(fieldMap, ["street_address", "address"]);
    const city = firstFieldValue(fieldMap, ["city"]);
    const state = firstFieldValue(fieldMap, ["state"]);
    const postalCode = firstFieldValue(fieldMap, ["zip", "zip_code", "postal_code"]);

    const hasFullAddress = Boolean(addressLine1 && city && state && postalCode);
    const placeholderId = input.leadgenId.slice(-6);
    const property = await upsertProperty(tx, {
      contactId: contact.id,
      addressLine1: hasFullAddress
        ? addressLine1 ?? ""
        : `[FB Lead ${placeholderId}] Address pending`,
      city: hasFullAddress ? city ?? DEFAULT_PLACEHOLDER_CITY : DEFAULT_PLACEHOLDER_CITY,
      state: hasFullAddress ? state ?? DEFAULT_PLACEHOLDER_STATE : DEFAULT_PLACEHOLDER_STATE,
      postalCode: hasFullAddress ? postalCode ?? DEFAULT_PLACEHOLDER_POSTAL : DEFAULT_PLACEHOLDER_POSTAL,
      gated: false
    });

    const notes =
      Object.keys(customAnswers).length > 0
        ? Object.entries(customAnswers)
            .map(([question, answers]) => `${question}: ${answers.join(", ")}`)
            .join("\n")
        : null;

    const [lead] = await tx
      .insert(leads)
      .values({
        contactId: contact.id,
        propertyId: property.id,
        servicesRequested: DEFAULT_SERVICES,
        notes,
        status: "new",
        source: "facebook_lead",
        formPayload: {
          source: "facebook_lead",
          leadgenId: input.leadgenId,
          formId: input.formId,
          pageId: input.pageId,
          createdTime: input.details.created_time ?? null,
          adId: input.details.ad_id ?? null,
          adName: input.details.ad_name ?? null,
          adsetId: input.details.adset_id ?? null,
          adsetName: input.details.adset_name ?? null,
          campaignId: input.details.campaign_id ?? null,
          campaignName: input.details.campaign_name ?? null,
          fieldData: fieldMap,
          customAnswers
        },
        createdAt: now,
        updatedAt: now
      })
      .returning({ id: leads.id });

    if (!lead?.id) {
      throw new Error("facebook_lead_create_failed");
    }

    await tx.insert(outboxEvents).values({
      type: "lead.alert",
      payload: {
        leadId: lead.id,
        source: "facebook_lead"
      }
    });

    await tx.insert(outboxEvents).values({
      type: "lead.created",
      payload: {
        leadId: lead.id,
        services: DEFAULT_SERVICES,
        appointmentType: "web_lead",
        source: "facebook_lead",
        notes
      }
    });

    await tx.insert(outboxEvents).values({
      type: "meta.lead_event",
      payload: {
        leadId: lead.id,
        eventName: "Lead"
      }
    });

    return { leadId: lead.id, duplicate: false };
  });
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

  let processed = 0;
  let skipped = 0;
  let errors = 0;
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
        const text = typeof message.text === "string" ? message.text : "";
        const mediaUrls = getMediaUrls(message);
        const senderName = await fetchSenderName(entry.id ?? null, senderId);

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
            senderName: senderName ?? null,
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
        continue;
      }

      if (postback) {
        const payload = typeof postback.payload === "string" ? postback.payload : null;
        const title = typeof postback.title === "string" ? postback.title : null;
        const referral =
          postback.referral && typeof postback.referral === "object" ? postback.referral : null;
        const senderName = await fetchSenderName(entry.id ?? null, senderId);
        const body = payload
          ? `Postback: ${payload}`
          : title
            ? `Postback: ${title}`
            : "Postback received";

        try {
          await recordInboundMessage({
            channel: "dm",
            body,
            subject: null,
            fromAddress: senderId,
            toAddress: recipientId,
            provider: "facebook",
            providerMessageId: null,
            receivedAt,
            senderName: senderName ?? null,
            metadata: {
              source: "facebook",
              type: "postback",
              pageId: entry.id ?? null,
              senderId,
              recipientId,
              payload,
              title,
              referral
            }
          });
          processed += 1;
        } catch (error) {
          errors += 1;
          console.warn("[webhooks][facebook] postback_failed", { error: String(error) });
        }
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

      const accessToken = process.env["FB_LEADGEN_ACCESS_TOKEN"];
      if (!accessToken) {
        console.warn("[webhooks][facebook] leadgen_missing_token");
        skipped += 1;
        continue;
      }

      try {
        const details = await fetchLeadgenDetails(leadgenId, accessToken);
        const result = await recordLeadFromFacebook({
          leadgenId,
          formId,
          pageId: entry.id ?? null,
          details
        });
        if (!result.duplicate) {
          processed += 1;
          console.info("[webhooks][facebook] leadgen_recorded", {
            leadId: result.leadId,
            leadgenId,
            formId
          });
        } else {
          skipped += 1;
        }
      } catch (error) {
        errors += 1;
        console.warn("[webhooks][facebook] leadgen_failed", { error: String(error), leadgenId });
      }
    }
  }

  return NextResponse.json({ ok: true, processed, skipped, errors });
}

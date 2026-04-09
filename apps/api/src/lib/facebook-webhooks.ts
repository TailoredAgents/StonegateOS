import { eq, or, sql } from "drizzle-orm";
import { getDb, contacts, leads, outboxEvents } from "@/db";
import { getDefaultSalesAssigneeMemberId } from "@/lib/sales-scorecard";
import { normalizeName, normalizePhone } from "../../app/api/web/utils";
import { upsertContact, upsertProperty } from "../../app/api/web/persistence";

const DEFAULT_SERVICES = ["junk_removal_primary"];
const DEFAULT_PLACEHOLDER_CITY = "Unknown";
const DEFAULT_PLACEHOLDER_STATE = "NA";
const DEFAULT_PLACEHOLDER_POSTAL = "00000";
const PAGE_TOKEN_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const pageTokenCache = new Map<string, { token: string; fetchedAt: number }>();

type FacebookResponseDiagnostics = {
  fbTraceId: string | null;
  fbDebug: string | null;
  wwwAuthenticate: string | null;
};

export type FacebookLeadgenField = {
  name?: string;
  values?: string[];
};

export type FacebookLeadgenDetails = {
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

function resolveFacebookToken(): { systemUserToken: string | null; pageAccessToken: string | null } {
  const pageAccessToken = process.env["FB_PAGE_ACCESS_TOKEN"] ?? null;
  const systemUserToken =
    process.env["FB_MESSENGER_ACCESS_TOKEN"] ??
    process.env["FB_MARKETING_ACCESS_TOKEN"] ??
    process.env["FB_LEADGEN_ACCESS_TOKEN"] ??
    null;
  return {
    systemUserToken: systemUserToken && systemUserToken.trim().length > 0 ? systemUserToken.trim() : null,
    pageAccessToken: pageAccessToken && pageAccessToken.trim().length > 0 ? pageAccessToken.trim() : null
  };
}

function readConfiguredFacebookPageId(): string | null {
  const value = process.env["FB_PAGE_ID"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readConfiguredFacebookAppSecret(): string | null {
  const value = process.env["FB_APP_SECRET"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getFacebookResponseDiagnostics(response: Response): FacebookResponseDiagnostics {
  return {
    fbTraceId: response.headers.get("x-fb-trace-id"),
    fbDebug: response.headers.get("x-fb-debug"),
    wwwAuthenticate: response.headers.get("www-authenticate")
  };
}

type FacebookGraphGetResult = {
  ok: boolean;
  status: number;
  text: string;
  json: unknown | null;
  diagnostics: FacebookResponseDiagnostics;
};

async function runFacebookGraphGet(url: URL): Promise<FacebookGraphGetResult> {
  const response = await fetch(url.toString(), { method: "GET" });
  const text = await response.text();
  let json: unknown | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    text,
    json,
    diagnostics: getFacebookResponseDiagnostics(response)
  };
}

export async function fetchFacebookPageAccessToken(pageId: string, systemUserToken: string): Promise<string | null> {
  const cached = pageTokenCache.get(pageId);
  if (cached && Date.now() - cached.fetchedAt < PAGE_TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }

  const url = new URL(`https://graph.facebook.com/v24.0/${pageId}`);
  url.searchParams.set("fields", "access_token");
  url.searchParams.set("access_token", systemUserToken);

  try {
    const result = await runFacebookGraphGet(url);
    if (!result.ok) {
      console.warn("[facebook] page_token_failed", {
        status: result.status,
        pageId,
        body: result.text,
        ...result.diagnostics
      });
      return null;
    }
    const data = (result.json ?? null) as { access_token?: string | null } | null;
    const token = data.access_token?.trim() ?? null;
    if (token) {
      pageTokenCache.set(pageId, { token, fetchedAt: Date.now() });
    }
    return token;
  } catch (error) {
    console.warn("[facebook] page_token_error", { error: String(error) });
    return null;
  }
}

export async function resolveFacebookPageAccessToken(pageId: string | null): Promise<string | null> {
  const resolvedPageId = pageId?.trim() || readConfiguredFacebookPageId();
  const { systemUserToken, pageAccessToken } = resolveFacebookToken();
  if (pageAccessToken) {
    return pageAccessToken;
  }
  if (!resolvedPageId || !systemUserToken) {
    return systemUserToken ?? null;
  }
  return await fetchFacebookPageAccessToken(resolvedPageId, systemUserToken);
}

export async function fetchFacebookSenderName(pageId: string | null, senderId: string | null): Promise<string | null> {
  if (!senderId) return null;
  const resolvedPageId = pageId?.trim() || readConfiguredFacebookPageId();

  const accessToken = await resolveFacebookPageAccessToken(resolvedPageId);
  if (!accessToken) return null;

  const url = new URL(`https://graph.facebook.com/v24.0/${senderId}`);
  url.searchParams.set("fields", "first_name,last_name,name");
  url.searchParams.set("access_token", accessToken);

  try {
    const result = await runFacebookGraphGet(url);
    if (!result.ok) {
      console.warn("[facebook] sender_lookup_failed", {
        status: result.status,
        pageId: resolvedPageId,
        senderId,
        body: result.text,
        ...result.diagnostics
      });
      return null;
    }
    const data = (result.json ?? null) as { name?: string; first_name?: string; last_name?: string } | null;
    const full = typeof data.name === "string" && data.name.trim().length ? data.name.trim() : null;
    if (full) return full;
    const first = typeof data.first_name === "string" ? data.first_name.trim() : "";
    const last = typeof data.last_name === "string" ? data.last_name.trim() : "";
    const combined = `${first} ${last}`.trim();
    return combined.length ? combined : null;
  } catch (error) {
    console.warn("[facebook] sender_lookup_error", { pageId: resolvedPageId, senderId, error: String(error) });
    return null;
  }
}

export async function diagnoseFacebookMessengerLookup(input: {
  senderId: string;
  pageId?: string | null;
  appId?: string | null;
}): Promise<Record<string, unknown>> {
  const resolvedPageId = input.pageId?.trim() || readConfiguredFacebookPageId();
  const { systemUserToken, pageAccessToken } = resolveFacebookToken();
  const appSecret = readConfiguredFacebookAppSecret();
  const appId = input.appId?.trim() || null;

  const result: Record<string, unknown> = {
    pageId: resolvedPageId,
    senderId: input.senderId,
    tokenSource: pageAccessToken ? "page_access_token" : systemUserToken ? "system_user_token" : "missing",
    env: {
      hasSystemUserToken: Boolean(systemUserToken),
      hasPageAccessToken: Boolean(pageAccessToken),
      hasAppSecret: Boolean(appSecret),
      hasAppId: Boolean(appId)
    }
  };

  if (systemUserToken && appSecret && appId) {
    const debugUrl = new URL("https://graph.facebook.com/debug_token");
    debugUrl.searchParams.set("input_token", systemUserToken);
    debugUrl.searchParams.set("access_token", `${appId}|${appSecret}`);
    try {
      const debugResult = await runFacebookGraphGet(debugUrl);
      result["systemTokenDebug"] = {
        ok: debugResult.ok,
        status: debugResult.status,
        body: debugResult.json ?? debugResult.text,
        ...debugResult.diagnostics
      };
    } catch (error) {
      result["systemTokenDebug"] = {
        ok: false,
        error: String(error)
      };
    }
  }

  let effectivePageToken: string | null = pageAccessToken;
  if (!effectivePageToken && resolvedPageId && systemUserToken) {
    const pageTokenUrl = new URL(`https://graph.facebook.com/v24.0/${resolvedPageId}`);
    pageTokenUrl.searchParams.set("fields", "id,name,access_token");
    pageTokenUrl.searchParams.set("access_token", systemUserToken);
    const pageTokenResult = await runFacebookGraphGet(pageTokenUrl);
    const pageTokenBody =
      pageTokenResult.json && typeof pageTokenResult.json === "object"
        ? (pageTokenResult.json as Record<string, unknown>)
        : null;
    effectivePageToken =
      typeof pageTokenBody?.["access_token"] === "string" && pageTokenBody["access_token"].trim().length > 0
        ? pageTokenBody["access_token"].trim()
        : null;

    result["pageTokenFetch"] = {
      ok: pageTokenResult.ok,
      status: pageTokenResult.status,
      pageTokenResolved: Boolean(effectivePageToken),
      body:
        pageTokenBody && typeof pageTokenBody["access_token"] === "string"
          ? { ...pageTokenBody, access_token: "[redacted]" }
          : pageTokenResult.json ?? pageTokenResult.text,
      ...pageTokenResult.diagnostics
    };
  }

  if (!effectivePageToken) {
    result["senderLookup"] = {
      ok: false,
      error: "page_access_token_unavailable"
    };
    return result;
  }

  if (resolvedPageId) {
    const pageInspectUrl = new URL(`https://graph.facebook.com/v24.0/${resolvedPageId}`);
    pageInspectUrl.searchParams.set("fields", "id,name");
    pageInspectUrl.searchParams.set("access_token", effectivePageToken);
    const pageInspectResult = await runFacebookGraphGet(pageInspectUrl);
    result["pageInspect"] = {
      ok: pageInspectResult.ok,
      status: pageInspectResult.status,
      body: pageInspectResult.json ?? pageInspectResult.text,
      ...pageInspectResult.diagnostics
    };

    const subscribedAppsUrl = new URL(`https://graph.facebook.com/v24.0/${resolvedPageId}/subscribed_apps`);
    subscribedAppsUrl.searchParams.set("access_token", effectivePageToken);
    const subscribedAppsResult = await runFacebookGraphGet(subscribedAppsUrl);
    result["pageSubscribedApps"] = {
      ok: subscribedAppsResult.ok,
      status: subscribedAppsResult.status,
      body: subscribedAppsResult.json ?? subscribedAppsResult.text,
      ...subscribedAppsResult.diagnostics
    };
  }

  const senderLookupUrl = new URL(`https://graph.facebook.com/v24.0/${input.senderId}`);
  senderLookupUrl.searchParams.set("fields", "id,name,first_name,last_name");
  senderLookupUrl.searchParams.set("access_token", effectivePageToken);
  const senderLookupResult = await runFacebookGraphGet(senderLookupUrl);
  result["senderLookup"] = {
    ok: senderLookupResult.ok,
    status: senderLookupResult.status,
    body: senderLookupResult.json ?? senderLookupResult.text,
    ...senderLookupResult.diagnostics
  };

  return result;
}

export async function fetchFacebookLeadgenDetails(
  leadgenId: string,
  options?: { pageId?: string | null; accessToken?: string | null }
): Promise<FacebookLeadgenDetails> {
  const accessToken = options?.accessToken?.trim() || (await resolveFacebookPageAccessToken(options?.pageId ?? null));
  if (!accessToken) {
    throw new Error("facebook_access_token_missing");
  }

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

export async function recordLeadFromFacebook(input: {
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

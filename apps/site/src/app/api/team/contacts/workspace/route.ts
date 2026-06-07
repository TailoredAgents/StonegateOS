import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamRole } from "@/app/api/team/auth";
import { callAdminApi } from "@/app/team/lib/api";
import type {
  CustomerWorkspace,
  CustomerWorkspaceAppointment,
  CustomerWorkspaceContact,
  CustomerWorkspaceMissingField,
  CustomerWorkspaceProperty,
  CustomerWorkspaceQuote,
} from "@/app/team/lib/customer-workspace";

export const dynamic = "force-dynamic";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function mapProperty(value: unknown): CustomerWorkspaceProperty | null {
  const item = record(value);
  const id = text(item?.["id"]);
  const addressLine1 = text(item?.["addressLine1"]);
  const city = text(item?.["city"]);
  const state = text(item?.["state"]);
  const postalCode = text(item?.["postalCode"]);
  if (!id || !addressLine1 || !city || !state || !postalCode) return null;
  return {
    id,
    addressLine1,
    addressLine2: text(item?.["addressLine2"]),
    city,
    state,
    postalCode,
  };
}

function mapContact(value: unknown): {
  contact: CustomerWorkspaceContact;
  properties: CustomerWorkspaceProperty[];
} | null {
  const item = record(value);
  const id = text(item?.["id"]);
  if (!id) return null;

  const propertiesRaw = Array.isArray(item?.["properties"])
    ? (item?.["properties"] as unknown[])
    : [];
  const properties = propertiesRaw
    .map(mapProperty)
    .filter((property): property is CustomerWorkspaceProperty => Boolean(property));

  const pipeline = record(item?.["pipeline"]);
  const stats = record(item?.["stats"]);
  const firstName = text(item?.["firstName"]) ?? "";
  const lastName = text(item?.["lastName"]) ?? "";
  const name =
    text(item?.["name"]) ??
    `${firstName} ${lastName}`.trim() ??
    "Unknown contact";

  return {
    contact: {
      id,
      name,
      firstName,
      lastName,
      email: text(item?.["email"]),
      phone: text(item?.["phone"]),
      phoneE164: text(item?.["phoneE164"]),
      salespersonMemberId: text(item?.["salespersonMemberId"]),
      pipeline: {
        stage: text(pipeline?.["stage"]),
        notes: text(pipeline?.["notes"]),
      },
      stats: {
        appointments: numberOrNull(stats?.["appointments"]) ?? 0,
        quotes: numberOrNull(stats?.["quotes"]) ?? 0,
      },
      notesCount: numberOrNull(item?.["notesCount"]) ?? 0,
      remindersCount: numberOrNull(item?.["remindersCount"]) ?? 0,
      lastActivityAt: text(item?.["lastActivityAt"]),
    },
    properties,
  };
}

function propertyFromAppointment(value: unknown): CustomerWorkspaceProperty | null {
  return mapProperty(value);
}

function mapAppointment(value: unknown): CustomerWorkspaceAppointment | null {
  const item = record(value);
  const id = text(item?.["id"]);
  if (!id) return null;
  return {
    id,
    status: text(item?.["status"]),
    startAt: text(item?.["startAt"]),
    durationMinutes: numberOrNull(item?.["durationMinutes"]),
    travelBufferMinutes: numberOrNull(item?.["travelBufferMinutes"]),
    appointmentType: text(item?.["appointmentType"]),
    rescheduleToken: text(item?.["rescheduleToken"]),
    property: propertyFromAppointment(item?.["property"]),
  };
}

function quoteBelongsToContact(quote: Record<string, unknown>, contact: CustomerWorkspaceContact): boolean {
  const contactRecord = record(quote["contact"]);
  const quoteContactId = text(quote["contactId"]) ?? text(contactRecord?.["id"]);
  if (quoteContactId && quoteContactId === contact.id) return true;

  const quoteEmail = text(contactRecord?.["email"]);
  if (quoteEmail && contact.email && quoteEmail.toLowerCase() === contact.email.toLowerCase()) return true;

  const quoteName = text(contactRecord?.["name"]);
  return Boolean(quoteName && quoteName === contact.name);
}

function mapQuote(value: unknown, contact: CustomerWorkspaceContact): CustomerWorkspaceQuote | null {
  const item = record(value);
  const id = text(item?.["id"]);
  if (!item) return null;
  if (!id || !quoteBelongsToContact(item, contact)) return null;
  const property = record(item?.["property"]);
  return {
    id,
    status: text(item?.["status"]) ?? "unknown",
    displayStatus: text(item?.["displayStatus"]),
    quoteNumber: text(item?.["quoteNumber"]),
    total: numberOrNull(item?.["total"]),
    shareToken: text(item?.["shareToken"]),
    createdAt: text(item?.["createdAt"]),
    updatedAt: text(item?.["updatedAt"]),
    sentAt: text(item?.["sentAt"]),
    property:
      property &&
      text(property["addressLine1"]) &&
      text(property["city"]) &&
      text(property["state"]) &&
      text(property["postalCode"])
        ? {
            addressLine1: text(property["addressLine1"]) ?? "",
            city: text(property["city"]) ?? "",
            state: text(property["state"]) ?? "",
            postalCode: text(property["postalCode"]) ?? "",
          }
        : null,
  };
}

function computeMissingFields(
  contact: CustomerWorkspaceContact,
  properties: CustomerWorkspaceProperty[],
): CustomerWorkspaceMissingField[] {
  const missing: CustomerWorkspaceMissingField[] = [];
  if (!contact.name || contact.name === "Unknown contact") missing.push("name");
  if (!contact.phone && !contact.phoneE164 && !contact.email) missing.push("phone_or_email");
  if (properties.length === 0) missing.push("address");
  return missing;
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireTeamRole(request, {
    roles: ["owner", "office", "crew"],
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const contactId = request.nextUrl.searchParams.get("contactId")?.trim() ?? "";
  if (!contactId) {
    return NextResponse.json({ ok: false, message: "Missing contact id." }, { status: 400 });
  }

  const contactRes = await callAdminApi(
    `/api/admin/contacts?contactId=${encodeURIComponent(contactId)}&limit=1`,
  ).catch(() => null);
  if (!contactRes?.ok) {
    return NextResponse.json(
      { ok: false, message: "Unable to load contact workspace." },
      { status: contactRes?.status ?? 502 },
    );
  }

  const contactPayload = (await contactRes.json().catch(() => null)) as unknown;
  const contactsRaw = record(contactPayload)?.["contacts"];
  const contactRaw: unknown = Array.isArray(contactsRaw)
    ? contactsRaw[0]
    : record(contactPayload)?.["contact"];
  const mappedContact = mapContact(contactRaw);
  if (!mappedContact) {
    return NextResponse.json({ ok: false, message: "Contact not found." }, { status: 404 });
  }

  const [appointmentsRes, quotesRes] = await Promise.all([
    callAdminApi(
      `/api/appointments?status=${encodeURIComponent("confirmed,requested")}&contactId=${encodeURIComponent(contactId)}&limit=25`,
    ).catch(() => null),
    callAdminApi("/api/quotes").catch(() => null),
  ]);

  let upcomingAppointments: CustomerWorkspaceAppointment[] = [];
  if (appointmentsRes?.ok) {
    const payload = (await appointmentsRes.json().catch(() => null)) as unknown;
    const itemsRaw = record(payload)?.["data"] ?? record(payload)?.["appointments"];
    const now = Date.now();
    upcomingAppointments = (Array.isArray(itemsRaw) ? itemsRaw : [])
      .map(mapAppointment)
      .filter((appointment): appointment is CustomerWorkspaceAppointment => Boolean(appointment))
      .filter((appointment) => {
        if (!appointment.startAt) return true;
        const parsed = Date.parse(appointment.startAt);
        return Number.isNaN(parsed) || parsed >= now;
      })
      .sort((a, b) => Date.parse(a.startAt ?? "") - Date.parse(b.startAt ?? ""))
      .slice(0, 8);
  }

  let quotes: CustomerWorkspaceQuote[] = [];
  if (quotesRes?.ok) {
    const payload = (await quotesRes.json().catch(() => null)) as unknown;
    const itemsRaw = record(payload)?.["quotes"];
    quotes = (Array.isArray(itemsRaw) ? itemsRaw : [])
      .map((quote) => mapQuote(quote, mappedContact.contact))
      .filter((quote): quote is CustomerWorkspaceQuote => Boolean(quote))
      .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? "") - Date.parse(a.updatedAt ?? a.createdAt ?? ""))
      .slice(0, 8);
  }

  const missingFields = computeMissingFields(mappedContact.contact, mappedContact.properties);
  const recommendedIntent =
    missingFields.length > 0
      ? "missing_info"
      : upcomingAppointments.length > 0
        ? "reschedule"
        : "booking";

  const workspace: CustomerWorkspace = {
    ok: true,
    contact: mappedContact.contact,
    properties: mappedContact.properties,
    upcomingAppointments,
    quotes,
    missingFields,
    recommendedIntent,
  };

  return NextResponse.json(workspace, {
    headers: { "cache-control": "no-store" },
  });
}

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb, properties } from "@/db";
import { requirePartnerSession } from "@/lib/partner-portal-auth";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requirePartnerSession(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: properties.id,
      addressLine1: properties.addressLine1,
      addressLine2: properties.addressLine2,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
      gated: properties.gated,
      createdAt: properties.createdAt,
      updatedAt: properties.updatedAt
    })
    .from(properties)
    .where(eq(properties.contactId, auth.partnerUser.orgContactId))
    .orderBy(asc(properties.addressLine1));

  return NextResponse.json({
    ok: true,
    properties: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    }))
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requirePartnerSession(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const addressLine1 = readString(payload?.["addressLine1"]);
  const addressLine2 = readString(payload?.["addressLine2"]) || null;
  const city = readString(payload?.["city"]);
  const state = readString(payload?.["state"]).toUpperCase();
  const postalCode = readString(payload?.["postalCode"]);
  const gated = typeof payload?.["gated"] === "boolean" ? payload["gated"] : false;

  if (!addressLine1 || !city || !state || !postalCode) {
    return NextResponse.json({ ok: false, error: "missing_required_fields" }, { status: 400 });
  }

  if (state.length !== 2) {
    return NextResponse.json({ ok: false, error: "invalid_state" }, { status: 400 });
  }

  const db = getDb();
  const [created] = await db
    .insert(properties)
    .values({
      contactId: auth.partnerUser.orgContactId,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      gated,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    .returning({
      id: properties.id,
      addressLine1: properties.addressLine1,
      addressLine2: properties.addressLine2,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
      gated: properties.gated,
      createdAt: properties.createdAt,
      updatedAt: properties.updatedAt
    });

  if (!created) {
    return NextResponse.json({ ok: false, error: "create_failed" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    property: {
      ...created,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString()
    }
  });
}


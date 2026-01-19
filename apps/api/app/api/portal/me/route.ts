import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { contacts, getDb } from "@/db";
import { requirePartnerSession } from "@/lib/partner-portal-auth";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requirePartnerSession(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = getDb();
  const [org] = await db
    .select({
      id: contacts.id,
      company: contacts.company,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      partnerStatus: contacts.partnerStatus,
      partnerType: contacts.partnerType
    })
    .from(contacts)
    .where(eq(contacts.id, auth.partnerUser.orgContactId))
    .limit(1);

  return NextResponse.json({
    ok: true,
    partnerUser: auth.partnerUser,
    org: org ?? null
  });
}


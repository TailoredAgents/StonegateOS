import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { contacts, getDb, partnerUsers } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { createPartnerLoginToken, normalizeEmail, resolvePublicSiteBaseUrl } from "@/lib/partner-portal-auth";
import { sendEmailMessage } from "@/lib/messaging";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "policy.write");
  if (permissionError) return permissionError;

  const url = new URL(request.url);
  const orgContactId = url.searchParams.get("orgContactId")?.trim() ?? "";
  if (!orgContactId) {
    return NextResponse.json({ error: "orgContactId_required" }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: partnerUsers.id,
      orgContactId: partnerUsers.orgContactId,
      email: partnerUsers.email,
      name: partnerUsers.name,
      active: partnerUsers.active,
      passwordSetAt: partnerUsers.passwordSetAt,
      createdAt: partnerUsers.createdAt,
      updatedAt: partnerUsers.updatedAt
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.orgContactId, orgContactId));

  return NextResponse.json({
    ok: true,
    users: rows.map((row) => ({
      ...row,
      passwordSetAt: row.passwordSetAt ? row.passwordSetAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    }))
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "policy.write");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const orgContactId = readString(payload?.["orgContactId"]);
  const email = normalizeEmail(payload?.["email"]);
  const name = readString(payload?.["name"]);

  if (!orgContactId || !email || !name) {
    return NextResponse.json({ ok: false, error: "missing_required_fields" }, { status: 400 });
  }

  const db = getDb();
  const [org] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.id, orgContactId))
    .limit(1);
  if (!org?.id) {
    return NextResponse.json({ ok: false, error: "org_not_found" }, { status: 404 });
  }

  const now = new Date();
  let userId: string | null = null;

  const [existing] = await db
    .select({ id: partnerUsers.id, orgContactId: partnerUsers.orgContactId })
    .from(partnerUsers)
    .where(eq(partnerUsers.email, email))
    .limit(1);

  if (existing?.id) {
    if (existing.orgContactId !== orgContactId) {
      return NextResponse.json({ ok: false, error: "email_already_used_by_other_partner" }, { status: 409 });
    }
    userId = existing.id;
  } else {
    const [created] = await db
      .insert(partnerUsers)
      .values({
        orgContactId,
        email,
        name,
        active: true,
        createdAt: now,
        updatedAt: now
      })
      .returning({ id: partnerUsers.id });
    userId = created?.id ?? null;
  }

  if (!userId) {
    return NextResponse.json({ ok: false, error: "create_failed" }, { status: 500 });
  }

  const siteBaseUrl = resolvePublicSiteBaseUrl();
  if (siteBaseUrl) {
    try {
      const { rawToken, expiresAt } = await createPartnerLoginToken(userId, request, 30);
      const url = new URL("/partners/auth", siteBaseUrl);
      url.searchParams.set("token", rawToken);

      const subject = "You’ve been invited to the Stonegate Partner Portal";
      const body = [
        `Hi ${name},`,
        "",
        "You now have access to the Stonegate Partner Portal to request and schedule service.",
        "",
        "Use this link to log in (expires in ~30 minutes):",
        url.toString(),
        "",
        `Expires at: ${expiresAt.toISOString()}`,
        "",
        "After login, you can optionally set a password for faster sign-in next time."
      ].join("\n");

      await sendEmailMessage(email, subject, body);
    } catch {
      // ignore
    }
  }

  const [user] = await db
    .select({
      id: partnerUsers.id,
      orgContactId: partnerUsers.orgContactId,
      email: partnerUsers.email,
      name: partnerUsers.name,
      active: partnerUsers.active,
      createdAt: partnerUsers.createdAt
    })
    .from(partnerUsers)
    .where(and(eq(partnerUsers.id, userId), eq(partnerUsers.orgContactId, orgContactId)))
    .limit(1);

  return NextResponse.json({
    ok: true,
    user: user
      ? {
          ...user,
          createdAt: user.createdAt.toISOString()
        }
      : null
  });
}


import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sendEmailMessage, sendSmsMessage } from "@/lib/messaging";
import { crmPipeline, crmTasks, contacts, getDb } from "@/db";
import { desc, eq, or, sql } from "drizzle-orm";
import {
  createPartnerLoginToken,
  findActivePartnerUserByEmail,
  findActivePartnerUserByPhone,
  normalizeEmail,
  normalizePhoneE164,
  getClientIp,
  resolvePublicSiteBaseUrl
} from "@/lib/partner-portal-auth";

export async function POST(request: NextRequest): Promise<Response> {
  const payload = (await request.json().catch(() => null)) as { email?: unknown; phone?: unknown } | null;

  const email = normalizeEmail(payload?.email);
  const phoneE164 = normalizePhoneE164(payload?.phone);
  if (!email && !phoneE164) {
    return NextResponse.json({ ok: false, error: "email_or_phone_required" }, { status: 400 });
  }

  const siteBaseUrl = resolvePublicSiteBaseUrl();
  const user = email
    ? await findActivePartnerUserByEmail(email)
    : phoneE164
      ? await findActivePartnerUserByPhone(phoneE164)
      : null;

  const alertSales = async () => {
    const alertTo = (process.env["LEAD_ALERT_SMS"] ?? "").trim();
    if (!alertTo) return;

    const who = email ?? phoneE164 ?? "unknown";
    const ip = getClientIp(request);
    const message = [
      "Partner portal access request",
      `From: ${who}`,
      ip ? `IP: ${ip}` : null,
      "Invite them in Team -> Partners when ready."
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    await sendSmsMessage(alertTo, message).catch(() => null);
  };

  const upsertAccessRequestTask = async () => {
    const db = getDb();

    const [existingContact] = await db
      .select({
        id: contacts.id,
        partnerStatus: contacts.partnerStatus
      })
      .from(contacts)
      .where(
        or(
          email ? eq(contacts.email, email) : sql`false`,
          phoneE164 ? eq(contacts.phoneE164, phoneE164) : sql`false`
        )
      )
      .limit(1);

    const now = new Date();
    const contactId = existingContact?.id
      ? existingContact.id
      : (
          await db
            .insert(contacts)
            .values({
              firstName: "Partner",
              lastName: "Request",
              email: email ?? null,
              phone: phoneE164 ?? null,
              phoneE164: phoneE164 ?? null,
              partnerStatus: "prospect",
              source: "partner_portal"
            })
            .returning({ id: contacts.id })
        )[0]?.id ?? null;

    if (!contactId) return;

    if (!existingContact?.id || existingContact.partnerStatus === "none") {
      await db
        .update(contacts)
        .set({
          partnerStatus: "prospect",
          updatedAt: now
        })
        .where(eq(contacts.id, contactId));
    }

    // Bump the pipeline stage into "contacted" if they're requesting portal access.
    await db
      .insert(crmPipeline)
      .values({ contactId, stage: "contacted", notes: "Partner portal access requested." })
      .onConflictDoUpdate({
        target: crmPipeline.contactId,
        set: {
          stage: "contacted",
          updatedAt: now
        }
      });

    // Avoid spamming tasks if someone clicks repeatedly.
    const [existingTask] = await db
      .select({ id: crmTasks.id, createdAt: crmTasks.createdAt, title: crmTasks.title })
      .from(crmTasks)
      .where(eq(crmTasks.contactId, contactId))
      .orderBy(desc(crmTasks.createdAt))
      .limit(1);

    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const isRecentDuplicate =
      Boolean(existingTask?.id) &&
      existingTask.title === "Partner portal access request" &&
      existingTask.createdAt >= oneDayAgo;
    if (isRecentDuplicate) return;

    await db.insert(crmTasks).values({
      contactId,
      title: "Partner portal access request",
      status: "open",
      dueAt: null,
      assignedTo: null,
      notes: `Requested via /partners/login. Email: ${email ?? "-"} Phone: ${phoneE164 ?? "-"}`,
      createdAt: now,
      updatedAt: now
    });
  };

  if (user?.id && siteBaseUrl) {
    try {
      const { rawToken, expiresAt } = await createPartnerLoginToken(user.id, request, 30);
      const url = new URL("/partners/auth", siteBaseUrl);
      url.searchParams.set("token", rawToken);

      const subject = "Your Stonegate Partner Portal login link";
      const body = [
        `Hi ${user.name},`,
        "",
        "Here's your secure login link for the Stonegate Partner Portal:",
        url.toString(),
        "",
        `This link expires at ${expiresAt.toISOString()}.`,
        "",
        "If you didn't request this, you can ignore this email."
      ].join("\n");

      const smsBody = `Stonegate Partner Portal login link: ${url.toString()} (expires ${expiresAt.toISOString()})`;

      await Promise.allSettled([
        sendEmailMessage(user.email, subject, body),
        user.phoneE164 ? sendSmsMessage(user.phoneE164, smsBody) : Promise.resolve()
      ]);
    } catch {
      // Intentionally ignore to avoid leaking whether an account exists.
    }
  } else {
    // Not invited (or SITE_URL misconfigured). Create an internal task so the team can invite them quickly,
    // and send a generic acknowledgement to reduce confusion.
    await Promise.allSettled([
      upsertAccessRequestTask(),
      alertSales(),
      email ? sendEmailMessage(email, "Stonegate Partner Portal request received", "Thanks! If you're invited, you'll receive a login link shortly. If not, we'll reach out to get you set up.") : Promise.resolve(),
      phoneE164 ? sendSmsMessage(phoneE164, "Stonegate: request received. If you're invited, you'll get a login link shortly. If not, we'll reach out to get you set up.") : Promise.resolve()
    ]);
  }

  // Always return ok to avoid account enumeration.
  return NextResponse.json({ ok: true });
}

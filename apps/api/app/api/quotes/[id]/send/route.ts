import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, quotes, outboxEvents } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../../../web/admin";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { resolvePublicSiteBaseUrlOrThrow } from "@/lib/public-site-url";

const SendQuoteSchema = z.object({
  expiresInDays: z.number().int().min(1).max(120).optional(),
  shareBaseUrl: z.string().url().optional()
});

function buildShareUrl(token: string, baseUrl?: string): string {
  // Safety: never generate localhost/0.0.0.0 links in production. If an unsafe base
  // is provided, ignore it and fall back to the configured public site base URL.
  const configuredBase = resolvePublicSiteBaseUrlOrThrow();
  if (baseUrl) {
    const candidate = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
    try {
      const parsed = new URL(candidate);
      if (parsed.origin === configuredBase) {
        return new URL(`/quote/${token}`, parsed.origin).toString();
      }
    } catch {
      // ignore
    }
  }
  return new URL(`/quote/${token}`, configuredBase).toString();
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const parsedBody = SendQuoteSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsedBody.error.flatten() },
      { status: 400 }
    );
  }

  const actor = getAuditActorFromRequest(request);
  const db = getDb();
  const rows = await db
    .select({
      id: quotes.id,
      status: quotes.status,
      shareToken: quotes.shareToken,
      contactId: quotes.contactId
    })
    .from(quotes)
    .where(eq(quotes.id, id))
    .limit(1);

  const existing = rows[0];
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (existing.status === "accepted" || existing.status === "declined") {
    return NextResponse.json(
      { error: "quote_finalized", message: "Quote is already finalized." },
      { status: 400 }
    );
  }

  const shareToken = existing.shareToken ?? nanoid(24);
  const expiresAt = parsedBody.data.expiresInDays
    ? new Date(Date.now() + parsedBody.data.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const [updated] = await db
    .update(quotes)
    .set({
      shareToken,
      sentAt: new Date(),
      expiresAt,
      status: "sent",
      updatedAt: new Date()
    })
    .where(eq(quotes.id, id))
    .returning({
      id: quotes.id,
      shareToken: quotes.shareToken,
      sentAt: quotes.sentAt,
      expiresAt: quotes.expiresAt
    });
  if (!updated) {
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  await db.insert(outboxEvents).values({
    type: "quote.sent",
    payload: {
      quoteId: updated.id,
      contactId: existing.contactId,
      shareToken
    }
  });

  await recordAuditEvent({
    actor,
    action: "quote.sent",
    entityType: "quote",
    entityId: updated.id,
    meta: {
      contactId: existing.contactId,
      shareToken,
      expiresAt: expiresAt ? expiresAt.toISOString() : null
    }
  });

  const shareUrl = buildShareUrl(shareToken, parsedBody.data.shareBaseUrl);

  return NextResponse.json({
    ok: true,
    quoteId: updated.id,
    shareToken,
    shareUrl,
    sentAt: updated.sentAt ? updated.sentAt.toISOString() : null,
    expiresAt: updated.expiresAt ? updated.expiresAt.toISOString() : null
  });
}


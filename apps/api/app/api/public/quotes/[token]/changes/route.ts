import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, outboxEvents, quoteChangeRequests, quotes } from "@/db";
import { eq } from "drizzle-orm";

const ChangeRequestSchema = z.object({
  reason: z.enum([
    "Scope changed",
    "Price question",
    "Timing issue",
    "Address issue",
    "Need to add/remove items",
    "Other",
  ]),
  message: z.string().max(1500).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const parsed = ChangeRequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const db = getDb();
  const [quote] = await db
    .select({
      id: quotes.id,
      contactId: quotes.contactId,
    })
    .from(quotes)
    .where(eq(quotes.shareToken, token))
    .limit(1);

  if (!quote?.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const message = parsed.data.message?.trim() || null;
  const [created] = await db
    .insert(quoteChangeRequests)
    .values({
      quoteId: quote.id,
      reason: parsed.data.reason,
      message,
    })
    .returning({
      id: quoteChangeRequests.id,
      createdAt: quoteChangeRequests.createdAt,
    });

  await db.insert(outboxEvents).values({
    type: "quote.change_requested",
    payload: {
      quoteId: quote.id,
      contactId: quote.contactId,
      reason: parsed.data.reason,
      message,
      changeRequestId: created?.id ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    changeRequestId: created?.id ?? null,
    createdAt: created?.createdAt?.toISOString() ?? new Date().toISOString(),
  });
}

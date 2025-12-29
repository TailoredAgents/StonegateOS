import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, quotes, outboxEvents } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../../../web/admin";
import { eq } from "drizzle-orm";

const AdminDecisionSchema = z.object({
  decision: z.enum(["accepted", "declined"]),
  notes: z.string().max(2000).optional()
});

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

  const parsedBody = AdminDecisionSchema.safeParse(await request.json());
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
      status: quotes.status
    })
    .from(quotes)
    .where(eq(quotes.id, id))
    .limit(1);

  const existing = rows[0];
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (existing.status === parsedBody.data.decision) {
    return NextResponse.json({
      ok: true,
      quoteId: existing.id,
      status: existing.status,
      message: "Quote already in requested status."
    });
  }

  const decisionAt = new Date();
  const [updated] = await db
    .update(quotes)
    .set({
      status: parsedBody.data.decision,
      decisionAt,
      decisionNotes: parsedBody.data.notes ?? null,
      updatedAt: decisionAt
    })
    .where(eq(quotes.id, id))
    .returning({
      id: quotes.id,
      status: quotes.status,
      decisionAt: quotes.decisionAt,
      decisionNotes: quotes.decisionNotes
    });
  if (!updated) {
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  await db.insert(outboxEvents).values({
    type: "quote.decision",
    payload: {
      quoteId: updated.id,
      decision: parsedBody.data.decision,
      source: "admin",
      notes: parsedBody.data.notes ?? null
    }
  });

  await recordAuditEvent({
    actor,
    action: "quote.decision",
    entityType: "quote",
    entityId: updated.id,
    meta: {
      decision: parsedBody.data.decision,
      notes: parsedBody.data.notes ?? null
    }
  });

  return NextResponse.json({
    ok: true,
    quoteId: updated.id,
    status: updated.status,
    decisionAt: updated.decisionAt ? updated.decisionAt.toISOString() : null,
    decisionNotes: updated.decisionNotes
  });
}

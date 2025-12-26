import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, mergeSuggestions } from "@/db";
import { mergeContacts } from "@/lib/merge-queue";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../../../web/admin";

const ACTIONS = ["approve", "decline"] as const;
type Action = (typeof ACTIONS)[number];

function isAction(value: string | null): value is Action {
  return value ? (ACTIONS as readonly string[]).includes(value) : false;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ suggestionId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { suggestionId } = await context.params;
  if (!suggestionId) {
    return NextResponse.json({ error: "suggestion_id_required" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as { action?: string } | null;
  if (!payload || typeof payload.action !== "string" || !isAction(payload.action)) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const db = getDb();
  const [suggestion] = await db
    .select({
      id: mergeSuggestions.id,
      status: mergeSuggestions.status,
      sourceContactId: mergeSuggestions.sourceContactId,
      targetContactId: mergeSuggestions.targetContactId
    })
    .from(mergeSuggestions)
    .where(eq(mergeSuggestions.id, suggestionId))
    .limit(1);

  if (!suggestion) {
    return NextResponse.json({ error: "suggestion_not_found" }, { status: 404 });
  }

  if (suggestion.status !== "pending") {
    return NextResponse.json({ error: "suggestion_already_resolved" }, { status: 409 });
  }

  const actor = getAuditActorFromRequest(request);
  const now = new Date();

  if (payload.action === "decline") {
    await db
      .update(mergeSuggestions)
      .set({
        status: "declined",
        reviewedBy: actor.id ?? null,
        reviewedAt: now,
        updatedAt: now
      })
      .where(eq(mergeSuggestions.id, suggestionId));

    await recordAuditEvent({
      actor,
      action: "merge.suggestion.declined",
      entityType: "merge_suggestion",
      entityId: suggestionId,
      meta: {
        sourceContactId: suggestion.sourceContactId,
        targetContactId: suggestion.targetContactId
      }
    });

    return NextResponse.json({ ok: true, status: "declined" });
  }

  await db
    .update(mergeSuggestions)
    .set({
      status: "approved",
      reviewedBy: actor.id ?? null,
      reviewedAt: now,
      updatedAt: now
    })
    .where(eq(mergeSuggestions.id, suggestionId));

  let mergeResult: Awaited<ReturnType<typeof mergeContacts>>;
  try {
    mergeResult = await mergeContacts({
      sourceContactId: suggestion.sourceContactId,
      targetContactId: suggestion.targetContactId
    });
  } catch (error) {
    await db
      .update(mergeSuggestions)
      .set({
        status: "pending",
        reviewedBy: null,
        reviewedAt: null,
        updatedAt: new Date()
      })
      .where(eq(mergeSuggestions.id, suggestionId));

    const message = error instanceof Error ? error.message : "merge_failed";
    const status = message === "contact_not_found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }

  await recordAuditEvent({
    actor,
    action: "contact.merged",
    entityType: "contact",
    entityId: suggestion.targetContactId,
    meta: {
      sourceContactId: suggestion.sourceContactId,
      suggestionId,
      moved: mergeResult.moved,
      updatedFields: mergeResult.updatedFields
    }
  });

  return NextResponse.json({ ok: true, status: "approved" });
}

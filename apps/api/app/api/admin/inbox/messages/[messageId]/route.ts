import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { getDb, conversationMessages, conversationThreads } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ messageId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  const { messageId } = await context.params;
  if (!messageId) {
    return NextResponse.json({ error: "message_id_required" }, { status: 400 });
  }

  const db = getDb();
  try {
    await db.transaction(async (tx) => {
      const [message] = await tx
        .select({
          id: conversationMessages.id,
          threadId: conversationMessages.threadId
        })
        .from(conversationMessages)
        .where(eq(conversationMessages.id, messageId))
        .limit(1);

      if (!message) {
        throw new Error("not_found");
      }

      await tx.delete(conversationMessages).where(eq(conversationMessages.id, messageId));

      const [latest] = await tx
        .select({
          body: conversationMessages.body,
          createdAt: conversationMessages.createdAt,
          sentAt: conversationMessages.sentAt,
          receivedAt: conversationMessages.receivedAt
        })
        .from(conversationMessages)
        .where(eq(conversationMessages.threadId, message.threadId))
        .orderBy(
          desc(sql`coalesce(${conversationMessages.sentAt}, ${conversationMessages.receivedAt}, ${conversationMessages.createdAt})`),
          desc(conversationMessages.createdAt)
        )
        .limit(1);

      const preview = latest?.body ? latest.body.slice(0, 140) : null;
      const lastAt = latest?.sentAt ?? latest?.receivedAt ?? latest?.createdAt ?? null;

      await tx
        .update(conversationThreads)
        .set({
          lastMessagePreview: preview,
          lastMessageAt: lastAt,
          updatedAt: new Date()
        })
        .where(eq(conversationThreads.id, message.threadId));
    });
  } catch (error) {
    const message = error instanceof Error && error.message === "not_found" ? "message_not_found" : "delete_failed";
    return NextResponse.json({ error: message }, { status: message === "message_not_found" ? 404 : 500 });
  }

  return NextResponse.json({ ok: true });
}

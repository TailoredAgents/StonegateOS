import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { asc, desc, inArray, sql } from "drizzle-orm";
import { conversationMessages, conversationThreads, getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";

export const dynamic = "force-dynamic";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;

const OUTBOUND_EXPORT_STATUSES = new Set(["sent", "delivered"]);

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function readDraftFlag(metadata: Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  return metadata["draft"] === true;
}

function shouldExportMessage(message: {
  direction: string;
  deliveryStatus: string;
  metadata: Record<string, unknown> | null;
}): boolean {
  if (message.direction === "internal") return false;
  if (message.direction === "outbound") {
    if (readDraftFlag(message.metadata)) return false;
    if (!OUTBOUND_EXPORT_STATUSES.has(message.deliveryStatus)) return false;
  }
  return true;
}

function roleForDirection(direction: string): "user" | "assistant" | null {
  if (direction === "inbound") return "user";
  if (direction === "outbound") return "assistant";
  return null;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.read");
  if (permissionError) return permissionError;

  const batchSize = parsePositiveInt(request.nextUrl.searchParams.get("batch"), DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);

  const db = getDb();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          let offset = 0;
          while (true) {
            const threads = await db
              .select({ id: conversationThreads.id })
              .from(conversationThreads)
              .orderBy(desc(conversationThreads.lastMessageAt), desc(conversationThreads.updatedAt))
              .limit(batchSize)
              .offset(offset);

            if (threads.length === 0) break;
            offset += threads.length;

            const threadIds = threads.map((row) => row.id);
            const rows = await db
              .select({
                threadId: conversationMessages.threadId,
                direction: conversationMessages.direction,
                body: conversationMessages.body,
                deliveryStatus: conversationMessages.deliveryStatus,
                metadata: conversationMessages.metadata
              })
              .from(conversationMessages)
              .where(inArray(conversationMessages.threadId, threadIds))
              .orderBy(
                asc(conversationMessages.threadId),
                asc(sql`coalesce(${conversationMessages.sentAt}, ${conversationMessages.receivedAt}, ${conversationMessages.createdAt})`),
                asc(conversationMessages.createdAt)
              );

            const byThread = new Map<string, typeof rows>();
            for (const row of rows) {
              const bucket = byThread.get(row.threadId);
              if (bucket) {
                bucket.push(row);
              } else {
                byThread.set(row.threadId, [row]);
              }
            }

            for (const threadId of threadIds) {
              const messages = byThread.get(threadId) ?? [];
              const exported = messages
                .filter((message) => shouldExportMessage(message))
                .map((message) => {
                  const role = roleForDirection(message.direction);
                  return role ? { role, content: message.body } : null;
                })
                .filter((value): value is { role: "user" | "assistant"; content: string } => Boolean(value));

              if (exported.length === 0) continue;

              controller.enqueue(encoder.encode(`${JSON.stringify({ messages: exported })}\n`));
            }
          }

          controller.close();
        } catch (error) {
          controller.error(error);
        }
      })();
    }
  });

  const now = new Date();
  const filename = `stonegate-conversations-${now.toISOString().slice(0, 10)}.jsonl`;

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename=\"${filename}\"`,
      "Cache-Control": "no-store"
    }
  });
}

import { and, eq, inArray } from "drizzle-orm";
import { conversationMessages, getDb } from "@/db";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor =
  Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
    ? Tx
    : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

export function isMessengerLeadCardBody(body: string): boolean {
  const text = body.toLowerCase();
  const markers = ["phone number:", "email:", "zip code:", "first name:", "when do you want it gone?:"];
  const hitCount = markers.reduce((count, marker) => (text.includes(marker) ? count + 1 : count), 0);
  return hitCount >= 3;
}

function isMeaningfulInboundDmBody(body: string | null | undefined): boolean {
  const trimmed = typeof body === "string" ? body.trim() : "";
  return trimmed.length > 0 && !isMessengerLeadCardBody(trimmed);
}

export async function getDmLiveAutopilotStates(
  db: DbExecutor,
  threadIds: string[],
): Promise<Map<string, { ready: boolean; meaningfulInboundCount: number }>> {
  const uniqueThreadIds = [...new Set(threadIds.filter((value) => typeof value === "string" && value.trim().length > 0))];
  const result = new Map<string, { ready: boolean; meaningfulInboundCount: number }>();
  if (uniqueThreadIds.length === 0) return result;

  const rows = await db
    .select({
      threadId: conversationMessages.threadId,
      body: conversationMessages.body,
    })
    .from(conversationMessages)
    .where(
      and(
        inArray(conversationMessages.threadId, uniqueThreadIds),
        eq(conversationMessages.channel, "dm"),
        eq(conversationMessages.direction, "inbound"),
      ),
    );

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isMeaningfulInboundDmBody(row.body)) continue;
    counts.set(row.threadId, (counts.get(row.threadId) ?? 0) + 1);
  }

  for (const threadId of uniqueThreadIds) {
    const meaningfulInboundCount = counts.get(threadId) ?? 0;
    result.set(threadId, {
      ready: meaningfulInboundCount >= 2,
      meaningfulInboundCount,
    });
  }

  return result;
}

export async function getDmLiveAutopilotState(
  db: DbExecutor,
  threadId: string,
): Promise<{ ready: boolean; meaningfulInboundCount: number }> {
  const states = await getDmLiveAutopilotStates(db, [threadId]);
  return states.get(threadId) ?? { ready: false, meaningfulInboundCount: 0 };
}

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  getDb
} from "@/db";
import { recordAuditEvent, getAuditActorFromRequest } from "@/lib/audit";
import { fetchFacebookSenderName } from "@/lib/facebook-webhooks";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";

type CandidateRow = {
  contactId: string;
  threadId: string;
  firstName: string;
  lastName: string;
};

function normalizeName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const firstName = parts.shift() ?? "Unknown";
  const lastName = parts.join(" ");
  return { firstName, lastName };
}

function isMessengerFallbackName(firstName: string, lastName: string): boolean {
  return firstName.trim().toLowerCase() === "messenger" && /^\d+$/.test(lastName.trim());
}

function isBackfillableContactName(firstName: string | null | undefined, lastName: string | null | undefined): boolean {
  const first = typeof firstName === "string" ? firstName.trim() : "";
  const last = typeof lastName === "string" ? lastName.trim() : "";
  const combined = `${first} ${last}`.trim().toLowerCase();
  if (!combined) return true;
  if (combined === "unknown contact") return true;
  return isMessengerFallbackName(first, last);
}

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function findLatestInboundFacebookMessage(contactId: string): Promise<{
  senderId: string | null;
  pageId: string | null;
} | null> {
  const db = getDb();
  const [row] = await db
    .select({
      fromAddress: conversationMessages.fromAddress,
      toAddress: conversationMessages.toAddress,
      metadata: conversationMessages.metadata
    })
    .from(conversationMessages)
    .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
    .where(
      and(
        eq(conversationThreads.contactId, contactId),
        eq(conversationThreads.channel, "dm"),
        eq(conversationMessages.channel, "dm"),
        eq(conversationMessages.direction, "inbound"),
        eq(conversationMessages.provider, "facebook")
      )
    )
    .orderBy(desc(conversationMessages.receivedAt), desc(conversationMessages.createdAt))
    .limit(1);

  if (!row) return null;
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : null;

  return {
    senderId: readMetadataString(metadata, "senderId") ?? row.fromAddress ?? null,
    pageId: readMetadataString(metadata, "pageId") ?? row.toAddress ?? null
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  let rawBody: unknown = {};
  try {
    rawBody = await request.json();
  } catch {
    rawBody = {};
  }

  const body = rawBody && typeof rawBody === "object" ? (rawBody as Record<string, unknown>) : {};
  const limitInput = body["limit"];
  const dryRun = body["dryRun"] === true;
  const contactIdFilter = typeof body["contactId"] === "string" ? body["contactId"].trim() : "";

  const limit = typeof limitInput === "number" && limitInput > 0 ? Math.min(limitInput, 100) : 25;
  const db = getDb();

  const candidateRows = await db
    .select({
      contactId: contacts.id,
      threadId: conversationThreads.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName
    })
    .from(conversationParticipants)
    .innerJoin(conversationThreads, eq(conversationParticipants.threadId, conversationThreads.id))
    .innerJoin(contacts, eq(conversationParticipants.contactId, contacts.id))
    .where(
      and(
        eq(conversationThreads.channel, "dm"),
        eq(conversationParticipants.participantType, "contact"),
        isNotNull(conversationParticipants.contactId),
        contactIdFilter ? eq(contacts.id, contactIdFilter) : undefined
      )
    )
    .orderBy(desc(conversationThreads.updatedAt))
    .limit(limit * 4);

  const candidates: CandidateRow[] = [];
  const seen = new Set<string>();
  for (const row of candidateRows) {
    if (seen.has(row.contactId)) continue;
    if (!isBackfillableContactName(row.firstName, row.lastName)) continue;
    seen.add(row.contactId);
    candidates.push(row);
    if (candidates.length >= limit) break;
  }

  let updated = 0;
  let missingMessage = 0;
  let unresolved = 0;
  const updates: Array<{ contactId: string; threadId: string; name: string }> = [];

  for (const candidate of candidates) {
    const latest = await findLatestInboundFacebookMessage(candidate.contactId);
    if (!latest?.senderId) {
      missingMessage += 1;
      continue;
    }

    const senderName = await fetchFacebookSenderName(latest.pageId, latest.senderId);
    if (!senderName || !senderName.trim()) {
      unresolved += 1;
      continue;
    }

    const normalized = normalizeName(senderName);
    const displayName = [normalized.firstName, normalized.lastName].filter(Boolean).join(" ").trim();
    updates.push({
      contactId: candidate.contactId,
      threadId: candidate.threadId,
      name: displayName
    });

    if (dryRun) {
      updated += 1;
      continue;
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(contacts)
        .set({
          firstName: normalized.firstName,
          lastName: normalized.lastName,
          updatedAt: now
        })
        .where(eq(contacts.id, candidate.contactId));

      await tx
        .update(conversationParticipants)
        .set({ displayName })
        .where(
          and(
            eq(conversationParticipants.participantType, "contact"),
            eq(conversationParticipants.contactId, candidate.contactId)
          )
        );
    });

    updated += 1;
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "facebook.dm.name_backfill",
    entityType: "conversation_thread",
    entityId: updates[0]?.threadId ?? null,
    meta: {
      dryRun,
      requestedLimit: limit,
      contactIdFilter: contactIdFilter || null,
      candidates: candidates.length,
      updated,
      missingMessage,
      unresolved
    }
  });

  return NextResponse.json({
    ok: true,
    dryRun,
    candidates: candidates.length,
    updated,
    missingMessage,
    unresolved,
    updates: updates.slice(0, 20)
  });
}

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  conversationThreads,
  conversationMessages,
  conversationParticipants,
  contacts,
  outboxEvents,
} from "@/db";
import { requirePermission } from "@/lib/permissions";
import { requireActiveContactForDirectOutbound } from "@/lib/contact-outbound-safety";
import { genericInboxThreadScopeCondition } from "@/lib/inbox-staff-scope";
import {
  TeamMutationFailure,
  beginTeamMutation,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
  type TeamMutationContext,
} from "@/lib/team-mutation";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import { isAdminRequest } from "../../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { completeNextFollowupTaskOnTouch } from "@/lib/sales-followups";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import { sendStaffPartnerJobMessage } from "@/lib/partner-job-communication";
import { z } from "zod";

const CHANNELS = ["sms", "email", "dm", "call", "web"] as const;
const DIRECTIONS = ["inbound", "outbound", "internal"] as const;

type Channel = (typeof CHANNELS)[number];
type Direction = (typeof DIRECTIONS)[number];

function isChannel(value: string | null): value is Channel {
  return value ? (CHANNELS as readonly string[]).includes(value) : false;
}

function isDirection(value: string | null): value is Direction {
  return value ? (DIRECTIONS as readonly string[]).includes(value) : false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type InboxMessageResponse = {
  message: {
    id: string;
    threadId: string;
    direction: string;
    channel: string;
    deliveryStatus: string;
    createdAt: string;
  };
};

const legacySendErrors = new Map([
  ["thread_not_found", 404],
  ["dnc_confirmation_required", 400],
  ["missing_recipient", 400],
  ["thread_context_mismatch", 409],
]);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ threadId: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  const { threadId } = await context.params;
  if (!z.string().uuid().safeParse(threadId).success) {
    return NextResponse.json({ error: "thread_id_required" }, { status: 400 });
  }

  const payload = (await readBoundedJsonRequest(request, {
    maximumBytes: 64 * 1024,
  }).catch(() => null)) as {
    body?: string;
    subject?: string;
    direction?: string;
    channel?: string;
    mediaUrls?: string[];
    toAddress?: string;
    fromAddress?: string;
    allowDncOverride?: boolean;
    audience?: string;
    attachmentIds?: unknown;
    expectedContactId?: string | null;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const hasExpectedContact = Object.prototype.hasOwnProperty.call(
    payload,
    "expectedContactId",
  );
  if (
    hasExpectedContact &&
    !z.string().uuid().nullable().safeParse(payload.expectedContactId).success
  ) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const subject =
    typeof payload.subject === "string" && payload.subject.trim().length > 0
      ? payload.subject.trim()
      : null;
  const direction = isDirection(payload.direction ?? null)
    ? (payload.direction as Direction)
    : "outbound";
  const channel = isChannel(payload.channel ?? null)
    ? (payload.channel as Channel)
    : null;
  const mediaUrls = Array.isArray(payload.mediaUrls)
    ? payload.mediaUrls.filter(
        (url): url is string =>
          typeof url === "string" && url.trim().length > 0,
      )
    : [];
  const toAddress =
    typeof payload.toAddress === "string" && payload.toAddress.trim().length > 0
      ? payload.toAddress.trim()
      : null;
  const fromAddress =
    typeof payload.fromAddress === "string" &&
    payload.fromAddress.trim().length > 0
      ? payload.fromAddress.trim()
      : null;
  const allowDncOverride = payload.allowDncOverride === true;

  const actor = getAuditActorFromRequest(request);
  const db = getDb();

  const [portalThread] = await db
    .select({
      id: conversationThreads.id,
      jobId: conversationThreads.partnerBookingId,
      channel: conversationThreads.channel,
      contactId: conversationThreads.contactId,
    })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.id, threadId),
        eq(conversationThreads.portalVisible, true),
        genericInboxThreadScopeCondition(),
      ),
    )
    .limit(1);
  if (portalThread?.jobId) {
    if (
      hasExpectedContact &&
      (payload.expectedContactId !== null ||
        portalThread.contactId !== null ||
        channel !== "web" ||
        portalThread.channel !== "web")
    ) {
      return NextResponse.json(
        { error: "thread_context_mismatch" },
        { status: 409 },
      );
    }
    const parsed = z
      .object({
        audience: z.enum(["partner", "internal"]),
        body: z.string().trim().min(1).max(5_000),
        attachmentIds: z.array(z.string().uuid()).max(10).default([]),
      })
      .safeParse({
        audience: payload.audience,
        body,
        attachmentIds: payload.attachmentIds,
      });
    if (!parsed.success || mediaUrls.length || toAddress || fromAddress)
      return NextResponse.json(
        {
          error: "invalid_fields",
          message:
            "Choose Reply to partner or Internal note and use files belonging to this job.",
        },
        { status: 422 },
      );
    const boundary = await beginTeamMutation(
      request,
      {
        principalTypes: ["human"],
        requiredPermissions: ["messages.send", "partners.accounts.read"],
        risk: parsed.data.audience === "partner" ? "external" : "normal",
        requiresIdempotency: true,
        auditAction: "partner.job_message.staff_created",
      },
      parsed.data.audience === "internal"
        ? { ignoredPermissionKillSwitches: ["external_sends"] }
        : {},
    );
    if (!boundary.ok) return boundary.response;
    try {
      const message = await sendStaffPartnerJobMessage({
        threadId,
        ...parsed.data,
        ...(hasExpectedContact
          ? {
              expectedContactId: payload.expectedContactId,
              expectedChannel: channel,
            }
          : {}),
        mutation: boundary.mutation,
      });
      return NextResponse.json(
        { message },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "thread_context_mismatch"
      ) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      return teamMutationExceptionResponse(error, boundary.mutation);
    }
  }

  if (!body && mediaUrls.length === 0) {
    return NextResponse.json({ error: "body_required" }, { status: 400 });
  }

  // Existing callers may omit a key. A supplied key always uses the durable
  // boundary, including validation of malformed/empty keys.
  let mutation: TeamMutationContext | null = null;
  if (request.headers.has("idempotency-key")) {
    const boundary = await beginTeamMutation(request, {
      principalTypes: ["human", "service"],
      requiredPermissions: ["messages.send"],
      risk: direction === "outbound" ? "external" : "normal",
      requiresIdempotency: true,
      auditAction:
        direction === "inbound" ? "message.received" : "message.queued",
    });
    if (!boundary.ok) return boundary.response;
    mutation = {
      ...boundary.mutation,
      // Keep a single key namespace even if a retry changes direction. The
      // established audit writer still records the original action above.
      policy: {
        ...boundary.mutation.policy,
        auditAction: "inbox.message.created",
      },
    };
  }

  let claim: TeamMutationIdempotencyClaim | null = null;
  let result: {
    message: typeof conversationMessages.$inferSelect;
    messageChannel: string;
    contactId: string | null;
    salespersonMemberId: string | null;
    response: InboxMessageResponse;
  };
  try {
    if (mutation) {
      const claimed = await claimTeamMutationIdempotency(db, mutation, {
        route: "POST /api/admin/inbox/threads/:threadId/messages",
        entityType: "conversation_thread",
        entityId: threadId,
        payload,
      });
      if (claimed.kind === "replay") {
        // A saved receipt cannot bypass a thread that has since moved out of
        // the generic Inbox's staff scope.
        const [visibleThread] = await db
          .select({ id: conversationThreads.id })
          .from(conversationThreads)
          .where(
            and(
              eq(conversationThreads.id, threadId),
              genericInboxThreadScopeCondition(),
            ),
          )
          .limit(1);
        if (!visibleThread)
          return NextResponse.json(
            { error: "thread_not_found" },
            { status: 404 },
          );
        const replay = claimed.replay;
        const headers = {
          "Cache-Control": "private, no-store",
          "idempotency-replayed": "true",
          "x-correlation-id": replay.correlationId,
        };
        if (replay.result.ok) {
          return NextResponse.json(replay.result.data as InboxMessageResponse, {
            status: replay.status,
            headers,
          });
        }
        if (legacySendErrors.has(replay.result.message)) {
          return NextResponse.json(
            { error: replay.result.message },
            { status: replay.status, headers },
          );
        }
        return teamMutationResultResponse(
          replay.result,
          replay.status,
          replay.correlationId,
          headers,
        );
      }
      claim = claimed.claim;
    }
    result = await db.transaction(async (tx) => {
      const [thread] = await tx
        .select({
          id: conversationThreads.id,
          channel: conversationThreads.channel,
          contactId: conversationThreads.contactId,
          doNotContact: contacts.doNotContact,
        })
        .from(conversationThreads)
        .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
        .where(
          and(
            eq(conversationThreads.id, threadId),
            genericInboxThreadScopeCondition(),
          ),
        )
        .for("update", { of: conversationThreads })
        .limit(1);

      if (!thread) {
        throw new Error("thread_not_found");
      }
      if (
        hasExpectedContact &&
        (thread.contactId !== payload.expectedContactId ||
          channel !== thread.channel)
      ) {
        throw new Error("thread_context_mismatch");
      }
      if (direction === "outbound" && thread.contactId) {
        await requireActiveContactForDirectOutbound(tx, thread.contactId);
      }
      if (
        direction === "outbound" &&
        thread.doNotContact === true &&
        !allowDncOverride
      ) {
        throw new Error("dnc_confirmation_required");
      }

      const messageChannel = channel ?? thread.channel ?? "sms";
      const now = new Date();

      let participantId: string | null = null;
      let resolvedToAddress: string | null = toAddress;
      let resolvedMetadata: Record<string, unknown> | null = null;
      let salespersonMemberId: string | null = null;

      if (direction === "inbound") {
        const contactParticipant = await tx
          .select({ id: conversationParticipants.id })
          .from(conversationParticipants)
          .where(
            and(
              eq(conversationParticipants.threadId, threadId),
              eq(conversationParticipants.participantType, "contact"),
            ),
          )
          .limit(1);

        if (!contactParticipant[0] && thread.contactId) {
          const [contact] = await tx
            .select({
              id: contacts.id,
              firstName: contacts.firstName,
              lastName: contacts.lastName,
              email: contacts.email,
              phone: contacts.phone,
              phoneE164: contacts.phoneE164,
            })
            .from(contacts)
            .where(eq(contacts.id, thread.contactId))
            .limit(1);

          const displayName = contact
            ? [contact.firstName, contact.lastName]
                .filter(Boolean)
                .join(" ")
                .trim()
            : "Contact";
          const externalAddress =
            messageChannel === "email"
              ? (contact?.email ?? null)
              : messageChannel === "dm"
                ? (fromAddress ?? toAddress ?? null)
                : (contact?.phoneE164 ?? contact?.phone ?? null);

          const [created] = await tx
            .insert(conversationParticipants)
            .values({
              threadId,
              participantType: "contact",
              contactId: contact?.id ?? null,
              displayName: displayName || "Contact",
              externalAddress,
              createdAt: now,
            })
            .returning();
          participantId = created?.id ?? null;
        } else {
          participantId = contactParticipant[0]?.id ?? null;
        }
      } else {
        const teamFilters = [
          eq(conversationParticipants.threadId, threadId),
          eq(conversationParticipants.participantType, "team"),
        ];
        if (actor.id) {
          teamFilters.push(eq(conversationParticipants.teamMemberId, actor.id));
        }

        const existingTeam = await tx
          .select({ id: conversationParticipants.id })
          .from(conversationParticipants)
          .where(and(...teamFilters))
          .limit(1);

        if (existingTeam[0]) {
          participantId = existingTeam[0].id;
        } else {
          const [teamParticipant] = await tx
            .insert(conversationParticipants)
            .values({
              threadId,
              participantType: "team",
              teamMemberId: actor.id ?? null,
              displayName: actor.label ?? "Team Console",
              createdAt: now,
            })
            .returning();
          participantId = teamParticipant?.id ?? null;
        }
      }

      if (direction === "outbound") {
        if (messageChannel === "dm") {
          const [lastInboundDm] = await tx
            .select({
              fromAddress: conversationMessages.fromAddress,
              metadata: conversationMessages.metadata,
            })
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.threadId, threadId),
                eq(conversationMessages.direction, "inbound"),
                eq(conversationMessages.channel, "dm"),
              ),
            )
            .orderBy(desc(conversationMessages.createdAt))
            .limit(1);

          resolvedToAddress =
            resolvedToAddress ?? lastInboundDm?.fromAddress ?? null;
          resolvedMetadata = isRecord(lastInboundDm?.metadata)
            ? lastInboundDm.metadata
            : null;
          resolvedMetadata = resolvedMetadata ?? { source: "facebook" };
        } else {
          const [contact] = thread.contactId
            ? await tx
                .select({
                  email: contacts.email,
                  phone: contacts.phone,
                  phoneE164: contacts.phoneE164,
                  salespersonMemberId: contacts.salespersonMemberId,
                })
                .from(contacts)
                .where(eq(contacts.id, thread.contactId))
                .limit(1)
            : [null];

          salespersonMemberId = contact?.salespersonMemberId ?? null;
          resolvedToAddress =
            resolvedToAddress ??
            (messageChannel === "email"
              ? (contact?.email ?? null)
              : (contact?.phoneE164 ?? contact?.phone ?? null));
        }

        if (!resolvedToAddress) {
          throw new Error("missing_recipient");
        }
        if (resolvedMetadata) {
          // Provider/inbound metadata is never authority to bypass DNC. Only
          // this route's explicit reviewed request can add the narrow flag.
          resolvedMetadata = { ...resolvedMetadata };
          delete resolvedMetadata["allowDncOverride"];
          delete resolvedMetadata["dncOverrideSource"];
          delete resolvedMetadata["dncOverrideActorId"];
        }
        if (allowDncOverride) {
          resolvedMetadata = {
            ...(resolvedMetadata ?? {}),
            allowDncOverride: true,
            dncOverrideSource: "explicit_inbox_send",
            dncOverrideActorId: actor.id ?? null,
          };
        }
      }

      const deliveryStatus =
        direction === "inbound"
          ? "delivered"
          : direction === "internal"
            ? "sent"
            : "queued";

      const [message] = await tx
        .insert(conversationMessages)
        .values({
          threadId,
          participantId,
          direction,
          channel: messageChannel,
          subject,
          body,
          mediaUrls,
          toAddress: resolvedToAddress,
          fromAddress,
          deliveryStatus,
          sentAt: deliveryStatus === "sent" ? now : null,
          receivedAt: direction === "inbound" ? now : null,
          metadata: resolvedMetadata,
          createdAt: now,
        })
        .returning();

      if (!message) {
        throw new Error("message_create_failed");
      }

      await tx
        .update(conversationThreads)
        .set({
          lastMessagePreview: (
            body || (mediaUrls.length ? "Media message" : "")
          ).slice(0, 140),
          lastMessageAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(conversationThreads.id, threadId),
            genericInboxThreadScopeCondition(),
          ),
        );

      if (direction === "outbound") {
        await tx.insert(outboxEvents).values({
          type: "message.send",
          payload: { messageId: message.id },
          createdAt: now,
        });

        if (thread.contactId) {
          await completeNextFollowupTaskOnTouch({
            db: tx,
            contactId: thread.contactId,
            memberId: salespersonMemberId ?? actor.id ?? null,
            now,
          });
        }
      }

      const response: InboxMessageResponse = {
        message: {
          id: message.id,
          threadId: message.threadId,
          direction: message.direction,
          channel: message.channel,
          deliveryStatus: message.deliveryStatus,
          createdAt: message.createdAt.toISOString(),
        },
      };
      if (mutation && claim) {
        const audit = await mutation.audit.insertSuccess(tx, {
          entityType: "conversation_message",
          entityId: message.id,
          metadata: { threadId, channel: messageChannel, direction },
          committedAt: now,
        });
        const receipt = teamMutationSuccessResult(mutation, response, {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "conversation_message",
          entityId: message.id,
        });
        await completeTeamMutationIdempotency(
          tx,
          mutation,
          claim,
          receipt,
          200,
        );
      }

      return {
        message,
        messageChannel,
        contactId: thread.contactId ?? null,
        salespersonMemberId,
        response,
      };
    });
  } catch (error) {
    if (mutation) {
      const legacyStatus =
        error instanceof Error
          ? legacySendErrors.get(error.message)
          : undefined;
      const failure =
        legacyStatus && error instanceof Error
          ? new TeamMutationFailure(
              legacyStatus === 409 ? "conflict" : "invalid",
              error.message,
              {
                status: legacyStatus,
              },
            )
          : error;
      if (claim) {
        try {
          await settleTeamMutationIdempotencyFailure(
            db,
            mutation,
            claim,
            failure,
          );
        } catch {
          // The bounded claim lease still allows safe recovery. Never clear
          // the client key or expose message content in error logging.
          console.error("[inbox-message] idempotency_settlement_failed", {
            operationId: mutation.operationId,
            correlationId: mutation.correlationId,
          });
        }
      }
      if (legacyStatus && error instanceof Error) {
        return NextResponse.json(
          { error: error.message },
          { status: legacyStatus },
        );
      }
      return teamMutationExceptionResponse(failure, mutation);
    }
    if (error instanceof TeamMutationFailure) {
      return teamMutationExceptionResponse(error);
    }
    const message =
      error instanceof Error ? error.message : "message_create_failed";
    const status = legacySendErrors.get(message) ?? 400;
    return NextResponse.json({ error: message }, { status });
  }

  if (!mutation)
    await recordAuditEvent({
      actor,
      action: direction === "inbound" ? "message.received" : "message.queued",
      entityType: "conversation_message",
      entityId: result.message.id,
      meta: { threadId, channel: result.messageChannel, direction },
    });

  return NextResponse.json(
    result.response,
    mutation
      ? {
          headers: {
            "Cache-Control": "private, no-store",
            "x-correlation-id": mutation.correlationId,
          },
        }
      : undefined,
  );
}

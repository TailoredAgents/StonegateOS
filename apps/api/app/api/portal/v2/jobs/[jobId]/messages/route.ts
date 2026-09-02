import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  getDb,
  partnerAccountLocations,
  partnerBookings,
  partnerJobEvents,
} from "@/db";
import {
  hasPartnerCapability,
  requirePartnerCapability,
} from "@/lib/partner-account-authorization";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  arePartnerPortalV2ReadsEnabled,
  arePartnerPortalV2WritesEnabled,
} from "@/lib/partner-portal-feature-flags";
import {
  createPartnerJobAccessCondition,
  createPartnerJobLocationJoinCondition,
  hasPartnerJobAccess,
} from "@/lib/partner-portal-v2-resource-authorization";
import {
  loadReadyPartnerJobMessageAttachments,
  normalizePartnerJobMessageAttachmentIds,
} from "@/lib/partner-portal-v2-media";
import {
  PARTNER_JOB_ISSUE_CATEGORIES,
  PARTNER_JOB_ISSUE_PRIORITIES,
  partnerJobIssueCategoryLabel,
  readPartnerJobIssueMetadata,
} from "@/lib/partner-portal-v2-job-hub";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2ErrorResponse,
  encodePortalV2Cursor,
  parsePortalV2Pagination,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const StandardMessageBodySchema = z
  .object({
    kind: z.literal("message").optional().default("message"),
    body: z.string().trim().min(1).max(5_000),
    attachmentIds: z.array(z.string().uuid()).max(10).default([]),
  })
  .strict();
const IssueMessageBodySchema = z
  .object({
    kind: z.literal("issue"),
    body: z.string().trim().min(10).max(2_000),
    attachmentIds: z.array(z.string().uuid()).max(10).default([]),
    issueCategory: z.enum(PARTNER_JOB_ISSUE_CATEGORIES),
    issuePriority: z.enum(PARTNER_JOB_ISSUE_PRIORITIES),
  })
  .strict();
const MessageBodySchema = z.union([
  IssueMessageBodySchema,
  StandardMessageBodySchema,
]);

type MessageCursor = {
  accountId: string;
  jobId: string;
  threadId: string;
  createdAt: string;
  id: string;
};

function isMessageCursor(value: unknown): value is MessageCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") ===
      "accountId,createdAt,id,jobId,threadId" &&
    ["accountId", "jobId", "threadId", "id"].every(
      (field) =>
        typeof record[field] === "string" && UUID_PATTERN.test(record[field]),
    ) &&
    typeof record["createdAt"] === "string" &&
    Number.isFinite(Date.parse(record["createdAt"]))
  );
}

function descriptorResponse(
  failure: ReturnType<typeof createPortalV2ErrorResponse>,
): Response {
  return NextResponse.json(failure.body, {
    status: failure.status,
    headers: { ...failure.headers, Vary: "Authorization" },
  });
}

async function loadPortalThread(
  accountId: string,
  jobId: string,
): Promise<{ id: string } | null> {
  const [thread] = await getDb()
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.partnerAccountId, accountId),
        eq(conversationThreads.partnerBookingId, jobId),
        eq(conversationThreads.portalVisible, true),
      ),
    )
    .limit(1);
  return thread ?? null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(
    request,
    "messages.read",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { jobId } = await context.params;
  if (!principal.accountId || !UUID_PATTERN.test(jobId)) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  try {
    if (!(await hasPartnerJobAccess(principal, jobId))) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }

  const pagination = parsePortalV2Pagination(request.nextUrl.searchParams, {
    cursorKind: "partner_job_messages",
    validateCursorPayload: isMessageCursor,
    defaultLimit: 50,
    maximumLimit: 100,
    allowedQueryKeys: new Set(),
  });
  if (!pagination.ok) {
    return descriptorResponse(
      createPortalV2ErrorResponse("invalid_cursor", correlationId, {
        fieldErrors: pagination.fieldErrors,
      }),
    );
  }

  try {
    const db = getDb();
    const [job] = await db
      .select({ id: partnerBookings.id })
      .from(partnerBookings)
      .leftJoin(
        partnerAccountLocations,
        createPartnerJobLocationJoinCondition(),
      )
      .where(createPartnerJobAccessCondition(principal, jobId))
      .limit(1);
    if (!job) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const thread = await loadPortalThread(principal.accountId, jobId);
    if (!thread) {
      return createPartnerPortalV2SuccessResponse(
        {
          ok: true,
          thread: null,
          messages: [],
          page: { limit: pagination.limit, nextCursor: null, hasMore: false },
        },
        correlationId,
      );
    }
    if (
      pagination.cursor &&
      (pagination.cursor.payload.accountId !== principal.accountId ||
        pagination.cursor.payload.jobId !== jobId ||
        pagination.cursor.payload.threadId !== thread.id)
    ) {
      return descriptorResponse(
        createPortalV2ErrorResponse("invalid_cursor", correlationId, {
          fieldErrors: {
            cursor: "This message cursor belongs to another job.",
          },
        }),
      );
    }
    const cursorDate = pagination.cursor
      ? new Date(pagination.cursor.payload.createdAt)
      : null;
    const cursorId = pagination.cursor?.payload.id ?? null;
    const rows = await db
      .select({
        id: conversationMessages.id,
        authorType: conversationMessages.authorType,
        direction: conversationMessages.direction,
        channel: conversationMessages.channel,
        body: conversationMessages.body,
        deliveryStatus: conversationMessages.deliveryStatus,
        metadata: conversationMessages.metadata,
        sentAt: conversationMessages.sentAt,
        receivedAt: conversationMessages.receivedAt,
        createdAt: conversationMessages.createdAt,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.threadId, thread.id),
          eq(conversationMessages.portalVisible, true),
          cursorDate && cursorId
            ? or(
                gt(conversationMessages.createdAt, cursorDate),
                and(
                  eq(conversationMessages.createdAt, cursorDate),
                  gt(conversationMessages.id, cursorId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        asc(conversationMessages.createdAt),
        asc(conversationMessages.id),
      )
      .limit(pagination.limit + 1);
    const hasMore = rows.length > pagination.limit;
    const page = hasMore ? rows.slice(0, pagination.limit) : rows;
    const attachmentIdsByMessage = new Map(
      page.map((message) => [
        message.id,
        normalizePartnerJobMessageAttachmentIds(
          message.metadata?.["attachmentIds"],
        ),
      ]),
    );
    const requestedAttachmentIds = [
      ...new Set([...attachmentIdsByMessage.values()].flat()),
    ];
    const resolvedAttachments = hasPartnerCapability(principal, "media.read")
      ? await loadReadyPartnerJobMessageAttachments({
          db,
          accountId: principal.accountId,
          jobId,
          requestedIds: requestedAttachmentIds,
        })
      : [];
    const attachmentById = new Map(
      resolvedAttachments.map((attachment) => [attachment.id, attachment]),
    );
    const last = page.at(-1);
    const nextCursor =
      hasMore && last
        ? encodePortalV2Cursor({
            kind: "partner_job_messages",
            limit: pagination.limit,
            payload: {
              accountId: principal.accountId,
              jobId,
              threadId: thread.id,
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            } satisfies MessageCursor,
          })
        : null;
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        thread: { id: thread.id },
        messages: page.map((message) => {
          const attachments = (
            attachmentIdsByMessage.get(message.id) ?? []
          ).flatMap((id) => {
            const attachment = attachmentById.get(id);
            return attachment ? [attachment] : [];
          });
          const issue = readPartnerJobIssueMetadata(message.metadata);
          return {
            id: message.id,
            kind: issue ? ("issue" as const) : ("message" as const),
            issue,
            authorType: message.authorType,
            direction: message.direction,
            channel: message.channel,
            body: message.body,
            deliveryStatus: message.deliveryStatus,
            attachmentIds: attachments.map((attachment) => attachment.id),
            attachments,
            sentAt: message.sentAt?.toISOString() ?? null,
            receivedAt: message.receivedAt?.toISOString() ?? null,
            createdAt: message.createdAt.toISOString(),
            system: message.authorType === "system",
          };
        }),
        page: { limit: pagination.limit, nextCursor, hasMore },
      },
      correlationId,
    );
  } catch (error) {
    console.error("[partner-portal-v2] messages list failed", {
      correlationId,
      accountId: principal.accountId,
      jobId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "messages.send",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { jobId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !UUID_PATTERN.test(jobId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  try {
    if (!(await hasPartnerJobAccess(principal, jobId))) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
  const idempotency = readPortalV2IdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return createPartnerPortalV2ErrorResponse(
      idempotency.reason === "required"
        ? "idempotency_key_required"
        : "invalid_idempotency_key",
      400,
      correlationId,
    );
  }
  if (!idempotency.keyHash) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_idempotency_key",
      400,
      correlationId,
    );
  }

  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, {
      maximumBytes: 12 * 1024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    const status =
      error instanceof BoundedJsonRequestError ? error.status : 400;
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      status,
      correlationId,
    );
  }
  const parsed = MessageBodySchema.safeParse(body);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  if (
    parsed.data.attachmentIds.length > 0 &&
    !hasPartnerCapability(principal, "media.read")
  ) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const attachmentIds = normalizePartnerJobMessageAttachmentIds(
    parsed.data.attachmentIds,
  );
  const issue =
    parsed.data.kind === "issue"
      ? {
          category: parsed.data.issueCategory,
          categoryLabel: partnerJobIssueCategoryLabel(
            parsed.data.issueCategory,
          ),
          priority: parsed.data.issuePriority,
        }
      : null;

  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        kind: parsed.data.kind,
        body: parsed.data.body,
        attachmentIds: [...attachmentIds].sort(),
        issueCategory: issue?.category ?? null,
        issuePriority: issue?.priority ?? null,
      }),
      "utf8",
    )
    .digest("hex");
  try {
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const [job] = await tx
        .select({
          id: partnerBookings.id,
          orgContactId: partnerBookings.orgContactId,
          propertyId: partnerBookings.propertyId,
          serviceKey: partnerBookings.serviceKey,
        })
        .from(partnerBookings)
        .leftJoin(
          partnerAccountLocations,
          createPartnerJobLocationJoinCondition(),
        )
        .where(createPartnerJobAccessCondition(principal, jobId))
        .for("update", { of: partnerBookings })
        .limit(1);
      if (!job) return { kind: "not_found" as const };

      const attachments = await loadReadyPartnerJobMessageAttachments({
        db: tx,
        accountId: principal.accountId!,
        jobId: job.id,
        requestedIds: attachmentIds,
      });
      if (attachmentIds.length > 0) {
        if (attachments.length !== attachmentIds.length) {
          return { kind: "invalid_attachment" as const };
        }
      }

      let [thread] = await tx
        .select({ id: conversationThreads.id })
        .from(conversationThreads)
        .where(
          and(
            eq(conversationThreads.partnerAccountId, principal.accountId!),
            eq(conversationThreads.partnerBookingId, job.id),
            eq(conversationThreads.portalVisible, true),
          ),
        )
        .for("update")
        .limit(1);
      if (!thread) {
        await tx
          .insert(conversationThreads)
          .values({
            contactId: job.orgContactId,
            propertyId: job.propertyId,
            partnerAccountId: principal.accountId!,
            partnerBookingId: job.id,
            portalVisible: true,
            status: "open",
            state: "booked",
            channel: "web",
            subject: `${job.serviceKey ?? "Service"} job`,
          })
          .onConflictDoNothing();
        [thread] = await tx
          .select({ id: conversationThreads.id })
          .from(conversationThreads)
          .where(
            and(
              eq(conversationThreads.partnerAccountId, principal.accountId!),
              eq(conversationThreads.partnerBookingId, job.id),
              eq(conversationThreads.portalVisible, true),
            ),
          )
          .for("update")
          .limit(1);
      }
      if (!thread) throw new Error("partner_job_thread_missing");

      let [participant] = await tx
        .select({ id: conversationParticipants.id })
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.threadId, thread.id),
            eq(
              conversationParticipants.partnerMembershipId,
              principal.membershipId!,
            ),
          ),
        )
        .limit(1);
      if (!participant) {
        [participant] = await tx
          .insert(conversationParticipants)
          .values({
            threadId: thread.id,
            participantType: "contact",
            contactId: job.orgContactId,
            partnerMembershipId: principal.membershipId,
            externalAddress: principal.email,
            displayName: principal.name,
          })
          .returning({ id: conversationParticipants.id });
      }
      if (!participant) throw new Error("partner_thread_participant_missing");

      const [existing] = await tx
        .select({
          id: conversationMessages.id,
          body: conversationMessages.body,
          metadata: conversationMessages.metadata,
          createdAt: conversationMessages.createdAt,
        })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.threadId, thread.id),
            eq(conversationMessages.idempotencyKeyHash, idempotency.keyHash!),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.metadata?.["requestHash"] !== requestHash) {
          return { kind: "idempotency_conflict" as const };
        }
        return {
          kind: "success" as const,
          replayed: true,
          threadId: thread.id,
          message: existing,
          attachments,
        };
      }

      const now = new Date();
      const [message] = await tx
        .insert(conversationMessages)
        .values({
          threadId: thread.id,
          participantId: participant.id,
          direction: "inbound",
          channel: "web",
          subject: issue
            ? `${issue.priority === "urgent" ? "Urgent " : ""}${issue.categoryLabel}`
            : null,
          body: parsed.data.body,
          deliveryStatus: "delivered",
          portalVisible: true,
          authorType: "partner",
          idempotencyKeyHash: idempotency.keyHash,
          receivedAt: now,
          metadata: {
            requestHash,
            membershipId: principal.membershipId,
            attachmentIds,
            messageKind: issue ? "issue" : "message",
            ...(issue
              ? {
                  issueCategory: issue.category,
                  issuePriority: issue.priority,
                }
              : {}),
          },
        })
        .returning({
          id: conversationMessages.id,
          body: conversationMessages.body,
          metadata: conversationMessages.metadata,
          createdAt: conversationMessages.createdAt,
        });
      if (!message) throw new Error("partner_message_insert_failed");
      const staffPreview = issue
        ? `${issue.priority === "urgent" ? "URGENT " : ""}${issue.categoryLabel}: ${parsed.data.body}`
        : parsed.data.body;
      await tx
        .update(conversationThreads)
        .set({
          lastMessagePreview: staffPreview.slice(0, 280),
          lastMessageAt: now,
          status: "open",
          ...(issue
            ? {
                attentionHandledAt: null,
                attentionHandledBy: null,
                closedReason: null,
                closedAt: null,
                closedBy: null,
              }
            : {}),
          stateUpdatedAt: now,
          updatedAt: now,
        })
        .where(eq(conversationThreads.id, thread.id));
      if (issue) {
        await tx.insert(partnerJobEvents).values({
          partnerAccountId: principal.accountId!,
          partnerBookingId: job.id,
          eventType: "issue_reported",
          publicLabel: "Issue reported",
          publicDetail: `${issue.categoryLabel} · ${
            issue.priority === "urgent" ? "Urgent" : "Standard priority"
          }`,
          effectiveAt: now,
          actorType: "partner",
          actorMembershipId: principal.membershipId,
          metadata: {
            category: issue.category,
            priority: issue.priority,
          },
        });
      }
      const auditId = randomUUID();
      await tx.insert(auditLogs).values({
        id: auditId,
        actorType: "system",
        actorLabel: "partner-portal",
        correlationId,
        outcome: "succeeded",
        surface: "/partners/jobs",
        idempotencyKeyHash: idempotency.keyHash,
        action: issue
          ? "partner.job_issue.reported"
          : "partner.job_message.created",
        entityType: "partner_booking",
        entityId: job.id,
        meta: sanitizeAuditMetadata({
          eventId: auditId,
          correlationId,
          partnerAccountId: principal.accountId,
          partnerMembershipId: principal.membershipId,
          messageId: message.id,
          threadId: thread.id,
          attachmentCount: attachmentIds.length,
          messageKind: issue ? "issue" : "message",
          issueCategory: issue?.category,
          issuePriority: issue?.priority,
        }),
      });
      return {
        kind: "success" as const,
        replayed: false,
        threadId: thread.id,
        message,
        attachments,
      };
    });

    if (result.kind === "not_found") {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    if (result.kind === "invalid_attachment") {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    if (result.kind === "idempotency_conflict") {
      return createPartnerPortalV2ErrorResponse(
        "idempotency_conflict",
        409,
        correlationId,
      );
    }
    return NextResponse.json(
      {
        ok: true,
        correlationId,
        threadId: result.threadId,
        message: {
          id: result.message.id,
          kind: readPartnerJobIssueMetadata(result.message.metadata)
            ? "issue"
            : "message",
          issue: readPartnerJobIssueMetadata(result.message.metadata),
          authorType: "partner",
          direction: "inbound",
          channel: "web",
          body: result.message.body,
          deliveryStatus: "delivered",
          attachmentIds: result.attachments.map((attachment) => attachment.id),
          attachments: result.attachments,
          createdAt: result.message.createdAt.toISOString(),
        },
      },
      {
        status: result.replayed ? 200 : 201,
        headers: {
          "Cache-Control": "no-store",
          "x-correlation-id": correlationId,
          ...(result.replayed ? { "idempotency-replayed": "true" } : {}),
          Vary: "Authorization",
        },
      },
    );
  } catch (error) {
    console.error("[partner-portal-v2] message create failed", {
      correlationId,
      accountId: principal.accountId,
      jobId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

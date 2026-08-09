import type { ActionPolicy } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq, lte, sql } from "drizzle-orm";
import {
  contacts,
  crmPipeline,
  getDb,
  teamInboxNewLeadAcknowledgements,
} from "@/db";
import {
  inboxNewLeadAcknowledgementExpiry,
  inboxNewLeadVersion,
  isInboxNewLeadAcknowledgementActive,
  isInboxNewLeadUuid,
  isNonOutboundInboxLeadSource,
  INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS,
} from "@/lib/inbox-new-lead-acknowledgements";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

type RouteContext = { params: Promise<{ contactId?: string }> };

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["messages.read"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "inbox.new_lead.acknowledged",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  // No member identity is accepted from the path, body, cookie, or headers.
  // The acknowledgement owner is exclusively the verified mutation actor.
  const teamMemberId = mutation.actor.id ?? "";
  if (!isInboxNewLeadUuid(teamMemberId)) {
    return teamMutationErrorResponse(
      "internal",
      "The verified team member is incomplete.",
      { correlationId: mutation.correlationId },
    );
  }

  const { contactId: rawContactId } = await context.params;
  const contactId = rawContactId?.trim() ?? "";
  if (!isInboxNewLeadUuid(contactId)) {
    return teamMutationErrorResponse(
      "invalid",
      "A valid new-lead contact ID is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          contactId: "Refresh the Inbox and select a valid lead.",
        },
      },
    );
  }
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest new-lead version is required before acknowledgement.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the Inbox and try again." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/inbox/new-leads/:contactId/acknowledge",
      entityType: "contact",
      entityId: contactId,
      payload: {
        acknowledgementTtlSeconds: INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS,
      },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      // Match the contact deletion/restore lock, then lock the contact and its
      // pipeline row. A soft-delete or stage transition that wins the race is
      // observed before an acknowledgement can be written.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactId}, 0))`,
      );
      const [contact] = await tx
        .select({
          id: contacts.id,
          source: contacts.source,
          deletedAt: contacts.deletedAt,
          updatedAt: contacts.updatedAt,
        })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .for("update")
        .limit(1);
      const [pipeline] = await tx
        .select({
          contactId: crmPipeline.contactId,
          stage: crmPipeline.stage,
          updatedAt: crmPipeline.updatedAt,
        })
        .from(crmPipeline)
        .where(eq(crmPipeline.contactId, contactId))
        .for("update")
        .limit(1);

      if (
        !contact ||
        contact.deletedAt !== null ||
        !isNonOutboundInboxLeadSource(contact.source) ||
        !pipeline ||
        pipeline.stage !== "new"
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "This contact is no longer an active inbound lead in the New pipeline stage. Refresh the Inbox.",
        );
      }

      const leadVersion = inboxNewLeadVersion({
        contactId,
        contactUpdatedAt: contact.updatedAt,
        pipelineUpdatedAt: pipeline.updatedAt,
      });
      assertTeamMutationExpectedVersion(mutation, leadVersion);

      const acknowledgedAt = new Date();
      const expiresAt = inboxNewLeadAcknowledgementExpiry(acknowledgedAt);
      const [existing] = await tx
        .select()
        .from(teamInboxNewLeadAcknowledgements)
        .where(
          and(
            eq(teamInboxNewLeadAcknowledgements.teamMemberId, teamMemberId),
            eq(teamInboxNewLeadAcknowledgements.contactId, contactId),
          ),
        )
        .for("update")
        .limit(1);

      if (
        existing &&
        isInboxNewLeadAcknowledgementActive(existing.expiresAt, acknowledgedAt)
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "This lead is already acknowledged for your current 24-hour window. Refresh the Inbox.",
        );
      }

      const nextAcknowledgementVersion = (existing?.version ?? 0) + 1;
      const [acknowledgement] = existing
        ? await tx
            .update(teamInboxNewLeadAcknowledgements)
            .set({
              acknowledgedAt,
              expiresAt,
              version: nextAcknowledgementVersion,
              updatedAt: acknowledgedAt,
            })
            .where(
              and(
                eq(teamInboxNewLeadAcknowledgements.id, existing.id),
                eq(teamInboxNewLeadAcknowledgements.version, existing.version),
                lte(teamInboxNewLeadAcknowledgements.expiresAt, acknowledgedAt),
              ),
            )
            .returning({
              id: teamInboxNewLeadAcknowledgements.id,
              version: teamInboxNewLeadAcknowledgements.version,
            })
        : await tx
            .insert(teamInboxNewLeadAcknowledgements)
            .values({
              teamMemberId,
              contactId,
              acknowledgedAt,
              expiresAt,
              version: nextAcknowledgementVersion,
              createdAt: acknowledgedAt,
              updatedAt: acknowledgedAt,
            })
            .returning({
              id: teamInboxNewLeadAcknowledgements.id,
              version: teamInboxNewLeadAcknowledgements.version,
            });

      if (!acknowledgement?.id) {
        throw new TeamMutationFailure(
          "conflict",
          "The acknowledgement changed concurrently. Refresh the Inbox and try again.",
          { retryable: true },
        );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "inbox_new_lead_acknowledgement",
        entityId: acknowledgement.id,
        before: existing
          ? {
              contactId,
              acknowledgedAt: existing.acknowledgedAt.toISOString(),
              expiresAt: existing.expiresAt.toISOString(),
              version: existing.version,
            }
          : null,
        after: {
          contactId,
          acknowledgedAt: acknowledgedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          version: acknowledgement.version,
        },
        metadata: {
          memberScoped: true,
          acknowledgementTtlSeconds: INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS,
          leadVersion,
        },
        committedAt: acknowledgedAt,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          contactId,
          acknowledgedAt: acknowledgedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          acknowledgementVersion: acknowledgement.version,
          leadVersion,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "inbox_new_lead_acknowledgement",
          entityId: acknowledgement.id,
          version: String(acknowledgement.version),
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
        acknowledgedAt,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[inbox-new-leads] idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}

import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  auditLogs,
  contacts,
  crmTasks,
  externalMessageDispatches,
  getDb,
  leadAutomationStates,
  leads,
  outboxEvents,
  partnerInviteOperations,
  partnerLoginTokens,
  partnerSessions,
  partnerUsers,
  quoteCapabilities,
  salesEscalationCallOperations,
} from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { planContactSoftDelete } from "@/lib/contact-retention";
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
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { normalizePhone } from "../../../web/utils";
import {
  and,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { setContactAssignee } from "@/lib/contact-assignees";

type RouteContext = {
  params: Promise<{ contactId?: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractPgCode(error: unknown): string | null {
  const direct = isRecord(error) ? error : null;
  const directCode =
    direct && typeof direct["code"] === "string" ? direct["code"] : null;
  if (directCode) return directCode;
  const cause = direct && isRecord(direct["cause"]) ? direct["cause"] : null;
  const causeCode =
    cause && typeof cause["code"] === "string" ? cause["code"] : null;
  return causeCode;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "contacts.write");
  if (permissionError) return permissionError;

  const { contactId } = await context.params;
  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const {
    firstName,
    lastName,
    email,
    phone,
    preferredContactMethod,
    source,
    salespersonMemberId,
  } = payload as Record<string, unknown>;

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (typeof firstName === "string") {
    const trimmed = firstName.trim();
    if (trimmed.length === 0) {
      return NextResponse.json(
        { error: "first_name_required" },
        { status: 400 },
      );
    }
    updates["firstName"] = trimmed;
  }

  if (typeof lastName === "string") {
    const trimmed = lastName.trim();
    if (trimmed.length === 0) {
      return NextResponse.json(
        { error: "last_name_required" },
        { status: 400 },
      );
    }
    updates["lastName"] = trimmed;
  }

  if (email !== undefined) {
    if (typeof email === "string" && email.trim().length > 0) {
      updates["email"] = email.trim();
    } else if (
      email === null ||
      (typeof email === "string" && email.trim().length === 0)
    ) {
      updates["email"] = null;
    } else {
      return NextResponse.json({ error: "invalid_email" }, { status: 400 });
    }
  }

  if (phone !== undefined) {
    if (typeof phone === "string" && phone.trim().length > 0) {
      try {
        const normalized = normalizePhone(phone);
        updates["phone"] = normalized.raw;
        updates["phoneE164"] = normalized.e164;
      } catch {
        return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
      }
    } else if (
      phone === null ||
      (typeof phone === "string" && phone.trim().length === 0)
    ) {
      updates["phone"] = null;
      updates["phoneE164"] = null;
    } else {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }
  }

  if (typeof preferredContactMethod === "string") {
    updates["preferredContactMethod"] = preferredContactMethod.trim();
  }

  if (typeof source === "string") {
    updates["source"] = source.trim();
  }

  const salespersonUpdateRaw = salespersonMemberId;
  if (salespersonUpdateRaw !== undefined) {
    if (typeof salespersonUpdateRaw === "string") {
      const trimmed = salespersonUpdateRaw.trim();
      if (trimmed.length > 0 && !isUuid(trimmed)) {
        return NextResponse.json(
          { error: "invalid_salesperson" },
          { status: 400 },
        );
      }
      updates["salespersonMemberId"] = trimmed.length > 0 ? trimmed : null;
    } else if (salespersonUpdateRaw === null) {
      updates["salespersonMemberId"] = null;
    } else {
      return NextResponse.json(
        { error: "invalid_salesperson" },
        { status: 400 },
      );
    }
  }

  if (Object.keys(updates).length === 1) {
    return NextResponse.json({ error: "no_updates_provided" }, { status: 400 });
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  let updated:
    | {
        id: string;
        firstName: string;
        lastName: string;
        email: string | null;
        phone: string | null;
        phoneE164: string | null;
        preferredContactMethod: string | null;
        source: string | null;
        updatedAt: Date;
        salespersonMemberId?: string | null;
      }
    | undefined;

  try {
    const [row] = await db
      .update(contacts)
      .set(updates)
      .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)))
      .returning({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        phone: contacts.phone,
        phoneE164: contacts.phoneE164,
        preferredContactMethod: contacts.preferredContactMethod,
        source: contacts.source,
        updatedAt: contacts.updatedAt,
        salespersonMemberId: contacts.salespersonMemberId,
      });
    updated = row;
  } catch (error) {
    const code = extractPgCode(error);
    if (code === "42703") {
      if ("salespersonMemberId" in updates) {
        const memberId = updates["salespersonMemberId"];
        delete updates["salespersonMemberId"];

        await setContactAssignee(db, {
          contactId,
          memberId: typeof memberId === "string" ? memberId : null,
          actorId: actor.id ?? null,
        });
      }
      const [row] = await db
        .update(contacts)
        .set(updates)
        .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)))
        .returning({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          email: contacts.email,
          phone: contacts.phone,
          phoneE164: contacts.phoneE164,
          preferredContactMethod: contacts.preferredContactMethod,
          source: contacts.source,
          updatedAt: contacts.updatedAt,
        });
      updated = row
        ? {
            ...row,
            salespersonMemberId:
              salespersonUpdateRaw === null
                ? null
                : typeof salespersonUpdateRaw === "string"
                  ? salespersonUpdateRaw.trim() || null
                  : null,
          }
        : undefined;
    } else {
      throw error;
    }
  }

  if (!updated) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  if (salespersonUpdateRaw !== undefined) {
    const nextAssignee = updated.salespersonMemberId ?? null;
    await db
      .update(crmTasks)
      .set({ assignedTo: nextAssignee, updatedAt: new Date() })
      .where(
        and(
          eq(crmTasks.contactId, contactId),
          eq(crmTasks.status, "open"),
          isNotNull(crmTasks.notes),
          ilike(crmTasks.notes, "%[auto] leadId=%"),
        ),
      );
  }

  const changedFields = Object.keys(updates).filter(
    (key) => key !== "updatedAt",
  );

  await recordAuditEvent({
    actor,
    action: "contact.updated",
    entityType: "contact",
    entityId: updated.id,
    meta: { fields: changedFields },
  });

  return NextResponse.json({
    contact: {
      id: updated.id,
      firstName: updated.firstName,
      lastName: updated.lastName,
      email: updated.email,
      phone: updated.phone,
      phoneE164: updated.phoneE164,
      salespersonMemberId: updated.salespersonMemberId ?? null,
      preferredContactMethod: updated.preferredContactMethod,
      source: updated.source,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["contacts.delete"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "contact.deleted",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  // Route state is intentionally read only after the complete trust boundary.
  const { contactId } = await context.params;
  const targetContactId = contactId?.trim() ?? "";
  if (!isUuid(targetContactId)) {
    return teamMutationErrorResponse(
      "invalid",
      "A valid contact ID is required before moving a contact to recovery.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { contactId: "Select a valid contact." },
      },
    );
  }
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest contact version is required before moving it to recovery.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the contact and try again." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "DELETE /api/admin/contacts/:contactId",
      entityType: "contact",
      entityId: targetContactId,
      payload: { method: "DELETE" },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    const executableClaim = claimed.claim;
    claim = executableClaim;

    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${targetContactId}, 0))`,
      );
      const [existing] = await tx
        .select({
          id: contacts.id,
          deletedAt: contacts.deletedAt,
          purgeEligibleAt: contacts.purgeEligibleAt,
          updatedAt: contacts.updatedAt,
        })
        .from(contacts)
        .where(eq(contacts.id, targetContactId))
        .for("update")
        .limit(1);

      if (!existing) {
        throw new TeamMutationFailure(
          "conflict",
          "The contact no longer exists. Refresh the contact list before continuing.",
        );
      }
      assertTeamMutationExpectedVersion(mutation, existing.updatedAt);

      // Lock access-link operations immediately after the organization row,
      // matching the invite route's contact -> user -> operation ordering.
      // A committed dispatch may already be at a provider and therefore
      // blocks deletion. Requested operations are known to be pre-provider;
      // they are failed and quarantined later in this same transaction.
      const activePartnerInvites = await tx
        .select({
          id: partnerInviteOperations.id,
          partnerUserId: partnerInviteOperations.partnerUserId,
          state: partnerInviteOperations.state,
          version: partnerInviteOperations.version,
        })
        .from(partnerInviteOperations)
        .where(
          and(
            eq(partnerInviteOperations.orgContactId, targetContactId),
            inArray(partnerInviteOperations.state, [
              "requested",
              "dispatched",
              "reconciliation_required",
            ]),
            isNull(partnerInviteOperations.resolvedAt),
          ),
        )
        .for("update");
      const ambiguousPartnerInvite = activePartnerInvites.find(
        (operation) =>
          operation.state === "dispatched" ||
          operation.state === "reconciliation_required",
      );
      if (ambiguousPartnerInvite) {
        throw new TeamMutationFailure(
          "conflict",
          "A partner portal invite is in flight or awaiting reconciliation. Resolve that invite before moving this contact to recovery.",
          { retryable: true },
        );
      }
      const requestedPartnerInvites = activePartnerInvites.filter(
        (operation) => operation.state === "requested",
      );

      // A committed dispatched row means a provider call is currently in
      // flight or its result is uncertain. Deletion must fail closed until
      // that attempt settles or an operator records reconciliation; otherwise
      // the customer could receive a message after the CRM reports deletion.
      const [inFlightDispatch] = await tx
        .select({ id: externalMessageDispatches.id })
        .from(externalMessageDispatches)
        .where(
          and(
            eq(externalMessageDispatches.contactId, targetContactId),
            inArray(externalMessageDispatches.state, [
              "dispatched",
              "reconciliation_required",
            ]),
          ),
        )
        .limit(1);
      if (inFlightDispatch?.id) {
        throw new TeamMutationFailure(
          "conflict",
          "A message provider operation is still in flight or awaiting reconciliation. Review that dispatch before moving this contact to recovery.",
          { retryable: true },
        );
      }

      // Escalation-call operations retain their owning outbox event until a
      // signed terminal callback arrives or an operator reconciles the call.
      // Moving the contact to recovery sooner would quarantine that owner and
      // strand an accepted provider operation with no safe redial path.
      const [unresolvedEscalation] = await tx
        .select({ id: salesEscalationCallOperations.id })
        .from(salesEscalationCallOperations)
        .where(
          and(
            eq(salesEscalationCallOperations.contactId, targetContactId),
            isNull(salesEscalationCallOperations.guardReleasedAt),
          ),
        )
        .limit(1);
      if (unresolvedEscalation?.id) {
        throw new TeamMutationFailure(
          "conflict",
          "A sales escalation call is still in flight or awaiting reconciliation. Review that call before moving this contact to recovery.",
          { retryable: true },
        );
      }

      const deletionPlan = planContactSoftDelete(
        existing,
        new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1)),
      );
      if (deletionPlan.kind === "already_deleted") {
        throw new TeamMutationFailure(
          "conflict",
          "This contact is already in recovery. Refresh the contact list before continuing.",
        );
      }

      const { deletedAt, purgeEligibleAt } = deletionPlan;
      const actorId =
        typeof mutation.actor.id === "string" && isUuid(mutation.actor.id)
          ? mutation.actor.id
          : null;
      const [softDeleted] = await tx
        .update(contacts)
        .set({
          deletedAt,
          deletedBy: actorId,
          purgeEligibleAt,
          updatedAt: deletedAt,
        })
        .where(
          and(eq(contacts.id, targetContactId), isNull(contacts.deletedAt)),
        )
        .returning({ id: contacts.id });
      if (!softDeleted?.id) {
        throw new TeamMutationFailure(
          "conflict",
          "The contact changed while it was being moved to recovery. Refresh and try again.",
          { retryable: true },
        );
      }

      // Customer proposal capabilities are bearer credentials. Revoke them in
      // the same transaction that makes the contact inactive so a restored
      // contact can never reactivate an old customer link.
      const revokedQuoteCapabilities = await tx
        .update(quoteCapabilities)
        .set({
          status: "revoked",
          revokedAt: deletedAt,
          revokedByTeamMemberId: actorId,
          revocationReason: "contact_inactive",
          updatedAt: deletedAt,
        })
        .where(
          and(
            sql`${quoteCapabilities.status} <> 'revoked'`,
            sql`EXISTS (
              SELECT 1
              FROM "quotes" AS deletion_quote_capability
              WHERE deletion_quote_capability."id" = ${quoteCapabilities.quoteId}
                AND deletion_quote_capability."contact_id" = ${targetContactId}
            )`,
          ),
        )
        .returning({ id: quoteCapabilities.id });

      let quarantinedPartnerInviteCount = 0;
      for (const operation of requestedPartnerInvites) {
        const terminalAuditEventId = randomUUID();
        await tx.insert(auditLogs).values({
          id: terminalAuditEventId,
          actorType: mutation.actor.type,
          actorId,
          actorRole: mutation.actor.role ?? null,
          actorLabel: mutation.actor.label ?? null,
          sessionId: mutation.actor.sessionId ?? null,
          authMethod: mutation.actor.authMethod,
          correlationId: mutation.correlationId,
          requiredPermissions: mutation.policy.requiredPermissions,
          outcome: "failed",
          surface: "team.contacts",
          idempotencyKeyHash: mutation.idempotencyKeyHash,
          action: "partner_user.invite.quarantined",
          entityType: "partner_invite_operation",
          entityId: operation.id,
          meta: sanitizeAuditMetadata({
            eventId: terminalAuditEventId,
            correlationId: mutation.correlationId,
            operationId: operation.id,
            parentOperationId: mutation.operationId,
            sessionId: mutation.actor.sessionId ?? null,
            authMethod: mutation.actor.authMethod,
            requiredPermissions: mutation.policy.requiredPermissions,
            risk: mutation.policy.risk,
            outcome: "failed",
            orgContactId: targetContactId,
            partnerUserId: operation.partnerUserId,
            before: { deliveryState: "requested" },
            after: { deliveryState: "failed" },
            reason: "contact_soft_deleted_before_provider_dispatch",
            providerBoundaryCrossed: false,
            retryable: false,
          }),
          createdAt: deletedAt,
        });
        const [quarantined] = await tx
          .update(partnerInviteOperations)
          .set({
            state: "failed",
            version: operation.version + 1,
            terminalAuditEventId,
            failureCode: "contact_soft_deleted",
            failureDetail: "contact_soft_deleted_before_provider_dispatch",
            retryable: false,
            quarantinedAt: deletedAt,
            quarantinedBy: actorId,
            quarantineReason: "contact_soft_deleted",
            completedAt: deletedAt,
            updatedAt: deletedAt,
          })
          .where(
            and(
              eq(partnerInviteOperations.id, operation.id),
              eq(partnerInviteOperations.state, "requested"),
              eq(partnerInviteOperations.version, operation.version),
            ),
          )
          .returning({ id: partnerInviteOperations.id });
        if (!quarantined?.id) {
          throw new TeamMutationFailure(
            "conflict",
            "A partner invite changed while the contact was being moved to recovery. Refresh and review the invite before trying again.",
            { retryable: true },
          );
        }
        quarantinedPartnerInviteCount += 1;
      }

      const portalUsers = await tx
        .select({ id: partnerUsers.id })
        .from(partnerUsers)
        .where(eq(partnerUsers.orgContactId, targetContactId));
      const portalUserIds = portalUsers.map((user) => user.id);
      const revokedPortalSessions = portalUserIds.length
        ? await tx
            .update(partnerSessions)
            .set({ revokedAt: deletedAt })
            .where(
              and(
                inArray(partnerSessions.partnerUserId, portalUserIds),
                isNull(partnerSessions.revokedAt),
              ),
            )
            .returning({ id: partnerSessions.id })
        : [];
      const invalidatedPortalTokens = portalUserIds.length
        ? await tx
            .update(partnerLoginTokens)
            .set({ usedAt: deletedAt })
            .where(
              and(
                inArray(partnerLoginTokens.partnerUserId, portalUserIds),
                isNull(partnerLoginTokens.usedAt),
              ),
            )
            .returning({ id: partnerLoginTokens.id })
        : [];

      // Deletion is also an automation boundary. Keep the prior automation
      // records for review, but prevent any next touch and do not silently
      // re-enable them if the contact is later restored.
      const pausedAutomation = await tx
        .update(leadAutomationStates)
        .set({
          paused: true,
          pausedAt: sql`coalesce(${leadAutomationStates.pausedAt}, ${sql.param(
            deletedAt,
            leadAutomationStates.pausedAt,
          )})`,
          pausedBy: sql`coalesce(${leadAutomationStates.pausedBy}, ${actorId})`,
          followupState: "contact_deleted",
          nextFollowupAt: null,
          updatedAt: deletedAt,
        })
        .where(
          inArray(
            leadAutomationStates.leadId,
            tx
              .select({ id: leads.id })
              .from(leads)
              .where(eq(leads.contactId, targetContactId)),
          ),
        )
        .returning({ id: leadAutomationStates.id });

      // Preserve queued operations as evidence, but quarantine every pending
      // operation whose payload resolves to this contact through a supported
      // CRM entity. The dispatcher independently repeats this lookup before
      // executing a handler, which also catches work queued after deletion.
      const quarantinedOperations = await tx
        .update(outboxEvents)
        .set({
          quarantinedAt: deletedAt,
          quarantinedBy: actorId,
          quarantineReason: "contact_soft_deleted",
          quarantinedContactId: targetContactId,
        })
        .where(
          and(
            isNull(outboxEvents.processedAt),
            isNull(outboxEvents.quarantinedAt),
            or(
              sql`${outboxEvents.payload}->>'contactId' = ${targetContactId}`,
              sql`EXISTS (
                SELECT 1 FROM "leads" AS deletion_lead
                WHERE deletion_lead."contact_id" = ${targetContactId}
                  AND deletion_lead."id"::text = ${outboxEvents.payload}->>'leadId'
              )`,
              sql`EXISTS (
                SELECT 1 FROM "appointments" AS deletion_appointment
                WHERE deletion_appointment."contact_id" = ${targetContactId}
                  AND deletion_appointment."id"::text = ${outboxEvents.payload}->>'appointmentId'
              )`,
              sql`EXISTS (
                SELECT 1 FROM "quotes" AS deletion_quote
                WHERE deletion_quote."contact_id" = ${targetContactId}
                  AND deletion_quote."id"::text = ${outboxEvents.payload}->>'quoteId'
              )`,
              sql`EXISTS (
                SELECT 1 FROM "crm_tasks" AS deletion_task
                WHERE deletion_task."contact_id" = ${targetContactId}
                  AND deletion_task."id"::text = ${outboxEvents.payload}->>'taskId'
              )`,
              sql`EXISTS (
                SELECT 1
                FROM "conversation_threads" AS deletion_thread
                WHERE deletion_thread."contact_id" = ${targetContactId}
                  AND deletion_thread."id"::text = ${outboxEvents.payload}->>'threadId'
              )`,
              sql`EXISTS (
                SELECT 1
                FROM "conversation_messages" AS deletion_message
                INNER JOIN "conversation_threads" AS deletion_message_thread
                  ON deletion_message_thread."id" = deletion_message."thread_id"
                WHERE deletion_message_thread."contact_id" = ${targetContactId}
                  AND deletion_message."id"::text IN (
                    ${outboxEvents.payload}->>'messageId',
                    ${outboxEvents.payload}->>'draftMessageId',
                    ${outboxEvents.payload}->>'inboundMessageId'
                  )
              )`,
              sql`EXISTS (
                SELECT 1 FROM "call_records" AS deletion_call
                WHERE deletion_call."contact_id" = ${targetContactId}
                  AND (
                    deletion_call."id"::text = ${outboxEvents.payload}->>'callRecordId'
                    OR deletion_call."call_sid" = ${outboxEvents.payload}->>'callSid'
                  )
              )`,
            ),
          ),
        )
        .returning({ id: outboxEvents.id });

      // Requested means the provider boundary was never crossed. Preserve
      // the attempt as evidence, mark it as a definite pre-dispatch failure,
      // and leave its outbox event quarantined for explicit review.
      const canceledDispatches = await tx
        .update(externalMessageDispatches)
        .set({
          state: "failed",
          version: sql`${externalMessageDispatches.version} + 1`,
          completedAt: deletedAt,
          failureDetail: "contact_soft_deleted_before_provider_dispatch",
          retryable: false,
          updatedAt: deletedAt,
        })
        .where(
          and(
            eq(externalMessageDispatches.contactId, targetContactId),
            eq(externalMessageDispatches.state, "requested"),
          ),
        )
        .returning({ id: externalMessageDispatches.id });

      const version = deletedAt.toISOString();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "contact",
        entityId: softDeleted.id,
        before: {
          deletedAt: null,
          updatedAt: existing.updatedAt.toISOString(),
        },
        after: {
          deletedAt: version,
          recoverableUntil: purgeEligibleAt.toISOString(),
        },
        metadata: {
          deletionMode: "soft",
          linkedRecordsPreserved: true,
          instantQuotesPreserved: true,
          relationshipPolicy: "no_phone_based_cascade",
          automationPausedCount: pausedAutomation.length,
          outboxQuarantinedCount: quarantinedOperations.length,
          requestedDispatchesCanceledCount: canceledDispatches.length,
          requestedPartnerInvitesQuarantinedCount:
            quarantinedPartnerInviteCount,
          partnerPortalSessionsRevokedCount: revokedPortalSessions.length,
          partnerPortalTokensInvalidatedCount: invalidatedPortalTokens.length,
          quoteCapabilitiesRevokedCount: revokedQuoteCapabilities.length,
          inFlightDispatchPolicy: "fail_closed",
          restoreRequiresAutomationReview: true,
        },
        committedAt: deletedAt,
      });

      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          deleted: true,
          softDeleted: true,
          deletedAt: version,
          recoverableUntil: purgeEligibleAt.toISOString(),
          pausedAutomationCount: pausedAutomation.length,
          quarantinedOperationCount: quarantinedOperations.length,
          canceledRequestedDispatchCount: canceledDispatches.length,
          quarantinedRequestedPartnerInviteCount: quarantinedPartnerInviteCount,
          revokedPartnerPortalSessionCount: revokedPortalSessions.length,
          invalidatedPartnerPortalTokenCount: invalidatedPortalTokens.length,
          revokedQuoteCapabilityCount: revokedQuoteCapabilities.length,
          automationRequiresReviewAfterRestore: true,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "contact",
          entityId: softDeleted.id,
          version,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        executableClaim,
        mutationResult,
        200,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (claim && db) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[team-idempotency] failure_settlement_failed", {
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

import { randomUUID } from "node:crypto";
import type { ActionPolicy } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { DateTime } from "luxon";
import {
  and,
  asc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import {
  auditLogs,
  contacts,
  crmTasks,
  getDb,
  leadAutomationStates,
  leads,
  outboxEvents,
  partnerAccounts,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  normalizePartnerAccountDomain,
  normalizePartnerAccountName,
  resolveOrCreatePartnerAccount,
  updatePartnerAccountAfterOutboundTouch,
} from "@/lib/partner-accounts";
import { upsertPartnerCheckinTask } from "@/lib/partner-checkins";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import {
  nextOutboundTaskVersion,
  outboundTaskCampaign,
  parseOutboundDispositionPayload,
  parseOutboundTaskVersion,
  readOutboundMutationRequest,
  requireOutboundExpectedVersion,
  type OutboundDisposition,
} from "@/lib/outbound-mutation-contract";
import { runOutboundMutationAtomic } from "@/lib/outbound-mutation-transaction";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";

function parseField(notes: string, key: string): string | null {
  const match = notes.match(new RegExp(`(?:^|\\n)${key}=([^\\n]+)`, "iu"));
  const value = match?.[1]?.trim();
  return value ? value : null;
}

function upsertField(notes: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`(^|\\n)${key}=[^\\n]*`, "iu");
  return pattern.test(notes)
    ? notes.replace(pattern, `$1${line}`)
    : notes.length > 0
      ? `${notes}\n${line}`
      : line;
}

function isOutboundTask(notes: string): boolean {
  return /(?:^|\n)kind=outbound(?:\n|$)/iu.test(notes);
}

export async function insertPartnerConversionAudit(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  input: {
    contactId: string;
    partnerAccountId: string | null;
    partnerType: "portal_first" | "managed_direct" | "hybrid" | null;
    previousPartnerStatus: string;
    committedAt: Date;
  },
): Promise<void> {
  const auditEventId = randomUUID();
  const meta = sanitizeAuditMetadata({
    eventId: auditEventId,
    correlationId: mutation.correlationId,
    operationId: mutation.operationId,
    sessionId: mutation.actor.sessionId ?? null,
    authMethod: mutation.actor.authMethod,
    requiredPermissions: mutation.policy.requiredPermissions,
    risk: mutation.policy.risk,
    outcome: "succeeded",
    idempotencyKeyHash: mutation.idempotencyKeyHash,
    contactId: input.contactId,
    partnerAccountId: input.partnerAccountId,
    partnerType: input.partnerType,
    before: { partnerStatus: input.previousPartnerStatus },
    after: {
      partnerStatus: "partner",
      accountStatus: input.partnerAccountId ? "active_partner" : null,
    },
  });

  await tx.insert(auditLogs).values({
    id: auditEventId,
    actorType: mutation.actor.type,
    actorId: mutation.actor.id ?? null,
    actorRole: mutation.actor.role ?? null,
    actorLabel: mutation.actor.label ?? null,
    sessionId: mutation.actor.sessionId ?? null,
    authMethod: mutation.actor.authMethod,
    correlationId: mutation.correlationId,
    requiredPermissions: mutation.policy.requiredPermissions,
    outcome: "succeeded",
    surface: "/team/sales/outbound",
    idempotencyKeyHash: mutation.idempotencyKeyHash,
    action: "partner.converted",
    entityType: "contact",
    entityId: input.contactId,
    meta,
    createdAt: input.committedAt,
  });
}

function computeNextDueAt(now: Date, attempt: number): Date | null {
  const scheduleDays = [0, 1, 3, 7] as const;
  const index = Math.min(Math.max(1, attempt), scheduleDays.length) - 1;
  const days = scheduleDays[index + 1];
  return days === undefined
    ? null
    : new Date(now.getTime() + days * 24 * 60 * 60 * 1_000);
}

function normalizePartnerTypeFromFit(
  value: string | null | undefined,
): "portal_first" | "managed_direct" | "hybrid" | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized === "portal_first" ||
    normalized === "managed_direct" ||
    normalized === "hybrid"
    ? normalized
    : null;
}

/**
 * Preserve the original conversion instant while binding a new instant through
 * the schema column's timestamp encoder. A Date interpolated directly into a
 * raw SQL fragment bypasses that encoder and postgres.js cannot serialize it
 * after PostgreSQL resolves the parameter as timestamptz.
 */
export function buildPartnerSincePreservationValue(now: Date) {
  const encodedNow = sql.param(now, contacts.partnerSince);
  return sql<Date>`coalesce(${contacts.partnerSince}, ${encodedNow})`;
}

function isHardStop(disposition: OutboundDisposition): boolean {
  return (
    disposition === "dnc" ||
    disposition === "not_interested" ||
    disposition === "wrong_number" ||
    disposition === "spam"
  );
}

function isGlobalDnc(disposition: OutboundDisposition): boolean {
  return (
    disposition === "dnc" ||
    disposition === "wrong_number" ||
    disposition === "spam"
  );
}

function isSoftStop(disposition: OutboundDisposition): boolean {
  return disposition === "connected" || disposition === "partner";
}

async function lockPartnerIdentity(
  tx: TeamMutationTransaction,
  input: { company: string | null; email: string | null },
): Promise<void> {
  const keys = new Set<string>();
  const domain = normalizePartnerAccountDomain(input.email);
  const name = normalizePartnerAccountName(input.company);
  if (domain) keys.add(`outbound-import:partner:domain:${domain}`);
  if (name) keys.add(`outbound-import:partner:name:${name}`);
  const sorted = [...keys].sort();
  if (sorted.length === 0) return;
  const values = sql.join(
    sorted.map((key) => sql`(${key})`),
    sql`, `,
  );
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(lock_key, 0))
    from (values ${values}) as outbound_partner_locks(lock_key)
    order by lock_key
  `);
}

async function lockDispositionContactScope(
  tx: TeamMutationTransaction,
  taskId: string,
): Promise<string> {
  const [candidate] = await tx
    .select({ contactId: crmTasks.contactId })
    .from(crmTasks)
    .where(eq(crmTasks.id, taskId))
    .limit(1);
  if (!candidate) {
    throw new TeamMutationFailure(
      "invalid",
      "The outbound task was not found.",
      {
        status: 404,
        fieldErrors: { taskId: "Refresh the outbound queue." },
      },
    );
  }

  // The raw contact scope is shared with final provider dispatch and every
  // canonical DNC writer. The outbound scope additionally serializes sibling
  // cadence outcomes before any contact/task row lock is acquired.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${candidate.contactId}, 0))`,
  );
  const lockKey = `outbound-disposition:contact:${candidate.contactId}`;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
  return candidate.contactId;
}

async function ensureReminderOutbox(
  tx: TeamMutationTransaction,
  taskId: string,
  dueAt: Date,
): Promise<void> {
  const [existing] = await tx
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.type, "crm.reminder.sms"),
        isNull(outboxEvents.processedAt),
        isNull(outboxEvents.quarantinedAt),
        sql`(${outboxEvents.payload} ->> 'taskId') = ${taskId}`,
      ),
    )
    .for("update")
    .limit(1);
  if (existing) {
    await tx
      .update(outboxEvents)
      .set({ nextAttemptAt: dueAt })
      .where(eq(outboxEvents.id, existing.id));
    return;
  }
  await tx.insert(outboxEvents).values({
    type: "crm.reminder.sms",
    payload: { taskId },
    nextAttemptAt: dueAt,
  });
}

async function quarantineTaskReminders(
  tx: TeamMutationTransaction,
  input: {
    taskIds: readonly string[];
    contactId: string;
    actorId: string;
    now: Date;
  },
): Promise<void> {
  const taskIds = Array.from(new Set(input.taskIds));
  if (taskIds.length === 0) return;
  await tx
    .update(outboxEvents)
    .set({
      quarantinedAt: input.now,
      quarantinedBy: input.actorId,
      quarantineReason: "outbound_cadence_task_completed",
      quarantinedContactId: input.contactId,
    })
    .where(
      and(
        eq(outboxEvents.type, "crm.reminder.sms"),
        isNull(outboxEvents.processedAt),
        isNull(outboxEvents.quarantinedAt),
        inArray(sql<string>`(${outboxEvents.payload} ->> 'taskId')`, taskIds),
      ),
    );
}

async function closeOtherOutboundTasks(
  tx: TeamMutationTransaction,
  input: {
    currentTaskId: string;
    contactId: string;
    campaign: string;
    disposition: OutboundDisposition;
    closeAllCampaigns: boolean;
    now: Date;
  },
): Promise<string[]> {
  const predicates = [
    eq(crmTasks.contactId, input.contactId),
    eq(crmTasks.status, "open"),
    isNotNull(crmTasks.notes),
    ilike(crmTasks.notes, "%kind=outbound%"),
  ];
  const rows = await tx
    .select({
      id: crmTasks.id,
      notes: crmTasks.notes,
      updatedAt: crmTasks.updatedAt,
    })
    .from(crmTasks)
    .where(and(...predicates))
    .orderBy(asc(crmTasks.id))
    .for("update");

  const closed: string[] = [];
  for (const row of rows) {
    if (row.id === input.currentTaskId) continue;
    let notes = row.notes ?? "";
    if (!isOutboundTask(notes)) continue;
    if (
      !input.closeAllCampaigns &&
      outboundTaskCampaign(notes) !== input.campaign
    ) {
      continue;
    }
    if (!parseField(notes, "startedAt")) {
      notes = upsertField(notes, "startedAt", input.now.toISOString());
    }
    notes = upsertField(notes, "lastDisposition", input.disposition);
    notes = upsertField(notes, "completedAt", input.now.toISOString());
    const [changed] = await tx
      .update(crmTasks)
      .set({
        status: "completed",
        notes,
        updatedAt: nextOutboundTaskVersion(row.updatedAt, input.now),
      })
      .where(
        and(
          eq(crmTasks.id, row.id),
          eq(crmTasks.status, "open"),
          eq(crmTasks.updatedAt, row.updatedAt),
        ),
      )
      .returning({ id: crmTasks.id });
    if (!changed) {
      throw new TeamMutationFailure(
        "conflict",
        "Another outbound task changed while the cadence was stopping. Nothing was saved.",
        { retryable: true, retryAfter: "1" },
      );
    }
    closed.push(changed.id);
  }
  return closed;
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["outbound.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "outbound.disposition",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const requestNow = new Date();
    const payload = parseOutboundDispositionPayload(
      await readOutboundMutationRequest(request, 8 * 1_024),
      requestNow,
    );
    const expectedVersion = parseOutboundTaskVersion(
      mutation.expectedVersion,
      "If-Match",
    );
    requireOutboundExpectedVersion(mutation.expectedVersion, expectedVersion);

    const database = getDb();
    db = database;
    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "POST /api/admin/outbound/disposition",
      entityType: "crm_task",
      entityId: payload.taskId,
      payload: {
        taskId: payload.taskId,
        disposition: payload.disposition,
        callbackAt: payload.callbackAt?.toISOString() ?? null,
        recap: payload.recap,
      },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await runOutboundMutationAtomic(
      (work) => database.transaction(work),
      async (tx) => {
        const lockedContactId = await lockDispositionContactScope(
          tx,
          payload.taskId,
        );
        const [task] = await tx
          .select({
            id: crmTasks.id,
            contactId: crmTasks.contactId,
            assignedTo: crmTasks.assignedTo,
            partnerAccountId: crmTasks.partnerAccountId,
            status: crmTasks.status,
            dueAt: crmTasks.dueAt,
            notes: crmTasks.notes,
            updatedAt: crmTasks.updatedAt,
          })
          .from(crmTasks)
          .where(eq(crmTasks.id, payload.taskId))
          .for("update")
          .limit(1);
        if (!task) {
          throw new TeamMutationFailure(
            "invalid",
            "The outbound task was not found.",
            {
              status: 404,
              fieldErrors: { taskId: "Refresh the outbound queue." },
            },
          );
        }
        if (task.contactId !== lockedContactId) {
          throw new TeamMutationFailure(
            "conflict",
            "The outbound task contact changed while the outcome was saving. Nothing was saved.",
            { retryable: true, retryAfter: "1" },
          );
        }
        const currentVersion = task.updatedAt.toISOString();
        requireOutboundExpectedVersion(expectedVersion, currentVersion);
        if (task.status !== "open") {
          throw new TeamMutationFailure(
            "conflict",
            "This outbound task is no longer open. Refresh the queue.",
          );
        }
        const originalNotes = task.notes ?? "";
        if (!isOutboundTask(originalNotes)) {
          throw new TeamMutationFailure(
            "invalid",
            "The selected task is not an outbound cadence task.",
          );
        }

        const [contact] = await tx
          .select({
            id: contacts.id,
            company: contacts.company,
            email: contacts.email,
            salespersonMemberId: contacts.salespersonMemberId,
            partnerAccountId: contacts.partnerAccountId,
            partnerStatus: contacts.partnerStatus,
            doNotContact: contacts.doNotContact,
            deletedAt: contacts.deletedAt,
            updatedAt: contacts.updatedAt,
          })
          .from(contacts)
          .where(eq(contacts.id, task.contactId))
          .for("update")
          .limit(1);
        if (!contact || contact.deletedAt) {
          throw new TeamMutationFailure(
            "conflict",
            "The related contact is unavailable. Nothing was changed.",
          );
        }
        if (contact.doNotContact && !isHardStop(payload.disposition)) {
          throw new TeamMutationFailure(
            "conflict",
            "This contact is marked Do Not Contact. The cadence cannot continue.",
          );
        }

        const now = new Date();
        if (
          payload.callbackAt &&
          payload.callbackAt.getTime() <= now.getTime()
        ) {
          throw new TeamMutationFailure(
            "invalid",
            "The callback time has passed. Choose a new future time.",
            { fieldErrors: { callbackAt: "Choose a future callback time." } },
          );
        }

        let partnerAccountId =
          contact.partnerAccountId ?? task.partnerAccountId ?? null;
        if (!partnerAccountId) {
          await lockPartnerIdentity(tx, {
            company: contact.company,
            email: contact.email,
          });
          const account = await resolveOrCreatePartnerAccount(tx, {
            name: contact.company,
            domain: contact.email,
            ownerMemberId: task.assignedTo ?? contact.salespersonMemberId,
          });
          partnerAccountId = account?.id ?? null;
        }

        let baseNotes = originalNotes;
        if (!parseField(baseNotes, "startedAt")) {
          baseNotes = upsertField(baseNotes, "startedAt", now.toISOString());
        }
        const rawAttempt = Number(parseField(originalNotes, "attempt") ?? "1");
        const attempt =
          Number.isSafeInteger(rawAttempt) &&
          rawAttempt >= 1 &&
          rawAttempt <= 100
            ? rawAttempt
            : 1;
        const campaign = outboundTaskCampaign(originalNotes);
        let completedNotes = upsertField(
          baseNotes,
          "lastDisposition",
          payload.disposition,
        );
        completedNotes = upsertField(
          completedNotes,
          "completedAt",
          now.toISOString(),
        );
        const nextTaskVersion = nextOutboundTaskVersion(task.updatedAt, now);
        const [completedTask] = await tx
          .update(crmTasks)
          .set({
            status: "completed",
            notes: completedNotes,
            partnerAccountId,
            updatedAt: nextTaskVersion,
          })
          .where(
            and(
              eq(crmTasks.id, task.id),
              eq(crmTasks.status, "open"),
              eq(crmTasks.updatedAt, task.updatedAt),
            ),
          )
          .returning({ id: crmTasks.id, updatedAt: crmTasks.updatedAt });
        if (!completedTask) {
          throw new TeamMutationFailure(
            "conflict",
            "The outbound task changed while the outcome was saving. Nothing was saved.",
            { retryable: true, retryAfter: "1" },
          );
        }

        if (partnerAccountId && contact.partnerAccountId !== partnerAccountId) {
          await tx
            .update(contacts)
            .set({ partnerAccountId, updatedAt: now })
            .where(eq(contacts.id, contact.id));
        }
        if (payload.recap) {
          await tx.insert(crmTasks).values({
            contactId: contact.id,
            partnerAccountId,
            title: "Note",
            status: "completed",
            dueAt: null,
            assignedTo: null,
            notes: `Outbound recap (${payload.disposition}): ${payload.recap}`,
            createdAt: now,
            updatedAt: now,
          });
        }

        let stopped = false;
        let nextTaskId: string | null = null;
        let nextDueAt: Date | null = null;
        let convertedPartnerType:
          | "portal_first"
          | "managed_direct"
          | "hybrid"
          | null = null;
        const completedTaskIds = [task.id];

        if (isHardStop(payload.disposition)) {
          stopped = true;
          completedTaskIds.push(
            ...(await closeOtherOutboundTasks(tx, {
              currentTaskId: task.id,
              contactId: contact.id,
              campaign,
              disposition: payload.disposition,
              closeAllCampaigns: isGlobalDnc(payload.disposition),
              now,
            })),
          );
          await tx.insert(crmTasks).values({
            contactId: contact.id,
            partnerAccountId,
            title: "Note",
            status: "completed",
            dueAt: null,
            assignedTo: null,
            notes: `disqualify=outbound_${payload.disposition}`,
            createdAt: now,
            updatedAt: now,
          });

          if (isGlobalDnc(payload.disposition)) {
            await tx
              .update(contacts)
              .set({
                doNotContact: true,
                doNotContactAt: now,
                doNotContactBy: mutation.actor.id,
                doNotContactReason: `Outbound disposition: ${payload.disposition}`,
                updatedAt: now,
              })
              .where(eq(contacts.id, contact.id));
            const leadRows = await tx
              .select({ leadId: leads.id })
              .from(leads)
              .where(eq(leads.contactId, contact.id));
            const leadIds = Array.from(
              new Set(
                leadRows
                  .map((row) => row.leadId)
                  .filter((leadId): leadId is string => Boolean(leadId)),
              ),
            );
            if (leadIds.length > 0) {
              await tx
                .update(leadAutomationStates)
                .set({ dnc: true, followupState: "stopped", updatedAt: now })
                .where(inArray(leadAutomationStates.leadId, leadIds));
            }
          }
          if (partnerAccountId) {
            await updatePartnerAccountAfterOutboundTouch(tx, {
              partnerAccountId,
              status: "not_a_fit",
              lastDisposition: payload.disposition,
              lastTouchAt: now,
              nextTouchAt: null,
            });
          }
        } else if (isSoftStop(payload.disposition)) {
          stopped = true;
          completedTaskIds.push(
            ...(await closeOtherOutboundTasks(tx, {
              currentTaskId: task.id,
              contactId: contact.id,
              campaign,
              disposition: payload.disposition,
              closeAllCampaigns: false,
              now,
            })),
          );
          await tx.insert(crmTasks).values({
            contactId: contact.id,
            partnerAccountId,
            title: "Note",
            status: "completed",
            dueAt: null,
            assignedTo: null,
            notes:
              payload.disposition === "partner"
                ? "Outbound converted to partner (cadence stopped)"
                : "Outbound connected (cadence stopped)",
            createdAt: now,
            updatedAt: now,
          });

          if (payload.disposition === "partner") {
            const config = await getSalesScorecardConfig(tx);
            const dueAt = DateTime.fromJSDate(now, {
              zone: config.timezone || "America/New_York",
            })
              .plus({ days: 30 })
              .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
              .toUTC()
              .toJSDate();
            if (partnerAccountId) {
              const [account] = await tx
                .select({ portalFit: partnerAccounts.portalFit })
                .from(partnerAccounts)
                .where(eq(partnerAccounts.id, partnerAccountId))
                .limit(1);
              convertedPartnerType = normalizePartnerTypeFromFit(
                account?.portalFit,
              );
            }
            await tx
              .update(contacts)
              .set({
                partnerStatus: "partner",
                ...(convertedPartnerType
                  ? { partnerType: convertedPartnerType }
                  : {}),
                partnerOwnerMemberId: task.assignedTo,
                partnerSince: buildPartnerSincePreservationValue(now),
                partnerLastTouchAt: now,
                partnerNextTouchAt: dueAt,
                updatedAt: now,
              })
              .where(eq(contacts.id, contact.id));
            await upsertPartnerCheckinTask(tx, {
              contactId: contact.id,
              assignedTo: task.assignedTo,
              dueAt,
            });
          }
          if (partnerAccountId) {
            await updatePartnerAccountAfterOutboundTouch(tx, {
              partnerAccountId,
              status:
                payload.disposition === "partner"
                  ? "active_partner"
                  : "conversation_active",
              lastDisposition: payload.disposition,
              lastTouchAt: now,
              nextTouchAt: null,
            });
          }
        } else {
          nextDueAt = payload.callbackAt ?? computeNextDueAt(now, attempt);
          if (!nextDueAt) {
            stopped = true;
          } else {
            const openTasks = await tx
              .select({
                id: crmTasks.id,
                notes: crmTasks.notes,
                updatedAt: crmTasks.updatedAt,
              })
              .from(crmTasks)
              .where(
                and(
                  eq(crmTasks.contactId, contact.id),
                  eq(crmTasks.status, "open"),
                  isNotNull(crmTasks.notes),
                  ilike(crmTasks.notes, "%kind=outbound%"),
                ),
              )
              .orderBy(asc(crmTasks.id))
              .for("update");
            const validOpenTasks = openTasks.filter((row) => {
              const notes = row.notes ?? "";
              return (
                isOutboundTask(notes) &&
                outboundTaskCampaign(notes) === campaign
              );
            });
            if (validOpenTasks.length > 1) {
              throw new TeamMutationFailure(
                "conflict",
                "Multiple follow-up tasks exist for this cadence. Nothing was saved; resolve the duplicate tasks first.",
              );
            }
            const nextNotes = upsertField(
              upsertField(baseNotes, "attempt", String(attempt + 1)),
              "lastDisposition",
              payload.disposition,
            );
            const existing = validOpenTasks[0];
            if (existing) {
              const [updated] = await tx
                .update(crmTasks)
                .set({
                  title: payload.callbackAt
                    ? "Outbound: Callback"
                    : "Outbound: Follow up",
                  partnerAccountId,
                  dueAt: nextDueAt,
                  assignedTo: task.assignedTo,
                  notes: nextNotes,
                  updatedAt: nextOutboundTaskVersion(existing.updatedAt, now),
                })
                .where(
                  and(
                    eq(crmTasks.id, existing.id),
                    eq(crmTasks.status, "open"),
                    eq(crmTasks.updatedAt, existing.updatedAt),
                  ),
                )
                .returning({ id: crmTasks.id });
              if (!updated) {
                throw new TeamMutationFailure(
                  "conflict",
                  "The next outbound task changed while scheduling. Nothing was saved.",
                  { retryable: true, retryAfter: "1" },
                );
              }
              nextTaskId = updated.id;
            } else {
              const [created] = await tx
                .insert(crmTasks)
                .values({
                  contactId: contact.id,
                  partnerAccountId,
                  title: payload.callbackAt
                    ? "Outbound: Callback"
                    : "Outbound: Follow up",
                  status: "open",
                  dueAt: nextDueAt,
                  assignedTo: task.assignedTo,
                  notes: nextNotes,
                  createdAt: now,
                  updatedAt: now,
                })
                .returning({ id: crmTasks.id });
              if (!created) {
                throw new TeamMutationFailure(
                  "internal",
                  "The next outbound task could not be created. Nothing was saved.",
                  { retryable: true },
                );
              }
              nextTaskId = created.id;
            }
            await tx.insert(crmTasks).values({
              contactId: contact.id,
              partnerAccountId,
              title: "Note",
              status: "completed",
              dueAt: null,
              assignedTo: null,
              notes: `Outbound updated: ${payload.disposition}`,
              createdAt: now,
              updatedAt: now,
            });
            await ensureReminderOutbox(tx, nextTaskId, nextDueAt);
            if (partnerAccountId) {
              await updatePartnerAccountAfterOutboundTouch(tx, {
                partnerAccountId,
                status: "attempting_contact",
                lastDisposition: payload.disposition,
                lastTouchAt: now,
                nextTouchAt: nextDueAt,
              });
            }
          }
        }

        await quarantineTaskReminders(tx, {
          taskIds: completedTaskIds,
          contactId: contact.id,
          actorId: mutation.actor.id!,
          now,
        });

        const version = completedTask.updatedAt.toISOString();
        const data = {
          taskId: task.id,
          contactId: contact.id,
          disposition: payload.disposition,
          stopped,
          nextTaskId,
          nextDueAt: nextDueAt?.toISOString() ?? null,
          doNotContact:
            contact.doNotContact || isGlobalDnc(payload.disposition),
          partnerAccountId,
          version,
        };
        const committedAt = new Date();
        const audit = await mutation.audit.insertSuccess(tx, {
          entityType: "crm_task",
          entityId: task.id,
          before: {
            status: task.status,
            dueAt: task.dueAt?.toISOString() ?? null,
            version: currentVersion,
            contactDoNotContact: contact.doNotContact,
          },
          after: {
            status: "completed",
            version,
            disposition: payload.disposition,
            stopped,
            nextTaskId,
            nextDueAt: data.nextDueAt,
            contactDoNotContact: data.doNotContact,
          },
          metadata: {
            contactId: contact.id,
            campaign,
            attempt,
            disposition: payload.disposition,
            hasRecap: Boolean(payload.recap),
            partnerAccountId,
            completedTaskCount: completedTaskIds.length,
          },
          committedAt,
        });
        if (payload.disposition === "partner") {
          await insertPartnerConversionAudit(tx, mutation, {
            contactId: contact.id,
            partnerAccountId,
            partnerType: convertedPartnerType,
            previousPartnerStatus: contact.partnerStatus,
            committedAt,
          });
        }
        const mutationResult = teamMutationSuccessResult(mutation, data, {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "crm_task",
          entityId: task.id,
          version,
        });
        await completeTeamMutationIdempotency(
          tx,
          mutation,
          claimed.claim,
          mutationResult,
          200,
        );
        return mutationResult;
      },
    );

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[outbound-disposition] idempotency_settlement_failed", {
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

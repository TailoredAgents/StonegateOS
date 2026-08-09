import type { MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { contacts, getDb, teamMembers } from "@/db";
import {
  completePartnerCheckinTasks,
  upsertPartnerCheckinTask,
} from "@/lib/partner-checkins";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationExceptionResult,
  teamMutationResultResponse,
  teamMutationSuccessResult,
  type TeamMutationContext,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

const MAX_PARTNER_MUTATION_BODY_BYTES = 4 * 1024;
const MAX_SCHEDULE_DAYS = 365;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type PartnerOperationKind = "checkin" | "referral" | "touch";

type PartnerOperationInput = {
  contactId: string;
  assignedToMemberId: string | null;
  explicitAt: Date | null;
  daysFromNow: number | null;
};

type PartnerOperationData = {
  operation: PartnerOperationKind;
  contactId: string;
  version: string;
  taskId: string | null;
  partnerLastTouchAt: string | null;
  partnerNextTouchAt: string | null;
  partnerReferralCount: number;
  partnerLastReferralAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const known = new Set(allowed);
  return Object.keys(value).every((key) => known.has(key));
}

function parseExactInstant(value: unknown, field: string): Date | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    throw new TeamMutationFailure(
      "invalid",
      `${field} must be an exact UTC timestamp.`,
      { fieldErrors: { [field]: "Use an ISO timestamp ending in Z." } },
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TeamMutationFailure("invalid", `${field} is not a real time.`, {
      fieldErrors: { [field]: "Choose a real date and time." },
    });
  }
  return parsed;
}

function parseDays(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SCHEDULE_DAYS
  ) {
    throw new TeamMutationFailure(
      "invalid",
      `${field} must be a whole number from 1 through ${MAX_SCHEDULE_DAYS}.`,
      {
        fieldErrors: {
          [field]: `Choose 1–${MAX_SCHEDULE_DAYS} days.`,
        },
      },
    );
  }
  return value;
}

export function parsePartnerOperationPayload(
  kind: PartnerOperationKind,
  value: unknown,
): PartnerOperationInput {
  if (!isRecord(value)) {
    throw new TeamMutationFailure("invalid", "Send one JSON object.", {
      fieldErrors: { request: "The request body is invalid." },
    });
  }
  const allowed =
    kind === "referral"
      ? ["contactId"]
      : kind === "touch"
        ? ["assignedToMemberId", "contactId", "nextTouchAt", "nextTouchDays"]
        : ["assignedToMemberId", "contactId", "daysFromNow", "dueAt"];
  if (!exactKeys(value, allowed)) {
    throw new TeamMutationFailure(
      "invalid",
      "The request contains unsupported partner fields.",
      { fieldErrors: { request: "Remove unsupported fields and retry." } },
    );
  }

  const rawContactId = value["contactId"];
  const contactId =
    typeof rawContactId === "string" ? rawContactId.trim().toLowerCase() : "";
  if (!UUID_PATTERN.test(contactId)) {
    throw new TeamMutationFailure("invalid", "Choose a valid partner.", {
      fieldErrors: { contactId: "Refresh the partner list and try again." },
    });
  }

  const rawAssignedTo = value["assignedToMemberId"];
  const assignedToMemberId =
    rawAssignedTo === undefined || rawAssignedTo === null
      ? null
      : typeof rawAssignedTo === "string"
        ? rawAssignedTo.trim().toLowerCase()
        : "";
  if (assignedToMemberId !== null && !UUID_PATTERN.test(assignedToMemberId)) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a valid active team member.",
      { fieldErrors: { assignedToMemberId: "Choose an active team member." } },
    );
  }

  const explicitAt =
    kind === "touch"
      ? parseExactInstant(value["nextTouchAt"], "nextTouchAt")
      : kind === "checkin"
        ? parseExactInstant(value["dueAt"], "dueAt")
        : null;
  const daysFromNow =
    kind === "touch"
      ? parseDays(value["nextTouchDays"], "nextTouchDays")
      : kind === "checkin"
        ? parseDays(value["daysFromNow"], "daysFromNow")
        : null;
  if (explicitAt && daysFromNow !== null) {
    const field = kind === "touch" ? "nextTouchAt" : "dueAt";
    throw new TeamMutationFailure(
      "invalid",
      "Choose an exact time or a number of days, not both.",
      { fieldErrors: { [field]: "Remove one scheduling choice." } },
    );
  }

  return { contactId, assignedToMemberId, explicitAt, daysFromNow };
}

export async function readBoundedPartnerJson(
  request: NextRequest,
  maximumBytes = MAX_PARTNER_MUTATION_BODY_BYTES,
): Promise<unknown> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 1024 * 1024
  ) {
    throw new TeamMutationFailure(
      "internal",
      "The partner request limit is invalid.",
    );
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    throw new TeamMutationFailure(
      "invalid",
      "Partner changes require application/json.",
      { fieldErrors: { request: "Send a JSON request." } },
    );
  }
  const contentEncoding =
    request.headers.get("content-encoding")?.trim().toLowerCase() ?? "";
  if (contentEncoding && contentEncoding !== "identity") {
    throw new TeamMutationFailure(
      "invalid",
      "Compressed partner-change bodies are not supported.",
    );
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d{1,10}$/u.test(declaredLength)) {
      throw new TeamMutationFailure("invalid", "Content-Length is invalid.");
    }
    const parsedLength = Number(declaredLength);
    if (parsedLength > maximumBytes) {
      throw new TeamMutationFailure(
        "invalid",
        "The partner-change request is too large.",
        { status: 413 },
      );
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw new TeamMutationFailure(
      "invalid",
      "A JSON request body is required.",
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value) continue;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("partner_body_too_large").catch(() => undefined);
        throw new TeamMutationFailure(
          "invalid",
          "The partner-change request is too large.",
          { status: 413 },
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TeamMutationFailure("invalid", "The JSON body must be UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TeamMutationFailure("invalid", "The JSON body is malformed.", {
      fieldErrors: { request: "Send valid JSON." },
    });
  }
}

async function resolveAssignedTo(
  tx: TeamMutationTransaction,
  input: {
    explicit: string | null;
    ownerId: string | null;
    salespersonMemberId: string | null;
    actorId: string;
  },
): Promise<string> {
  const candidates = [
    input.explicit,
    input.ownerId,
    input.salespersonMemberId,
    input.actorId,
  ].filter((value, index, all): value is string =>
    Boolean(value && all.indexOf(value) === index),
  );
  const activeRows = await tx
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(inArray(teamMembers.id, candidates), eq(teamMembers.active, true)),
    );
  const active = new Set(activeRows.map((row) => row.id));
  if (input.explicit && !active.has(input.explicit)) {
    throw new TeamMutationFailure(
      "invalid",
      "The selected team member is inactive or unavailable.",
      { fieldErrors: { assignedToMemberId: "Choose an active team member." } },
    );
  }
  const resolved = candidates.find((candidate) => active.has(candidate));
  if (!resolved) {
    throw new TeamMutationFailure(
      "conflict",
      "No active team member is available for this check-in.",
    );
  }
  return resolved;
}

function scheduleAt(input: {
  now: Date;
  explicitAt: Date | null;
  daysFromNow: number | null;
  defaultDays: number;
  zone: string;
}): Date {
  const maximum = input.now.getTime() + (MAX_SCHEDULE_DAYS + 1) * 86_400_000;
  if (input.explicitAt) {
    const timestamp = input.explicitAt.getTime();
    if (timestamp <= input.now.getTime() || timestamp > maximum) {
      throw new TeamMutationFailure(
        "invalid",
        "The next check-in must be in the future and within one year.",
        { fieldErrors: { schedule: "Choose a future time within one year." } },
      );
    }
    return input.explicitAt;
  }
  const candidate = DateTime.fromJSDate(input.now, { zone: input.zone })
    .plus({ days: input.daysFromNow ?? input.defaultDays })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
  if (!candidate.isValid) {
    throw new TeamMutationFailure(
      "internal",
      "The partner check-in timezone is invalid.",
    );
  }
  return candidate.toUTC().toJSDate();
}

async function failWithAudit(
  mutation: TeamMutationContext,
  error: unknown,
  kind: PartnerOperationKind,
  contactId: string | null,
): Promise<void> {
  const failure = teamMutationExceptionResult(error);
  await recordTeamMutationFailure(mutation, {
    entityType: "contact",
    entityId: contactId,
    code: failure.result.code,
    metadata: {
      partnerOperation: kind,
      retryable: failure.result.retryable,
    },
  });
}

export async function handlePartnerOperation(
  request: NextRequest,
  kind: PartnerOperationKind,
  mutation: TeamMutationContext,
): Promise<Response> {
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    const error = new TeamMutationFailure(
      "invalid",
      "The latest partner version is required before changing this record.",
      { fieldErrors: { version: "Refresh the partner list and try again." } },
    );
    await failWithAudit(mutation, error, kind, null);
    return teamMutationExceptionResponse(error, mutation);
  }

  let parsed: PartnerOperationInput;
  try {
    parsed = parsePartnerOperationPayload(
      kind,
      await readBoundedPartnerJson(request),
    );
  } catch (error) {
    await failWithAudit(mutation, error, kind, null);
    return teamMutationExceptionResponse(error, mutation);
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: `POST /api/admin/partners/${kind}`,
      entityType: "contact",
      entityId: parsed.contactId,
      payload: {
        assignedToMemberId: parsed.assignedToMemberId,
        explicitAt: parsed.explicitAt?.toISOString() ?? null,
        daysFromNow: parsed.daysFromNow,
      },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${parsed.contactId}, 0))`,
      );
      const [existing] = await tx
        .select({
          id: contacts.id,
          deletedAt: contacts.deletedAt,
          partnerStatus: contacts.partnerStatus,
          ownerId: contacts.partnerOwnerMemberId,
          salespersonMemberId: contacts.salespersonMemberId,
          partnerLastTouchAt: contacts.partnerLastTouchAt,
          partnerNextTouchAt: contacts.partnerNextTouchAt,
          partnerReferralCount: contacts.partnerReferralCount,
          partnerLastReferralAt: contacts.partnerLastReferralAt,
          updatedAt: contacts.updatedAt,
        })
        .from(contacts)
        .where(
          and(eq(contacts.id, parsed.contactId), isNull(contacts.deletedAt)),
        )
        .for("update")
        .limit(1);
      if (!existing) {
        throw new TeamMutationFailure("invalid", "The partner was not found.", {
          status: 404,
        });
      }
      assertTeamMutationExpectedVersion(mutation, existing.updatedAt);
      if (existing.partnerStatus === "none") {
        throw new TeamMutationFailure(
          "conflict",
          "This contact is no longer in the partner workflow.",
        );
      }
      if (existing.partnerStatus === "inactive") {
        throw new TeamMutationFailure(
          "conflict",
          "Reactivate this partner before logging new work.",
        );
      }
      if (kind === "referral" && existing.partnerStatus !== "partner") {
        throw new TeamMutationFailure(
          "conflict",
          "Only an active partner can receive referral credit.",
        );
      }

      const now = new Date(
        Math.max(Date.now(), existing.updatedAt.getTime() + 1),
      );
      const actorId = mutation.actor.id;
      if (!actorId) {
        throw new TeamMutationFailure(
          "internal",
          "The verified team member is incomplete.",
        );
      }
      let assignedTo: string | null = null;
      let scheduledAt: Date | null = null;
      let taskId: string | null = null;
      let referralCount = existing.partnerReferralCount;
      let lastTouchAt = existing.partnerLastTouchAt;
      let nextTouchAt = existing.partnerNextTouchAt;
      let lastReferralAt = existing.partnerLastReferralAt;

      if (kind === "referral") {
        referralCount += 1;
        lastReferralAt = now;
        lastTouchAt = existing.partnerLastTouchAt ?? now;
        const [updated] = await tx
          .update(contacts)
          .set({
            partnerReferralCount: referralCount,
            partnerLastReferralAt: now,
            partnerLastTouchAt: lastTouchAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(contacts.id, existing.id),
              eq(contacts.updatedAt, existing.updatedAt),
              isNull(contacts.deletedAt),
            ),
          )
          .returning({ id: contacts.id });
        if (!updated) {
          throw new TeamMutationFailure(
            "conflict",
            "The partner changed while the referral was saved. Refresh and try again.",
            { retryable: true },
          );
        }
      } else {
        assignedTo = await resolveAssignedTo(tx, {
          explicit: parsed.assignedToMemberId,
          ownerId: existing.ownerId,
          salespersonMemberId: existing.salespersonMemberId,
          actorId,
        });
        const config = await getSalesScorecardConfig(tx);
        const configuredZone = config.timezone || "America/New_York";
        const zone = DateTime.now().setZone(configuredZone).isValid
          ? configuredZone
          : "America/New_York";
        scheduledAt = scheduleAt({
          now,
          explicitAt: parsed.explicitAt,
          daysFromNow: parsed.daysFromNow,
          defaultDays: kind === "touch" ? 30 : 30,
          zone,
        });
        nextTouchAt = scheduledAt;
        if (kind === "touch") {
          lastTouchAt = now;
          await completePartnerCheckinTasks(tx, { contactId: existing.id });
        }
        const [updated] = await tx
          .update(contacts)
          .set({
            ...(kind === "touch" ? { partnerLastTouchAt: now } : {}),
            partnerNextTouchAt: scheduledAt,
            partnerOwnerMemberId: existing.ownerId ?? assignedTo,
            updatedAt: now,
          })
          .where(
            and(
              eq(contacts.id, existing.id),
              eq(contacts.updatedAt, existing.updatedAt),
              isNull(contacts.deletedAt),
            ),
          )
          .returning({ id: contacts.id });
        if (!updated) {
          throw new TeamMutationFailure(
            "conflict",
            "The partner changed while the check-in was saved. Refresh and try again.",
            { retryable: true },
          );
        }
        const task = await upsertPartnerCheckinTask(tx, {
          contactId: existing.id,
          assignedTo,
          dueAt: scheduledAt,
        });
        taskId = task.taskId;
      }

      const version = now.toISOString();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "contact",
        entityId: existing.id,
        before: {
          partnerStatus: existing.partnerStatus,
          partnerLastTouchAt:
            existing.partnerLastTouchAt?.toISOString() ?? null,
          partnerNextTouchAt:
            existing.partnerNextTouchAt?.toISOString() ?? null,
          partnerReferralCount: existing.partnerReferralCount,
          partnerLastReferralAt:
            existing.partnerLastReferralAt?.toISOString() ?? null,
          version: existing.updatedAt.toISOString(),
        },
        after: {
          partnerStatus: existing.partnerStatus,
          partnerLastTouchAt: lastTouchAt?.toISOString() ?? null,
          partnerNextTouchAt: nextTouchAt?.toISOString() ?? null,
          partnerReferralCount: referralCount,
          partnerLastReferralAt: lastReferralAt?.toISOString() ?? null,
          version,
        },
        metadata: {
          partnerOperation: kind,
          assignedToMemberId: assignedTo,
          taskId,
        },
        committedAt: now,
      });
      const data: PartnerOperationData = {
        operation: kind,
        contactId: existing.id,
        version,
        taskId,
        partnerLastTouchAt: lastTouchAt?.toISOString() ?? null,
        partnerNextTouchAt: nextTouchAt?.toISOString() ?? null,
        partnerReferralCount: referralCount,
        partnerLastReferralAt: lastReferralAt?.toISOString() ?? null,
      };
      const response = teamMutationSuccessResult(mutation, data, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "contact",
        entityId: existing.id,
        version,
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        response,
        200,
        now,
      );
      return response;
    });
    return teamMutationResultResponse(
      result as MutationResult<PartnerOperationData>,
      200,
      mutation.correlationId,
    );
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[partners] idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    await failWithAudit(mutation, error, kind, parsed.contactId);
    return teamMutationExceptionResponse(error, mutation);
  }
}

import type { NextRequest } from "next/server";
import {
  parseOutboundImportConfirmation,
  parseOutboundImportPayload,
  parsePreviewHash,
  readOutboundImportJsonRequest,
} from "@/lib/outbound-import";
import {
  executePreparedOutboundImport,
  lockOutboundImportIdentities,
  lockOutboundImportMatchedContacts,
  prepareOutboundImportPreview,
  resolveOutboundImportAssignee,
} from "@/lib/outbound-import-service";
import { getDb } from "@/db";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  extendTeamMutationIdempotencyLease,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { runOutboundImportAtomic } from "@/lib/outbound-import-transaction";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const IMPORT_LEASE_MS = 15 * 60 * 1_000;

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["outbound.import"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "outbound.imported",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const payload = await readOutboundImportJsonRequest(request);
    const parsed = parseOutboundImportPayload(payload);
    const payloadRecord = payload as Record<string, unknown>;
    const previewHash = parsePreviewHash(payloadRecord["previewHash"]);
    if (mutation.expectedVersion !== previewHash) {
      throw new TeamMutationFailure(
        "invalid",
        "If-Match must contain the exact preview hash shown for this import.",
        {
          fieldErrors: {
            previewHash: "Preview again, then import that exact review.",
          },
        },
      );
    }

    const database = getDb();
    db = database;
    const assignee = await resolveOutboundImportAssignee(
      database,
      parsed.requestedAssigneeMemberId,
    );
    const initialPreview = await prepareOutboundImportPreview(
      database,
      parsed,
      assignee,
    );
    if (initialPreview.preview.previewHash !== previewHash) {
      throw new TeamMutationFailure(
        "conflict",
        "The file, assignment, or CRM records changed after preview. Preview again; nothing was imported.",
        {
          fieldErrors: {
            previewHash: "The reviewed import is stale.",
          },
        },
      );
    }
    const confirmation = parseOutboundImportConfirmation(
      payloadRecord["confirmation"],
      initialPreview.preview.counts.accepted,
    );
    if (initialPreview.preview.counts.accepted === 0) {
      throw new TeamMutationFailure(
        "invalid",
        "The preview contains no create or update rows. Nothing was imported.",
        { fieldErrors: { rows: "Resolve exclusions or choose another file." } },
      );
    }

    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "POST /api/admin/outbound/import",
      entityType: "outbound_import",
      entityId: previewHash,
      payload: {
        requestHash: parsed.requestHash,
        previewHash,
        confirmation,
      },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    await extendTeamMutationIdempotencyLease(
      database,
      mutation,
      claim,
      IMPORT_LEASE_MS,
    );

    const runTransaction = <Result>(
      work: (tx: TeamMutationTransaction) => Promise<Result>,
    ): Promise<Result> => database.transaction(work);
    const result = await runOutboundImportAtomic(runTransaction, async (tx) => {
      await lockOutboundImportIdentities(tx, parsed);
      const currentAssignee = await resolveOutboundImportAssignee(
        tx,
        parsed.requestedAssigneeMemberId,
      );
      const currentPreview = await prepareOutboundImportPreview(
        tx,
        parsed,
        currentAssignee,
      );
      if (currentPreview.preview.previewHash !== previewHash) {
        throw new TeamMutationFailure(
          "conflict",
          "CRM records changed while the import was starting. No changes were saved; preview again.",
          { retryable: false },
        );
      }
      await lockOutboundImportMatchedContacts(tx, currentPreview);
      const lockedAssignee = await resolveOutboundImportAssignee(
        tx,
        parsed.requestedAssigneeMemberId,
      );
      const lockedPreview = await prepareOutboundImportPreview(
        tx,
        parsed,
        lockedAssignee,
      );
      if (lockedPreview.preview.previewHash !== previewHash) {
        throw new TeamMutationFailure(
          "conflict",
          "CRM records changed while this import waited for another operation. No changes were saved; preview again.",
          { retryable: false },
        );
      }
      parseOutboundImportConfirmation(
        confirmation,
        lockedPreview.preview.counts.accepted,
      );

      const now = new Date();
      const execution = await executePreparedOutboundImport(
        tx,
        parsed,
        lockedPreview,
        lockedAssignee,
        now,
      );
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "outbound_import",
        entityId: previewHash,
        after: {
          previewHash,
          requestHash: parsed.requestHash,
          campaign: parsed.campaign,
          assignedToMemberId: lockedAssignee.id,
          counts: execution.counts,
        },
        metadata: {
          sourceSha256: parsed.sourceSha256,
          byteLength: parsed.byteLength,
          ignoredHeaderCount: parsed.ignoredHeaders.length,
          exclusionCount: execution.exclusionReport.rowCount,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(mutation, execution, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "outbound_import",
        entityId: previewHash,
        version: previewHash,
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[outbound-import] idempotency_settlement_failed", {
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

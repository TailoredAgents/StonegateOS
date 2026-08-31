import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import { MAX_QUOTE_ATTACHMENT_BYTES } from "@/lib/quote-v2-attachments";
import {
  createQuoteV2Attachment,
  listQuoteV2Attachments,
} from "@/lib/quote-v2-attachment-service";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_MULTIPART_BYTES = MAX_QUOTE_ATTACHMENT_BYTES + 256 * 1024;
const ALLOWED_FORM_FIELDS = new Set([
  "file",
  "purpose",
  "customerVisible",
  "label",
  "description",
]);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "quotes.read");
  if (permissionError) return permissionError;
  const versionId = (await context.params).id?.trim() ?? "";
  if (!UUID_PATTERN.test(versionId) || !isQuoteV2FeatureEnabled("staff")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  try {
    const attachments = await listQuoteV2Attachments(getDb(), versionId);
    return NextResponse.json(
      { ok: true, attachments },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch {
    return NextResponse.json(
      { error: "attachment_list_unavailable" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "quote.v2.attachment_added",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const versionId = (await context.params).id?.trim() ?? "";
  if (!UUID_PATTERN.test(versionId)) {
    return teamMutationErrorResponse(
      "invalid",
      "A valid quote version is required.",
      {
        correlationId: mutation.correlationId,
        status: 404,
      },
    );
  }
  if (!isQuoteV2FeatureEnabled("staff")) {
    return teamMutationErrorResponse(
      "forbidden",
      "The versioned quote workspace is not enabled for this cohort.",
      { correlationId: mutation.correlationId, status: 404 },
    );
  }
  const expectedDraftRevision = Number(mutation.expectedVersion);
  if (
    !Number.isSafeInteger(expectedDraftRevision) ||
    expectedDraftRevision <= 0
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The current draft revision is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the proposal before uploading." },
      },
    );
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength <= 0 ||
    declaredLength > MAX_MULTIPART_BYTES
  ) {
    return teamMutationErrorResponse(
      "invalid",
      declaredLength > MAX_MULTIPART_BYTES
        ? "The attachment is larger than 10 MB."
        : "A bounded attachment upload is required.",
      {
        correlationId: mutation.correlationId,
        status: declaredLength > MAX_MULTIPART_BYTES ? 413 : 422,
        fieldErrors: { attachments: "Choose one file no larger than 10 MB." },
      },
    );
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    return teamMutationErrorResponse(
      "invalid",
      "Use a multipart attachment upload.",
      {
        correlationId: mutation.correlationId,
        status: 415,
      },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return teamMutationErrorResponse(
      "invalid",
      "The attachment upload is malformed.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { attachments: "Choose the file again." },
      },
    );
  }
  let hasUnexpectedField = false;
  form.forEach((_value, key) => {
    if (!ALLOWED_FORM_FIELDS.has(key)) hasUnexpectedField = true;
  });
  if (hasUnexpectedField || form.getAll("file").length !== 1) {
    return teamMutationErrorResponse(
      "invalid",
      "Upload exactly one attachment.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { attachments: "Choose one file per upload." },
      },
    );
  }
  const file = form.get("file");
  if (
    !(file instanceof File) ||
    file.size < 1 ||
    file.size > MAX_QUOTE_ATTACHMENT_BYTES
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose one file no larger than 10 MB.",
      {
        correlationId: mutation.correlationId,
        status:
          file instanceof File && file.size > MAX_QUOTE_ATTACHMENT_BYTES
            ? 413
            : 422,
        fieldErrors: {
          attachments: "JPEG, PNG, WebP, HEIC, and PDF are supported.",
        },
      },
    );
  }
  const purpose = formText(form, "purpose") || "scope_evidence";
  const visibleValue = formText(form, "customerVisible") || "true";
  if (!new Set(["true", "false"]).has(visibleValue)) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid attachment visibility.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          attachments: "Choose customer-visible or internal-only.",
        },
      },
    );
  }
  const actorTeamMemberId = mutation.actor.id;
  if (!actorTeamMemberId) {
    return teamMutationErrorResponse(
      "internal",
      "The team member could not be resolved.",
      {
        correlationId: mutation.correlationId,
      },
    );
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = await crypto.subtle
    .digest("SHA-256", bytes)
    .then((digest) => Buffer.from(digest).toString("hex"));

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/quote-versions/:id/attachments",
      entityType: "quote_version",
      entityId: versionId,
      payload: {
        versionId,
        sha256,
        byteSize: bytes.byteLength,
        contentType: file.type,
        purpose,
        customerVisible: visibleValue === "true",
        label: formText(form, "label"),
        description: formText(form, "description"),
      },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const receipt = await createQuoteV2Attachment(tx, {
        versionId,
        expectedDraftRevision,
        actorTeamMemberId,
        correlationId: mutation.correlationId,
        fileName: file.name,
        claimedContentType: file.type,
        bytes,
        purpose,
        customerVisible: visibleValue === "true",
        label: formText(form, "label"),
        description: formText(form, "description"),
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote_version_attachment",
        entityId: receipt.attachmentId,
        after: {
          quoteId: receipt.quoteId,
          versionId,
          purpose: receipt.purpose,
          customerVisible: receipt.customerVisible,
          byteSize: receipt.byteSize,
          sha256: receipt.sha256,
        },
      });
      const mutationResult = teamMutationSuccessResult(mutation, receipt, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "quote_version_attachment",
        entityId: receipt.attachmentId,
        version: String(receipt.draftRevision),
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        201,
      );
      return mutationResult;
    });
    return teamMutationResultResponse(result, 201, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    await recordTeamMutationFailure(mutation, {
      entityType: "quote_version",
      entityId: versionId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: { phase: "v2_attachment_add" },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}

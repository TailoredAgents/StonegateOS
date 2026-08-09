import fs from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";

const mockRequirePermission = jest.fn();
const mockIsAdminRequest = jest.fn();
const mockRecordAuditEvent = jest.fn();
const mockGetAuditActorFromRequest = jest.fn();
const mockMergeContactsInTransaction = jest.fn();
const mockDeclineMergeSuggestionInTransaction = jest.fn();
const mockGetMergePreview = jest.fn();
const mockInsertValues = jest.fn(() => Promise.resolve(undefined));
const mockBeginTeamMutation = jest.fn();
const mockClaimIdempotency = jest.fn();
const mockCompleteIdempotency = jest.fn();
const mockSettleIdempotency = jest.fn();
const mockInsertSuccessAudit = jest.fn();
const mockReadBoundedJsonRequest = jest.fn();

jest.mock("drizzle-orm", () => ({
  and: jest.fn((...values: unknown[]) => values),
  eq: jest.fn((...values: unknown[]) => values),
}));

const mockTx = {
  select: jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn(() => ({
        limit: jest.fn(() => Promise.resolve([CLAIM])),
      })),
    })),
  })),
  insert: jest.fn(() => ({ values: mockInsertValues })),
};
const mockGetDb = jest.fn(() => ({
  transaction: jest.fn(
    async (callback: (value: typeof mockTx) => Promise<unknown>) =>
      callback(mockTx),
  ),
}));

jest.mock("@/db", () => ({
  getDb: mockGetDb,
  auditLogs: { id: "audit_logs.id" },
  mergeSuggestions: {
    id: "merge_suggestions.id",
    status: "merge_suggestions.status",
    sourceContactId: "merge_suggestions.source_contact_id",
    targetContactId: "merge_suggestions.target_contact_id",
    reviewedBy: "merge_suggestions.reviewed_by",
    reviewedAt: "merge_suggestions.reviewed_at",
    updatedAt: "merge_suggestions.updated_at",
  },
}));

jest.mock("@/lib/merge-queue", () => {
  class MergeQueueError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number) {
      super(code);
      this.code = code;
      this.status = status;
    }
  }
  return {
    MergeQueueError,
    buildMergeConfirmation: (source: string, target: string) =>
      `MERGE ${source} INTO ${target}`,
    declineMergeSuggestionInTransaction:
      mockDeclineMergeSuggestionInTransaction,
    getMergePreview: mockGetMergePreview,
    mergeContactsInTransaction: mockMergeContactsInTransaction,
  };
});
jest.mock("@/lib/bounded-json-request", () => {
  class BoundedJsonRequestError extends Error {
    readonly code = "invalid_body";
    readonly status = 400;
  }
  return {
    BoundedJsonRequestError,
    readBoundedJsonRequest: mockReadBoundedJsonRequest,
  };
});
jest.mock("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: mockClaimIdempotency,
  completeTeamMutationIdempotency: mockCompleteIdempotency,
  settleTeamMutationIdempotencyFailure: mockSettleIdempotency,
  teamMutationIdempotencyReplayResponse: jest.fn(
    () => new Response(null, { status: 200 }),
  ),
}));
jest.mock("@/lib/team-mutation", () => {
  class TeamMutationFailure extends Error {
    readonly code: string;
    readonly status: number;
    readonly retryable: boolean;
    constructor(
      code: string,
      message: string,
      options: { retryable?: boolean } = {},
    ) {
      super(message);
      this.code = code;
      this.status = code === "invalid" ? 422 : code === "conflict" ? 409 : 500;
      this.retryable = options.retryable ?? false;
    }
  }
  return {
    TeamMutationFailure,
    beginTeamMutation: mockBeginTeamMutation,
    teamMutationErrorResponse: jest.fn((code: string, message: string) =>
      Response.json(
        { ok: false, code, message },
        { status: code === "invalid" ? 422 : 409 },
      ),
    ),
    teamMutationExceptionResponse: jest.fn((error: unknown) => {
      const failure = error as { code?: string };
      const status =
        failure.code === "invalid"
          ? 422
          : failure.code === "conflict"
            ? 409
            : 500;
      return Response.json(
        { ok: false, code: failure.code ?? "internal" },
        { status },
      );
    }),
    teamMutationSuccessResult: jest.fn(
      (_mutation: unknown, data: unknown, receipt: unknown) => ({
        ok: true,
        data,
        receipt,
      }),
    ),
    teamMutationResultResponse: jest.fn((result: unknown, status: number) =>
      Response.json(result, { status }),
    ),
  };
});
jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: mockGetAuditActorFromRequest,
  recordAuditEvent: mockRecordAuditEvent,
}));
jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: mockIsAdminRequest,
}));

import { PATCH } from "../../app/api/admin/merge-suggestions/[suggestionId]/route";
import { MergeQueueError } from "@/lib/merge-queue";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const VERSION = "2026-08-08T12:00:00.000Z";
const HASH = "a".repeat(64);
const TARGET_VERSION = "2026-08-08T12:00:01.000Z";
const LEDGER = "33333333-3333-4333-8333-333333333333";
const SUGGESTION = "66666666-6666-4666-8666-666666666666";
const CLAIM = { sourceContactId: SOURCE, targetContactId: TARGET };

function request(
  action: "approve" | "decline",
  confirmation?: string,
): NextRequest {
  const payload =
    action === "approve"
      ? {
          action,
          expectedUpdatedAt: VERSION,
          expectedSourceUpdatedAt: VERSION,
          expectedTargetUpdatedAt: VERSION,
          expectedPreviewHash: HASH,
          confirmation,
        }
      : { action, expectedUpdatedAt: VERSION };
  return {
    headers: new Headers({
      "Content-Type": "application/json",
      "If-Match": action === "approve" ? HASH : VERSION,
    }),
    nextUrl: { search: "" },
    testPayload: payload,
  } as unknown as NextRequest;
}

describe("merge reviewer compare-and-set safety", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdminRequest.mockReturnValue(true);
    mockRequirePermission.mockResolvedValue(null);
    mockGetAuditActorFromRequest.mockReturnValue({
      type: "human",
      id: "reviewer-id",
      role: "owner",
      label: "Reviewer",
    });
    mockRecordAuditEvent.mockResolvedValue(undefined);
    mockInsertSuccessAudit.mockResolvedValue({
      auditEventId: "audit-id",
      committedAt: VERSION,
    });
    mockBeginTeamMutation.mockImplementation((request: NextRequest) => ({
      ok: true,
      mutation: {
        operationId: "44444444-4444-4444-8444-444444444444",
        correlationId: "correlation-id",
        expectedVersion: request.headers.get("If-Match"),
        idempotencyKeyHash: HASH,
        actor: {
          id: "11111111-1111-4111-8111-111111111119",
          role: "owner",
          label: "Reviewer",
          sessionId: "55555555-5555-4555-8555-555555555555",
          authMethod: "team_session",
        },
        audit: { insertSuccess: mockInsertSuccessAudit },
      },
    }));
    mockClaimIdempotency.mockResolvedValue({
      kind: "execute",
      claim: { id: "claim-id" },
    });
    mockCompleteIdempotency.mockResolvedValue(undefined);
    mockSettleIdempotency.mockResolvedValue(undefined);
    mockReadBoundedJsonRequest.mockImplementation(
      (candidate: NextRequest & { testPayload?: unknown }) =>
        Promise.resolve(candidate.testPayload),
    );
    mockMergeContactsInTransaction.mockResolvedValue({
      moved: {},
      updatedFields: [],
      targetVersion: TARGET_VERSION,
      previewHash: HASH,
      recoveryLedgerId: LEDGER,
      recoveryAssessmentPath: `/api/admin/merge-recovery/${LEDGER}/assessment`,
      suggestionVersion: TARGET_VERSION,
    });
    mockDeclineMergeSuggestionInTransaction.mockResolvedValue({
      ...CLAIM,
      version: TARGET_VERSION,
    });
  });

  it.each(["approve", "decline"] as const)(
    "lets only one concurrent %s decision claim a pending suggestion",
    async (action) => {
      const conflict = new MergeQueueError("suggestion_already_resolved", 409);
      const helper =
        action === "approve"
          ? mockMergeContactsInTransaction
          : mockDeclineMergeSuggestionInTransaction;
      helper
        .mockResolvedValueOnce(
          action === "approve"
            ? {
                moved: {},
                updatedFields: [],
                targetVersion: TARGET_VERSION,
                previewHash: HASH,
                recoveryLedgerId: LEDGER,
                recoveryAssessmentPath: `/api/admin/merge-recovery/${LEDGER}/assessment`,
                suggestionVersion: TARGET_VERSION,
              }
            : { ...CLAIM, version: TARGET_VERSION },
        )
        .mockRejectedValueOnce(conflict);
      const confirmation =
        action === "approve" ? `MERGE ${SOURCE} INTO ${TARGET}` : undefined;

      const responses = await Promise.all([
        PATCH(request(action, confirmation), {
          params: Promise.resolve({ suggestionId: SUGGESTION }),
        }),
        PATCH(request(action, confirmation), {
          params: Promise.resolve({ suggestionId: SUGGESTION }),
        }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 409,
      ]);
      expect(mockMergeContactsInTransaction).toHaveBeenCalledTimes(
        action === "approve" ? 2 : 0,
      );
    },
  );

  it("does not enter the merge transaction when typed confirmation is wrong", async () => {
    const response = await PATCH(request("approve", "wrong"), {
      params: Promise.resolve({ suggestionId: SUGGESTION }),
    });

    expect(response.status).toBe(422);
    expect(mockMergeContactsInTransaction).not.toHaveBeenCalled();
    expect(mockSettleIdempotency).toHaveBeenCalledTimes(1);
    expect(mockCompleteIdempotency).not.toHaveBeenCalled();
  });

  it("rejects non-canonical suggestion IDs before reading the body", async () => {
    const response = await PATCH(request("approve", "wrong"), {
      params: Promise.resolve({ suggestionId: "suggestion-1" }),
    });

    expect(response.status).toBe(422);
    expect(mockReadBoundedJsonRequest).not.toHaveBeenCalled();
    expect(mockMergeContactsInTransaction).not.toHaveBeenCalled();
  });

  it("rejects unknown review fields instead of silently ignoring them", async () => {
    const candidate = request(
      "approve",
      `MERGE ${SOURCE} INTO ${TARGET}`,
    ) as NextRequest & { testPayload: Record<string, unknown> };
    candidate.testPayload["ignored"] = true;
    const response = await PATCH(candidate, {
      params: Promise.resolve({ suggestionId: SUGGESTION }),
    });

    expect(response.status).toBe(422);
    expect(mockMergeContactsInTransaction).not.toHaveBeenCalled();
  });
});

describe("merge implementation contracts", () => {
  const suggestionRoute = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../app/api/admin/merge-suggestions/[suggestionId]/route.ts",
    ),
    "utf8",
  );
  const queueRoute = fs.readFileSync(
    path.resolve(__dirname, "../../app/api/admin/merge-suggestions/route.ts"),
    "utf8",
  );
  const manualRoute = fs.readFileSync(
    path.resolve(__dirname, "../../app/api/admin/merge/route.ts"),
    "utf8",
  );
  const scanRoute = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../app/api/admin/merge-suggestions/scan/route.ts",
    ),
    "utf8",
  );
  const siteUi = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../site/src/app/team/components/MergeQueueSection.tsx",
    ),
    "utf8",
  );
  const mergeLibrary = fs.readFileSync(
    path.resolve(__dirname, "../lib/merge-queue.ts"),
    "utf8",
  );
  const teamPage = fs.readFileSync(
    path.resolve(__dirname, "../../../site/src/app/team/page.tsx"),
    "utf8",
  );
  const teamActions = fs.readFileSync(
    path.resolve(__dirname, "../../../site/src/app/team/actions.ts"),
    "utf8",
  );

  it("binds review to the preview hash and resolves the suggestion inside the merge transaction", () => {
    expect(suggestionRoute).toContain(
      "mutation.expectedVersion !== expectedPreviewHash",
    );
    expect(suggestionRoute).not.toMatch(/\.set\(\{\s*status:\s*"pending"/u);
    expect(suggestionRoute).toContain("mergeContactsInTransaction(tx, {");
    expect(suggestionRoute).toContain("declineMergeSuggestionInTransaction(tx");
    expect(suggestionRoute).toContain("expectedSourceUpdatedAt");
    expect(suggestionRoute).toContain("expectedTargetUpdatedAt");
    expect(suggestionRoute).toContain("expectedPreviewHash");
    expect(suggestionRoute).toContain("claimTeamMutationIdempotency");
    expect(suggestionRoute).toContain("completeTeamMutationIdempotency");
  });

  it("requires a server preview and typed confirmation in the Site UI", () => {
    expect(siteUi).toContain("Preview every affected record");
    expect(siteUi).toContain('name="confirmation"');
    expect(siteUi).toContain('name="expectedUpdatedAt"');
    expect(siteUi).toContain("unresolvedDependencies");
    expect(siteUi).toContain('name="expectedSourceUpdatedAt"');
    expect(siteUi).toContain('name="expectedTargetUpdatedAt"');
    expect(siteUi).toContain('name="expectedPreviewHash"');
    expect(siteUi).toContain('name="sourceContactId"');
    expect(siteUi).toContain('name="targetContactId"');
    expect(siteUi).toContain('name="idempotencyKey"');
  });

  it("makes manual merge, suggestion review, and scanning durably replay-safe", () => {
    for (const source of [manualRoute, suggestionRoute, scanRoute]) {
      expect(source).toContain("beginTeamMutation(");
      expect(source).toContain("claimTeamMutationIdempotency");
      expect(source).toContain("completeTeamMutationIdempotency");
      expect(source).toContain("settleTeamMutationIdempotencyFailure");
      expect(source).toContain("mutation.audit.insertSuccess(tx");
    }
    expect(manualRoute).toContain('risk: "destructive"');
    expect(suggestionRoute).toContain('risk: "destructive"');
    expect(manualRoute).toContain("expectedSourceUpdatedAt");
    expect(manualRoute).toContain("expectedTargetUpdatedAt");
    expect(scanRoute).toContain("on_conflict_do_nothing");
    expect(scanRoute).toContain("scanMergeSuggestionsUsing(tx, options)");
    expect(
      scanRoute.indexOf("scanMergeSuggestionsUsing(tx, options)"),
    ).toBeGreaterThan(scanRoute.indexOf("db.transaction(async (tx)"));
    expect(teamActions).toContain('"Idempotency-Key": idempotencyKey');
    expect(teamActions).toContain('"If-Match": expectedUpdatedAt');
    expect(teamActions).toContain('"If-Match": expectedPreviewHash');
    for (const source of [manualRoute, suggestionRoute, scanRoute]) {
      expect(source).toContain("readBoundedJsonRequest(request");
      expect(source).not.toContain("await request.json()");
    }
    expect(manualRoute).toContain("parseManualContactMergePayload");
    expect(suggestionRoute).toContain("parseContactMergeReviewPayload");
    expect(scanRoute).toContain("parseContactMergeScanOptions");
  });

  it("locks both contacts and rejects any post-preview contact change", () => {
    expect(mergeLibrary).toContain('.for("update")');
    expect(mergeLibrary).toContain("merge_contact_version_conflict");
    expect(mergeLibrary).toContain(
      "sourceExpected.getTime() !== source.updatedAt.getTime()",
    );
    expect(mergeLibrary).toContain(
      "targetExpected.getTime() !== target.updatedAt.getTime()",
    );
    expect(mergeLibrary).toContain("targetVersion: mergedAt.toISOString()");
    expect(manualRoute).toContain('isolationLevel: "serializable"');
    expect(suggestionRoute).toContain('isolationLevel: "serializable"');
  });

  it("provides bounded searchable queue states without turning failures into empty data", () => {
    expect(queueRoute).toContain('error: "invalid_status"');
    expect(queueRoute).toContain("MAX_SEARCH_LENGTH = 100");
    expect(queueRoute).toContain("ilike(contacts.firstName, pattern)");
    expect(queueRoute).toContain(
      "inArray(mergeSuggestions.sourceContactId, matchingContactIds)",
    );
    expect(queueRoute).toContain(".limit(limit)");
    expect(queueRoute).toContain(".offset(offset)");
    expect(queueRoute).toContain("pagination:");

    expect(siteUi).toContain("The merge queue is unavailable.");
    expect(siteUi).toContain("No empty result is being inferred.");
    expect(siteUi).toContain('name="mergeQ"');
    expect(siteUi).toContain('name="mergeStatus"');
    expect(siteUi).toContain('aria-label="Merge queue pages"');
    expect(siteUi).toContain('suggestion.status === "pending"');
  });

  it("replaces the primary raw-ID workflow with an authenticated contact selector", () => {
    expect(siteUi).toContain("Find contacts to merge");
    expect(siteUi).toContain('name="mergeContactQ"');
    expect(siteUi).toContain("/api/admin/contacts?q=");
    expect(siteUi).toContain("Choose duplicate");
    expect(siteUi).toContain("Choose primary");
    expect(siteUi).toContain("Primary record kept");
    expect(siteUi).toContain("Duplicate recovery record");
    expect(siteUi).not.toContain("Primary contact ID");
    expect(siteUi).not.toContain("Duplicate contact ID");
    expect(teamPage).toContain("mergeContactQ?: string");
    expect(teamPage).toContain("contactQ: params.mergeContactQ");
  });

  it("deduplicates associations before soft-deleting the source into a recovery ledger", () => {
    expect(mergeLibrary).toContain("sourcePropertyAssociations");
    expect(mergeLibrary).toContain(".insert(contactProperties)");
    expect(mergeLibrary).toContain(".onConflictDoNothing({");
    expect(mergeLibrary).toContain(
      "target: [contactProperties.contactId, contactProperties.propertyId]",
    );
    expect(mergeLibrary).toContain("contactMergeRecoveryLedgers");
    expect(mergeLibrary).toContain("mergedIntoContactId: targetContactId");
    expect(mergeLibrary).toContain("mergeRecoveryLedgerId: recoveryLedgerId");
    expect(mergeLibrary).not.toContain(".delete(contacts)");
    expect(siteUi).toContain("Automatic reversal is disabled");
    expect(siteUi).toContain("Review recovery evidence");
  });

  it("baselines both contacts and rejects later unexpected dependency rows", () => {
    expect(mergeLibrary).toContain(
      "const postBaselineRows = [...contactAfterRows, ...postDependencyState.rows]",
    );
    expect(mergeLibrary).toContain('changeKind: "baseline"');
    expect(mergeLibrary).toContain(
      "compareContactMergeRecoveryBaseline(entries, currentEvidenceRows)",
    );
    expect(mergeLibrary).toContain(
      "dependencyInventoryEvidenceBlockers(state, ledger.targetContactId)",
    );
    expect(mergeLibrary).toContain(
      "dependencyOperationSafetyBlockers(state, ledger.targetContactId)",
    );
    expect(mergeLibrary).toContain(
      "VALUES (${sourceContactId}::uuid), (${targetContactId}::uuid)",
    );
    expect(mergeLibrary).toContain(
      "SELECT 'merge_suggestions.source_contact_id'",
    );
    expect(mergeLibrary).toContain(
      "SELECT 'merge_suggestions.target_contact_id'",
    );
    expect(mergeLibrary).not.toContain(
      'CASE WHEN s."source_contact_id" = ${sourceContactId}',
    );
    expect(mergeLibrary).toContain(
      "!isExactContactMergeUuid(input.recovery.actorMemberId)",
    );
    expect(mergeLibrary).toContain(
      "!isExactContactMergeUuid(input.recovery.sessionId)",
    );
    expect(mergeLibrary).not.toContain("? input.recovery.actorMemberId : null");
  });
});

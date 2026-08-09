import type { NextRequest } from "next/server";

const mockBeginTeamMutation = jest.fn();
const mockReadBoundedJsonRequest = jest.fn();
const mockGetDb = jest.fn();
const mockParsePipelineExpectedVersion = jest.fn();
const mockParsePipelineStageMutationPayload = jest.fn();

jest.mock("drizzle-orm", () => ({
  and: jest.fn(),
  eq: jest.fn(),
  ilike: jest.fn(),
  isNotNull: jest.fn(),
  isNull: jest.fn(),
  or: jest.fn(),
  sql: jest.fn(),
}));

jest.mock("@/db", () => ({
  getDb: mockGetDb,
  contacts: { id: "contacts.id", deletedAt: "contacts.deleted_at" },
  crmPipeline: {
    contactId: "pipeline.contact_id",
    stage: "pipeline.stage",
    notes: "pipeline.notes",
    createdAt: "pipeline.created_at",
    updatedAt: "pipeline.updated_at",
  },
  crmTasks: {
    id: "tasks.id",
    contactId: "tasks.contact_id",
    status: "tasks.status",
    notes: "tasks.notes",
    updatedAt: "tasks.updated_at",
  },
}));

jest.mock("@/lib/bounded-json-request", () => ({
  BoundedJsonRequestError: class BoundedJsonRequestError extends Error {},
  readBoundedJsonRequest: mockReadBoundedJsonRequest,
}));

jest.mock("@/lib/pipeline-stage-mutation", () => ({
  executePipelineStageMutation: jest.fn(),
  isPipelineContactId: jest.fn(),
  parsePipelineExpectedVersion: mockParsePipelineExpectedVersion,
  parsePipelineStageMutationPayload: mockParsePipelineStageMutationPayload,
  PIPELINE_MUTATION_MAXIMUM_BYTES: 4_096,
  PipelineStageConflictFailure: class PipelineStageConflictFailure extends Error {},
  runPipelineStageMutationAtomic: jest.fn(),
}));

jest.mock("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: jest.fn(),
  completeTeamMutationIdempotency: jest.fn(),
  settleTeamMutationIdempotencyFailure: jest.fn(),
  teamMutationIdempotencyReplayResponse: jest.fn(),
}));

jest.mock("@/lib/team-mutation", () => ({
  beginTeamMutation: mockBeginTeamMutation,
  TeamMutationFailure: class TeamMutationFailure extends Error {},
  teamMutationExceptionResult: jest.fn(),
  teamMutationExceptionResponse: jest.fn(),
  teamMutationResultResponse: jest.fn(),
  teamMutationSuccessResult: jest.fn(),
}));

import { PATCH } from "../../app/api/admin/crm/pipeline/[contactId]/route";

describe("pipeline stage route trust boundary", () => {
  it("returns a denial before reading params, body, version, or database state", async () => {
    const denied = Response.json(
      {
        ok: false,
        code: "forbidden",
        message: "denied",
        retryable: false,
      },
      { status: 403 },
    );
    mockBeginTeamMutation.mockResolvedValueOnce({
      ok: false,
      response: denied,
    });
    let paramsRead = false;
    const context = Object.defineProperty({}, "params", {
      get() {
        paramsRead = true;
        return Promise.resolve({
          contactId: "11111111-1111-4111-8111-111111111111",
        });
      },
    }) as { params: Promise<{ contactId?: string }> };
    const requestJson = jest.fn();
    const request = {
      headers: new Headers(),
      json: requestJson,
    } as unknown as NextRequest;

    const response = await PATCH(request, context);

    expect(response).toBe(denied);
    expect(mockBeginTeamMutation).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        principalTypes: ["human"],
        requiredPermissions: ["pipeline.write"],
        requiresIdempotency: true,
        auditAction: "pipeline.updated",
      }),
    );
    expect(paramsRead).toBe(false);
    expect(requestJson).not.toHaveBeenCalled();
    expect(mockReadBoundedJsonRequest).not.toHaveBeenCalled();
    expect(mockParsePipelineExpectedVersion).not.toHaveBeenCalled();
    expect(mockParsePipelineStageMutationPayload).not.toHaveBeenCalled();
    expect(mockGetDb).not.toHaveBeenCalled();
  });
});

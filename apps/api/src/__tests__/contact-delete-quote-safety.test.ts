import type { NextRequest } from "next/server";

const mockRequirePermission = jest.fn();
const mockIsAdminRequest = jest.fn();
const mockRecordAuditEvent = jest.fn();
const mockGetAuditActorFromRequest = jest.fn();
const mockClaimTeamMutationIdempotency = jest.fn();
const mockCompleteTeamMutationIdempotency = jest.fn();
const mockSettleTeamMutationIdempotencyFailure = jest.fn();
const mutationReplays = new Map<
  string,
  { result: Record<string, unknown>; status: number; correlationId: string }
>();

const mockTables = {
  auditLogs: { name: "audit_logs" },
  contacts: {
    name: "contacts",
    id: "contacts.id",
    deletedAt: "contacts.deleted_at",
    deletedBy: "contacts.deleted_by",
    purgeEligibleAt: "contacts.purge_eligible_at",
    updatedAt: "contacts.updated_at",
  },
  crmTasks: { name: "crm_tasks" },
  externalMessageDispatches: {
    name: "external_message_dispatches",
    id: "external_message_dispatches.id",
    contactId: "external_message_dispatches.contact_id",
    state: "external_message_dispatches.state",
    version: "external_message_dispatches.version",
  },
  leadAutomationStates: {
    name: "lead_automation_state",
    id: "lead_automation_state.id",
    leadId: "lead_automation_state.lead_id",
    pausedAt: "lead_automation_state.paused_at",
    pausedBy: "lead_automation_state.paused_by",
  },
  leads: { name: "leads", id: "leads.id", contactId: "leads.contact_id" },
  outboxEvents: {
    name: "outbox_events",
    id: "outbox_events.id",
    payload: "outbox_events.payload",
    processedAt: "outbox_events.processed_at",
    quarantinedAt: "outbox_events.quarantined_at",
  },
  partnerLoginTokens: {
    name: "partner_login_tokens",
    id: "partner_login_tokens.id",
    partnerUserId: "partner_login_tokens.partner_user_id",
    usedAt: "partner_login_tokens.used_at",
  },
  partnerInviteOperations: {
    name: "partner_invite_operations",
    id: "partner_invite_operations.id",
    orgContactId: "partner_invite_operations.org_contact_id",
    partnerUserId: "partner_invite_operations.partner_user_id",
    state: "partner_invite_operations.state",
    version: "partner_invite_operations.version",
  },
  partnerSessions: {
    name: "partner_sessions",
    id: "partner_sessions.id",
    partnerUserId: "partner_sessions.partner_user_id",
    revokedAt: "partner_sessions.revoked_at",
  },
  partnerUsers: {
    name: "partner_users",
    id: "partner_users.id",
    orgContactId: "partner_users.org_contact_id",
  },
  salesEscalationCallOperations: {
    name: "sales_escalation_call_operations",
    id: "sales_escalation_call_operations.id",
    contactId: "sales_escalation_call_operations.contact_id",
    guardReleasedAt: "sales_escalation_call_operations.guard_released_at",
  },
};

jest.mock("drizzle-orm", () => ({
  and: jest.fn((...values: unknown[]) => ({ kind: "and", values })),
  eq: jest.fn((...values: unknown[]) => ({ kind: "eq", values })),
  ilike: jest.fn((...values: unknown[]) => ({ kind: "ilike", values })),
  inArray: jest.fn((...values: unknown[]) => ({ kind: "inArray", values })),
  isNotNull: jest.fn((value: unknown) => ({ kind: "isNotNull", value })),
  isNull: jest.fn((value: unknown) => ({ kind: "isNull", value })),
  or: jest.fn((...values: unknown[]) => ({ kind: "or", values })),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      kind: "sql",
      strings: Array.from(strings),
      values,
    })),
    {
      param: jest.fn((value: unknown, encoder: unknown) => ({
        kind: "param",
        value,
        encoder,
      })),
    },
  ),
}));

type ContactState = {
  id: string;
  deletedAt: Date | null;
  deletedBy: string | null;
  purgeEligibleAt: Date | null;
  updatedAt: Date;
};

let contact: ContactState;
let automation = { paused: false, nextFollowupAt: new Date() as Date | null };
const linkedRecords = {
  instantQuotes: ["quote-owned-by-someone-else"],
  appointments: ["appointment-a"],
  threads: ["thread-a"],
};
const queuedOperations = [
  { id: "outbox-a", quarantinedAt: null as Date | null },
];
const auditRows: Array<Record<string, unknown>> = [];
const partnerInviteRows: Array<Record<string, unknown>> = [];
const mockDelete = jest.fn();
const mockFailureAuditValues = jest.fn(() => Promise.resolve());
const mockDbInsert = jest.fn(() => ({ values: mockFailureAuditValues }));

function selectChain() {
  return {
    from: jest.fn((table: unknown) => {
      const rows = () =>
        table === mockTables.externalMessageDispatches
          ? Promise.resolve([])
          : table === mockTables.partnerInviteOperations
            ? Promise.resolve(partnerInviteRows)
            : table === mockTables.partnerUsers ||
                table === mockTables.salesEscalationCallOperations
              ? Promise.resolve([])
              : Promise.resolve([
                  {
                    id: contact.id,
                    deletedAt: contact.deletedAt,
                    purgeEligibleAt: contact.purgeEligibleAt,
                    updatedAt: contact.updatedAt,
                  },
                ]);
      return {
        where: jest.fn(() => {
          const promise = rows();
          return {
            limit: jest.fn(() => promise),
            for: jest.fn(() =>
              Object.assign(promise, { limit: jest.fn(() => promise) }),
            ),
            then: promise.then.bind(promise),
          };
        }),
      };
    }),
  };
}

function updateChain(table: unknown) {
  return {
    set: jest.fn((values: Record<string, unknown>) => ({
      where: jest.fn(() => ({
        returning: jest.fn(() => {
          if (table === mockTables.contacts) {
            contact = { ...contact, ...values } as ContactState;
            return Promise.resolve([{ id: contact.id }]);
          }
          if (table === mockTables.leadAutomationStates) {
            automation = {
              paused: values["paused"] === true,
              nextFollowupAt:
                values["nextFollowupAt"] instanceof Date
                  ? values["nextFollowupAt"]
                  : null,
            };
            return Promise.resolve([{ id: "automation-a" }]);
          }
          if (table === mockTables.outboxEvents) {
            queuedOperations[0]!.quarantinedAt = values[
              "quarantinedAt"
            ] as Date;
            return Promise.resolve([{ id: queuedOperations[0]!.id }]);
          }
          if (table === mockTables.externalMessageDispatches) {
            return Promise.resolve([]);
          }
          if (table === mockTables.partnerInviteOperations) {
            const operation = partnerInviteRows[0];
            if (operation) Object.assign(operation, values);
            return Promise.resolve(operation ? [{ id: operation["id"] }] : []);
          }
          return Promise.resolve([]);
        }),
      })),
    })),
  };
}

const mockTx = {
  execute: jest.fn(() => Promise.resolve()),
  select: jest.fn(() => selectChain()),
  update: jest.fn((table: unknown) => updateChain(table)),
  insert: jest.fn((table: unknown) => ({
    values: jest.fn((values: Record<string, unknown>) => {
      if (table === mockTables.auditLogs) auditRows.push(values);
      return Promise.resolve();
    }),
  })),
  delete: mockDelete,
};

const mockTransaction = jest.fn(
  async (callback: (tx: typeof mockTx) => Promise<unknown>) => callback(mockTx),
);
const mockGetDb = jest.fn(() => ({
  insert: mockDbInsert,
  transaction: mockTransaction,
}));

jest.mock("@/db", () => ({
  auditLogs: mockTables.auditLogs,
  contacts: mockTables.contacts,
  crmTasks: mockTables.crmTasks,
  externalMessageDispatches: mockTables.externalMessageDispatches,
  getDb: mockGetDb,
  leadAutomationStates: mockTables.leadAutomationStates,
  leads: mockTables.leads,
  outboxEvents: mockTables.outboxEvents,
  partnerLoginTokens: mockTables.partnerLoginTokens,
  partnerInviteOperations: mockTables.partnerInviteOperations,
  partnerSessions: mockTables.partnerSessions,
  partnerUsers: mockTables.partnerUsers,
  salesEscalationCallOperations: mockTables.salesEscalationCallOperations,
}));
jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: mockGetAuditActorFromRequest,
  recordAuditEvent: mockRecordAuditEvent,
}));
jest.mock("@/lib/contact-assignees", () => ({ setContactAssignee: jest.fn() }));
jest.mock("@/lib/verified-actor-context", () => ({
  getVerifiedRequestActor: jest.fn(() => ({
    type: "human",
    id: "7d363f33-b87b-42f9-93ba-514189f3a174",
    role: "owner",
    label: "Owner",
    sessionId: "contact-safety-session",
    authMethod: "team_session",
  })),
}));
jest.mock("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: mockClaimTeamMutationIdempotency,
  completeTeamMutationIdempotency: mockCompleteTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure:
    mockSettleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse: jest.fn(
    (replay: {
      result: Record<string, unknown>;
      status: number;
      correlationId: string;
    }) =>
      new Response(JSON.stringify(replay.result), {
        status: replay.status,
        headers: {
          "content-type": "application/json",
          "idempotency-replayed": "true",
          "x-correlation-id": replay.correlationId,
        },
      }),
  ),
}));
jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: mockIsAdminRequest,
}));

import { DELETE } from "../../app/api/admin/contacts/[contactId]/route";
import { POST as RESTORE } from "../../app/api/admin/contacts/[contactId]/restore/route";
import { requireActiveContactForDirectOutbound } from "@/lib/contact-outbound-safety";

function mutationRequest(input: { version: string; key: string }): NextRequest {
  return {
    headers: new Headers({
      host: "api.test",
      origin: "https://api.test",
      "if-match": input.version,
      "idempotency-key": input.key,
    }),
    nextUrl: new URL("https://api.test/team-test"),
  } as NextRequest;
}
const context = {
  params: Promise.resolve({
    contactId: "037cfdb8-e3af-40a1-bf96-d487cab3eb91",
  }),
};

describe("contact soft deletion preserves linked records", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    contact = {
      id: "037cfdb8-e3af-40a1-bf96-d487cab3eb91",
      deletedAt: null,
      deletedBy: null,
      purgeEligibleAt: null,
      updatedAt: new Date("2026-08-08T12:00:00.000Z"),
    };
    automation = { paused: false, nextFollowupAt: new Date() };
    queuedOperations[0]!.quarantinedAt = null;
    auditRows.splice(0, auditRows.length);
    partnerInviteRows.splice(0, partnerInviteRows.length);
    linkedRecords.instantQuotes.splice(
      0,
      linkedRecords.instantQuotes.length,
      "quote-owned-by-someone-else",
    );
    mockIsAdminRequest.mockReturnValue(true);
    mockRequirePermission.mockResolvedValue(null);
    mockGetAuditActorFromRequest.mockReturnValue({
      id: "7d363f33-b87b-42f9-93ba-514189f3a174",
      role: "owner",
      type: "team_member",
      label: "Owner",
    });
    mutationReplays.clear();
    mockClaimTeamMutationIdempotency.mockImplementation(
      (
        _db: unknown,
        mutation: {
          operationId: string;
          correlationId: string;
          idempotencyKeyHash: string;
        },
        input: { route: string },
      ) => {
        const replayKey = `${input.route}:${mutation.idempotencyKeyHash}`;
        const replay = mutationReplays.get(replayKey);
        if (replay) return { kind: "replay", replay };
        return {
          kind: "execute",
          claim: {
            id: `claim:${replayKey}`,
            operationId: mutation.operationId,
            attemptCount: 1,
            principalHash: "principal-hash",
            keyHash: mutation.idempotencyKeyHash,
            scopeHash: "scope-hash",
            requestHash: "request-hash",
            replayKey,
          },
        };
      },
    );
    mockCompleteTeamMutationIdempotency.mockImplementation(
      (
        _tx: unknown,
        mutation: { correlationId: string },
        claim: { replayKey: string },
        result: Record<string, unknown>,
        status: number,
      ) => {
        mutationReplays.set(claim.replayKey, {
          result,
          status,
          correlationId: mutation.correlationId,
        });
      },
    );
    mockSettleTeamMutationIdempotencyFailure.mockResolvedValue(undefined);
  });

  it("rejects a deleted contact under the shared outbound lock before writes", async () => {
    contact.deletedAt = new Date("2026-08-08T12:05:00.000Z");

    await expect(
      requireActiveContactForDirectOutbound(mockTx as never, contact.id),
    ).rejects.toMatchObject({
      code: "conflict",
      message:
        "This contact is in recovery. Restore it before sending a new message.",
    });

    expect(mockTx.execute).toHaveBeenCalledTimes(1);
    expect(mockTx.update).not.toHaveBeenCalled();
    expect(mockTx.insert).not.toHaveBeenCalled();
  });

  it("soft-deletes once, quarantines work, and leaves every linked row intact", async () => {
    const before = structuredClone(linkedRecords);
    const request = mutationRequest({
      version: contact.updatedAt.toISOString(),
      key: "contact-delete:first-request",
    });
    const response = await DELETE(request, context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      data: {
        deleted: true,
        softDeleted: true,
        pausedAutomationCount: 1,
        quarantinedOperationCount: 1,
      },
      receipt: {
        entityType: "contact",
        entityId: contact.id,
      },
    });
    expect(contact.deletedAt).toBeInstanceOf(Date);
    expect(contact.purgeEligibleAt).toBeInstanceOf(Date);
    expect(automation).toEqual({ paused: true, nextFollowupAt: null });
    expect(queuedOperations[0]!.quarantinedAt).toBeInstanceOf(Date);
    expect(linkedRecords).toEqual(before);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "contact.deleted",
      entityType: "contact",
      entityId: contact.id,
      meta: {
        instantQuotesPreserved: true,
        linkedRecordsPreserved: true,
        outboxQuarantinedCount: 1,
      },
    });
  });

  it("fails and quarantines a requested partner invite in the delete transaction", async () => {
    partnerInviteRows.push({
      id: "55555555-5555-4555-8555-555555555555",
      partnerUserId: "66666666-6666-4666-8666-666666666666",
      state: "requested",
      version: 1,
    });

    const response = await DELETE(
      mutationRequest({
        version: contact.updatedAt.toISOString(),
        key: "contact-delete:requested-partner-invite",
      }),
      context,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      data: { quarantinedRequestedPartnerInviteCount: 1 },
    });
    expect(partnerInviteRows[0]).toMatchObject({
      state: "failed",
      version: 2,
      failureCode: "contact_soft_deleted",
      retryable: false,
      quarantineReason: "contact_soft_deleted",
    });
    expect(auditRows.map((row) => row["action"])).toEqual([
      "partner_user.invite.quarantined",
      "contact.deleted",
    ]);
    expect(auditRows[1]?.["meta"]).toMatchObject({
      requestedPartnerInvitesQuarantinedCount: 1,
    });
  });

  it.each(["dispatched", "reconciliation_required"])(
    "blocks deletion while a partner invite is %s",
    async (state) => {
      partnerInviteRows.push({
        id: "55555555-5555-4555-8555-555555555555",
        partnerUserId: "66666666-6666-4666-8666-666666666666",
        state,
        version: 2,
      });

      const response = await DELETE(
        mutationRequest({
          version: contact.updatedAt.toISOString(),
          key: `contact-delete:blocked-partner-invite:${state}`,
        }),
        context,
      );
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(409);
      expect(body).toMatchObject({ ok: false, code: "conflict" });
      expect(contact.deletedAt).toBeNull();
      expect(auditRows).toHaveLength(0);
    },
  );

  it("makes a repeated delete idempotent without extending retention or auditing twice", async () => {
    const request = mutationRequest({
      version: contact.updatedAt.toISOString(),
      key: "contact-delete:lost-response",
    });
    await DELETE(request, context);
    const firstDeletedAt = contact.deletedAt;
    const firstRecoveryAt = contact.purgeEligibleAt;
    const response = await DELETE(request, context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.headers.get("idempotency-replayed")).toBe("true");
    expect(body).toMatchObject({
      ok: true,
      data: { deleted: true, softDeleted: true },
    });
    expect(contact.deletedAt).toBe(firstDeletedAt);
    expect(contact.purgeEligibleAt).toBe(firstRecoveryAt);
    expect(auditRows).toHaveLength(1);
  });

  it("rejects a competing delete with a stale version and preserves the first result", async () => {
    const originalVersion = contact.updatedAt.toISOString();
    await DELETE(
      mutationRequest({
        version: originalVersion,
        key: "contact-delete:concurrent-winner",
      }),
      context,
    );
    const firstDeletedAt = contact.deletedAt;

    const response = await DELETE(
      mutationRequest({
        version: originalVersion,
        key: "contact-delete:concurrent-loser",
      }),
      context,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      ok: false,
      code: "conflict",
      retryable: false,
    });
    expect(contact.deletedAt).toBe(firstDeletedAt);
    expect(auditRows).toHaveLength(1);
    expect(mockSettleTeamMutationIdempotencyFailure).toHaveBeenCalledTimes(1);
  });

  it("restores the contact but deliberately leaves automation and queued work contained", async () => {
    await DELETE(
      mutationRequest({
        version: contact.updatedAt.toISOString(),
        key: "contact-delete:before-restore",
      }),
      context,
    );
    const response = await RESTORE(
      mutationRequest({
        version: contact.updatedAt.toISOString(),
        key: "contact-restore:first-request",
      }),
      context,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      data: {
        restored: true,
        automationRemainsPaused: true,
        outboxRemainsQuarantined: true,
        requiresManualAutomationReview: true,
      },
    });
    expect(contact.deletedAt).toBeNull();
    expect(contact.deletedBy).toBeNull();
    expect(contact.purgeEligibleAt).toBeNull();
    expect(automation.paused).toBe(true);
    expect(queuedOperations[0]!.quarantinedAt).toBeInstanceOf(Date);
    expect(auditRows.map((row) => row["action"])).toEqual([
      "contact.deleted",
      "contact.restored",
    ]);
  });

  it("makes repeated restore idempotent without releasing contained work", async () => {
    await DELETE(
      mutationRequest({
        version: contact.updatedAt.toISOString(),
        key: "contact-delete:repeat-restore-setup",
      }),
      context,
    );
    const restoreRequest = mutationRequest({
      version: contact.updatedAt.toISOString(),
      key: "contact-restore:lost-response",
    });
    await RESTORE(restoreRequest, context);
    const response = await RESTORE(restoreRequest, context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      ok: true,
      data: {
        restored: true,
        automationRemainsPaused: true,
        outboxRemainsQuarantined: true,
      },
    });
    expect(response.headers.get("idempotency-replayed")).toBe("true");
    expect(automation.paused).toBe(true);
    expect(queuedOperations[0]!.quarantinedAt).toBeInstanceOf(Date);
    expect(auditRows.map((row) => row["action"])).toEqual([
      "contact.deleted",
      "contact.restored",
    ]);
  });

  it("rejects malformed contact identifiers before database access", async () => {
    const response = await DELETE(
      mutationRequest({
        version: contact.updatedAt.toISOString(),
        key: "contact-delete:malformed-id",
      }),
      {
        params: Promise.resolve({ contactId: "not-a-contact-id" }),
      },
    );

    expect(response.status).toBe(422);
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("audits denied permissions without opening a business transaction", async () => {
    mockRequirePermission.mockResolvedValue(
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    );

    const request = mutationRequest({
      version: contact.updatedAt.toISOString(),
      key: "contact-permission:denied-request",
    });
    expect((await DELETE(request, context)).status).toBe(403);
    expect((await RESTORE(request, context)).status).toBe(403);
    expect(mockRequirePermission.mock.calls).toEqual([
      [request, ["contacts.delete"], { mode: "all" }],
      [request, ["contacts.restore"], { mode: "all" }],
    ]);
    expect(mockGetDb).toHaveBeenCalledTimes(2);
    expect(mockDbInsert).toHaveBeenCalledTimes(2);
    expect(mockFailureAuditValues).toHaveBeenCalledTimes(2);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

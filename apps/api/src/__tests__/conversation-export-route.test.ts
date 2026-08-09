import type { NextRequest } from "next/server";

const mockRequirePermission = jest.fn();
const mockVerifiedActor = jest.fn();
const mockRecordAuditEvent = jest.fn<
  Promise<void>,
  [Record<string, unknown>]
>();
const mockGetDb = jest.fn();

jest.mock("drizzle-orm", () => {
  const expression = (...args: unknown[]) => ({ args });
  return {
    and: jest.fn(expression),
    asc: jest.fn(expression),
    eq: jest.fn(expression),
    gte: jest.fn(expression),
    inArray: jest.fn(expression),
    lt: jest.fn(expression),
    or: jest.fn(expression),
    sql: jest.fn((parts: TemplateStringsArray, ...values: unknown[]) => ({
      parts,
      values,
    })),
  };
});

jest.mock("@/db", () => ({
  auditLogs: {
    id: "audit_logs.id",
    action: "audit_logs.action",
    entityType: "audit_logs.entity_type",
    entityId: "audit_logs.entity_id",
    actorId: "audit_logs.actor_id",
    sessionId: "audit_logs.session_id",
    correlationId: "audit_logs.correlation_id",
    createdAt: "audit_logs.created_at",
  },
  conversationMessages: {
    id: "conversation_messages.id",
    threadId: "conversation_messages.thread_id",
    direction: "conversation_messages.direction",
    channel: "conversation_messages.channel",
    deliveryStatus: "conversation_messages.delivery_status",
    metadata: "conversation_messages.metadata",
    body: "conversation_messages.body",
    sentAt: "conversation_messages.sent_at",
    receivedAt: "conversation_messages.received_at",
    createdAt: "conversation_messages.created_at",
  },
  getDb: mockGetDb,
}));

jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: jest.fn(() => ({
    type: "human",
    id: "member-1",
    label: "Export operator",
    sessionId: "session-1",
    authMethod: "team_session",
  })),
  recordAuditEvent: mockRecordAuditEvent,
}));

jest.mock("@/lib/audit-metadata", () => ({
  sanitizeAuditMetadata: jest.fn((value: unknown) => value),
}));

jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));

jest.mock("@/lib/verified-actor-context", () => ({
  getVerifiedRequestActor: mockVerifiedActor,
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: jest.fn(() => true),
}));

import { POST, PUT } from "../../app/api/admin/inbox/export/jsonl/route";

const correlationId = "11111111-1111-4111-8111-111111111111";
const receiptId = "22222222-2222-4222-8222-222222222222";

function request(
  query = "",
  input: {
    method?: "POST" | "PUT";
    body?: Record<string, unknown>;
    origin?: string | null;
  } = {},
): NextRequest {
  const url = new URL(
    `https://api.example.test/api/admin/inbox/export/jsonl${query}`,
  );
  const origin = input.origin === undefined ? url.origin : input.origin;
  const headers = new Headers({
    "content-type": "application/json",
    "x-request-id": correlationId,
  });
  if (origin !== null) headers.set("origin", origin);
  const raw = new Request(url, {
    method: input.method ?? "POST",
    headers,
    body: JSON.stringify(input.body ?? { confirmed: true }),
  });
  Object.defineProperty(raw, "nextUrl", { value: url });
  return raw as unknown as NextRequest;
}

function successfulDb(): {
  transaction: jest.Mock;
  tx: { execute: jest.Mock; select: jest.Mock };
} {
  const preflight = [
    { id: "message-1", threadId: "thread-private", bodyBytes: 5 },
    { id: "message-2", threadId: "thread-private", bodyBytes: 2 },
  ];
  const rows = [
    {
      threadId: "thread-private",
      direction: "inbound",
      deliveryStatus: "received",
      draft: false,
      body: "Hello",
    },
    {
      threadId: "thread-private",
      direction: "outbound",
      deliveryStatus: "delivered",
      draft: false,
      body: "Hi",
    },
  ];
  const tx = {
    execute: jest.fn(() => Promise.resolve()),
    select: jest
      .fn()
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve(preflight) }),
          }),
        }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({ orderBy: () => Promise.resolve(rows) }),
        }),
      })),
  };
  return {
    tx,
    transaction: jest.fn(
      (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };
}

function finalizationDb(events: Array<Record<string, unknown>>): {
  transaction: jest.Mock;
  insertValues: jest.Mock;
} {
  const insertValues = jest.fn(() => Promise.resolve());
  const tx = {
    execute: jest.fn(() => Promise.resolve()),
    select: jest.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve(events) }),
        }),
      }),
    })),
    insert: jest.fn(() => ({ values: insertValues })),
  };
  return {
    insertValues,
    transaction: jest.fn(
      (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };
}

describe("conversation export route runtime boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequirePermission.mockResolvedValue(null);
    mockVerifiedActor.mockReturnValue({
      type: "human",
      id: "member-1",
      label: "Export operator",
      role: "office",
      sessionId: "session-1",
      authMethod: "team_session",
    });
    mockRecordAuditEvent.mockResolvedValue(undefined);
    mockGetDb.mockImplementation(() => {
      throw new Error("database must not be reached");
    });
  });

  it("audits an authenticated permission denial before data access", async () => {
    mockRequirePermission.mockResolvedValue(
      Response.json({ error: "forbidden" }, { status: 403 }),
    );

    const response = await POST(request("?days=invalid"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "forbidden",
      correlationId,
      supportId: correlationId,
      retryable: false,
    });
    expect(mockRequirePermission).toHaveBeenCalledWith(
      expect.anything(),
      "messages.export",
    );
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.export.denied",
        outcome: "denied",
        correlationId,
      }),
    );
  });

  it("records attempted and failed outcomes for an invalid query", async () => {
    const response = await POST(request("?days=30&days=7"));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_filter",
      field: "query",
      correlationId,
      truncated: false,
    });
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(2);
    expect(mockRecordAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      action: "conversation.export.attempted",
      outcome: "attempted",
      correlationId,
    });
    expect(mockRecordAuditEvent.mock.calls[1]?.[0]).toMatchObject({
      action: "conversation.export.failed",
      outcome: "failed",
      correlationId,
      meta: { reason: "invalid_query", sensitive: true, truncated: false },
    });
  });

  it("requires exact confirmation and same origin before reading data", async () => {
    const unconfirmed = await POST(
      request("?days=30", { body: { confirmed: false } }),
    );
    expect(unconfirmed.status).toBe(422);
    expect(mockGetDb).not.toHaveBeenCalled();

    jest.clearAllMocks();
    mockRequirePermission.mockResolvedValue(null);
    mockVerifiedActor.mockReturnValue({
      type: "human",
      id: "member-1",
      label: "Export operator",
      role: "office",
      sessionId: "session-1",
      authMethod: "team_session",
    });
    mockRecordAuditEvent.mockResolvedValue(undefined);
    const crossOrigin = await POST(
      request("?days=30", { origin: "https://evil.example.test" }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("does not prepare bytes when the attempted audit is unavailable", async () => {
    mockRecordAuditEvent.mockRejectedValueOnce(new Error("audit unavailable"));

    const response = await POST(request("?days=30"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "conversation_export_audit_failed",
      correlationId,
    });
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("reports the database statement deadline truthfully without bytes", async () => {
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    const timeout = Object.assign(new Error("cancelled"), { code: "57014" });
    mockGetDb.mockReturnValue({
      transaction: jest.fn(() => Promise.reject(timeout)),
    });

    const response = await POST(request("?days=90"));

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      error: "conversation_export_timeout",
      correlationId,
      retryable: true,
    });
    const terminalAudit = mockRecordAuditEvent.mock.lastCall?.[0];
    expect(terminalAudit).toMatchObject({
      action: "conversation.export.failed",
    });
    expect(terminalAudit?.["meta"]).toMatchObject({
      reason: "preparation_timeout",
    });
    errorLog.mockRestore();
  });

  it("prepares complete bytes only after a bounded snapshot and prepared audit", async () => {
    const db = successfulDb();
    mockGetDb.mockReturnValue(db);

    const response = await POST(request("?days=7&channel=SMS"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );
    expect(response.headers.get("x-export-row-count")).toBe("1");
    expect(response.headers.get("x-export-message-count")).toBe("2");
    expect(response.headers.get("x-export-audit-state")).toBe("prepared");
    expect(response.headers.get("x-audit-correlation-id")).toBe(correlationId);
    const body = await response.text();
    expect(body).toBe(
      '{"messages":[{"role":"user","content":"Hello"},{"role":"assistant","content":"Hi"}]}\n',
    );
    expect(body).not.toContain("thread-private");
    expect(db.tx.execute).toHaveBeenCalledTimes(2);
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(2);
    expect(mockRecordAuditEvent.mock.calls[1]?.[0]).toMatchObject({
      action: "conversation.export.prepared",
      outcome: "attempted",
      correlationId,
      meta: {
        rowCount: 1,
        threadCount: 1,
        messageCount: 2,
        truncated: false,
      },
    });
  });

  it("atomically finalizes a prepared receipt and is idempotent", async () => {
    const preparedEvent = {
      id: "33333333-3333-4333-8333-333333333333",
      action: "conversation.export.prepared",
      entityId: receiptId,
      actorId: "member-1",
      sessionId: "session-1",
    };
    const db = finalizationDb([preparedEvent]);
    mockGetDb.mockReturnValue(db);

    const response = await PUT(
      request("", {
        method: "PUT",
        body: {
          correlationId,
          exportId: receiptId,
          outcome: "released",
          reason: null,
        },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      correlationId,
      exportId: receiptId,
      outcome: "released",
      idempotent: false,
    });
    expect(db.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.export.released",
        outcome: "succeeded",
        entityId: receiptId,
        correlationId,
      }),
    );

    const replayDb = finalizationDb([
      preparedEvent,
      {
        id: "44444444-4444-4444-8444-444444444444",
        action: "conversation.export.released",
        entityId: receiptId,
        actorId: "member-1",
        sessionId: "session-1",
      },
    ]);
    mockGetDb.mockReturnValue(replayDb);
    const replay = await PUT(
      request("", {
        method: "PUT",
        body: {
          correlationId,
          exportId: receiptId,
          outcome: "released",
          reason: null,
        },
      }),
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true });
    expect(replayDb.insertValues).not.toHaveBeenCalled();
  });

  it("records a rejected prepared body as failed and blocks a later release", async () => {
    const preparedEvent = {
      id: "33333333-3333-4333-8333-333333333333",
      action: "conversation.export.prepared",
      entityId: receiptId,
      actorId: "member-1",
      sessionId: "session-1",
    };
    const failedDb = finalizationDb([preparedEvent]);
    mockGetDb.mockReturnValue(failedDb);
    const failed = await PUT(
      request("", {
        method: "PUT",
        body: {
          correlationId,
          exportId: receiptId,
          outcome: "failed",
          reason: "invalid_body",
        },
      }),
    );
    expect(failed.status).toBe(200);
    expect(failedDb.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.export.failed",
        outcome: "failed",
        entityId: receiptId,
      }),
    );

    const conflictDb = finalizationDb([
      preparedEvent,
      {
        id: "44444444-4444-4444-8444-444444444444",
        action: "conversation.export.failed",
        entityId: receiptId,
        actorId: "member-1",
        sessionId: "session-1",
      },
    ]);
    mockGetDb.mockReturnValue(conflictDb);
    const release = await PUT(
      request("", {
        method: "PUT",
        body: {
          correlationId,
          exportId: receiptId,
          outcome: "released",
          reason: null,
        },
      }),
    );
    expect(release.status).toBe(409);
    await expect(release.json()).resolves.toMatchObject({
      error: "export_already_finalized",
      correlationId,
    });
    expect(conflictDb.insertValues).not.toHaveBeenCalled();
  });
});

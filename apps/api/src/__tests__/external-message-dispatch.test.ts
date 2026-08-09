import fs from "node:fs";
import path from "node:path";
import {
  MESSAGE_DISPATCH_RECONCILIATION_REASON,
  planContactDispatchEligibility,
  planPersistedMessageDispatch,
} from "@/lib/external-message-dispatch";
import { sendDmMessage, sendSmsMessage } from "@/lib/messaging";

const API_ROOT = path.resolve(__dirname, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

function dispatchState(
  overrides: Partial<{
    state:
      | "requested"
      | "dispatched"
      | "succeeded"
      | "failed"
      | "reconciliation_required";
    uncertaintyAt: Date | null;
    retryable: boolean | null;
    failureDetail: string | null;
  }> = {},
) {
  return {
    state: "requested" as const,
    uncertaintyAt: null,
    retryable: null,
    failureDetail: null,
    ...overrides,
  };
}

describe("durable external message dispatch planning", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");

  it("claims requested work but never reclaims a dispatched provider effect", () => {
    expect(planPersistedMessageDispatch(dispatchState(), now)).toEqual({
      kind: "claim",
    });
    expect(
      planPersistedMessageDispatch(
        dispatchState({
          state: "dispatched",
          uncertaintyAt: new Date("2026-08-08T12:15:00.000Z"),
        }),
        now,
      ),
    ).toEqual({
      kind: "in_flight",
      retryAt: new Date("2026-08-08T12:15:00.000Z"),
    });
  });

  it("routes a stale dispatched effect to reconciliation, never retry", () => {
    expect(
      planPersistedMessageDispatch(
        dispatchState({
          state: "dispatched",
          uncertaintyAt: new Date("2026-08-08T11:59:59.000Z"),
        }),
        now,
      ),
    ).toEqual({
      kind: "settled",
      state: "reconciliation_required",
      retryable: false,
      error: MESSAGE_DISPATCH_RECONCILIATION_REASON,
      outboxFinalized: false,
    });
  });

  it("resumes terminal database evidence without another provider call", () => {
    expect(
      planPersistedMessageDispatch(dispatchState({ state: "succeeded" }), now),
    ).toEqual({
      kind: "settled",
      state: "succeeded",
      retryable: false,
      error: null,
      outboxFinalized: false,
    });
    expect(
      planPersistedMessageDispatch(
        dispatchState({
          state: "failed",
          retryable: true,
          failureDetail: "provider_rejected",
        }),
        now,
      ),
    ).toEqual({
      kind: "settled",
      state: "failed",
      retryable: true,
      error: "provider_rejected",
      outboxFinalized: false,
    });
    expect(
      planPersistedMessageDispatch(
        dispatchState({
          state: "reconciliation_required",
          retryable: false,
          failureDetail: "transport_uncertain",
        }),
        now,
      ),
    ).toEqual({
      kind: "settled",
      state: "reconciliation_required",
      retryable: false,
      error: "transport_uncertain",
      outboxFinalized: true,
    });
  });

  it("blocks DNC at dispatch time unless the queued Inbox message carries its explicit override", () => {
    expect(
      planContactDispatchEligibility(
        { deletedAt: null, doNotContact: true },
        false,
      ),
    ).toEqual({
      kind: "blocked",
      reason: "contact_dnc_before_message_dispatch",
    });
    expect(
      planContactDispatchEligibility(
        { deletedAt: null, doNotContact: true },
        true,
      ),
    ).toEqual({ kind: "eligible", dncOverrideUsed: true });
    expect(
      planContactDispatchEligibility(
        { deletedAt: new Date(), doNotContact: false },
        true,
      ),
    ).toEqual({
      kind: "blocked",
      reason: "contact_unavailable_before_message_dispatch",
    });
  });
});

describe("provider certainty contracts", () => {
  const envSnapshot = { ...process.env };
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env = { ...envSnapshot };
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("classifies a preflight Twilio failure as definitely not sent", async () => {
    delete process.env["TWILIO_ACCOUNT_SID"];
    delete process.env["TWILIO_AUTH_TOKEN"];
    delete process.env["TWILIO_FROM"];

    await expect(sendSmsMessage("+15555550100", "hello")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        provider: "twilio",
        deliveryCertainty: "not_sent",
        providerIdempotencySupported: false,
      }),
    );
  });

  it("classifies a Twilio transport exception as uncertain", async () => {
    process.env["TWILIO_ACCOUNT_SID"] = "AC00000000000000000000000000000000";
    process.env["TWILIO_AUTH_TOKEN"] = "test_token";
    process.env["TWILIO_FROM"] = "+15555550101";
    global.fetch = jest.fn(() =>
      Promise.reject(new Error("connection_lost_after_write")),
    ) as typeof fetch;

    await expect(
      sendSmsMessage("+15555550100", "hello", null, {
        idempotencyKey: "dispatch-key",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        provider: "twilio",
        deliveryCertainty: "uncertain",
        providerIdempotencySupported: false,
      }),
    );
  });

  it("does not report success when Twilio accepts HTTP but omits a valid provider SID", async () => {
    process.env["TWILIO_ACCOUNT_SID"] = "AC00000000000000000000000000000000";
    process.env["TWILIO_AUTH_TOKEN"] = "test_token";
    process.env["TWILIO_FROM"] = "+15555550101";
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response("{}", {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as typeof fetch;

    await expect(sendSmsMessage("+15555550100", "hello")).resolves.toEqual({
      ok: false,
      provider: "twilio",
      providerMessageId: null,
      providerOperationIds: [],
      providerIdempotencySupported: false,
      deliveryCertainty: "uncertain",
      detail: "sms_response_invalid",
    });
  });

  it("forwards a stable DM webhook key without assuming support", async () => {
    process.env["DM_WEBHOOK_URL"] = "https://provider.invalid/dm";
    process.env["DM_WEBHOOK_SUPPORTS_IDEMPOTENCY"] = "1";
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, messageId: "dm-123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    global.fetch = fetchMock as typeof fetch;

    const result = await sendDmMessage(
      "recipient",
      "hello",
      { source: "webhook" },
      [],
      { idempotencyKey: "stable-dispatch-key" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        providerMessageId: "dm-123",
        providerIdempotencySupported: true,
        deliveryCertainty: "accepted",
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toEqual(
      expect.objectContaining({ "Idempotency-Key": "stable-dispatch-key" }),
    );
    expect(typeof request.body).toBe("string");
    expect(request.body as string).toContain(
      '"idempotencyKey":"stable-dispatch-key"',
    );
  });

  it("marks partial Facebook DM fan-out as uncertain with operation evidence", async () => {
    delete process.env["DM_WEBHOOK_URL"];
    process.env["FB_MESSENGER_ACCESS_TOKEN"] = "system-token";
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "page-token" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message_id: "accepted-text" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("provider error", { status: 503 }));
    global.fetch = fetchMock as typeof fetch;

    const result = await sendDmMessage(
      "recipient",
      "hello",
      { dmProvider: "facebook", dmPageId: "page-unique-test" },
      ["https://assets.invalid/photo.jpg"],
      { idempotencyKey: "stable-dispatch-key" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        provider: "facebook",
        deliveryCertainty: "uncertain",
        providerIdempotencySupported: false,
        providerOperationIds: ["accepted-text"],
      }),
    );
    expect(result.detail).toContain("dm_partial_delivery:");
  });
});

describe("external message dispatch source contracts", () => {
  const migration = source(
    "src/db/migrations/0073_external_message_dispatches.sql",
  );
  const processor = source("src/lib/outbox-processor.ts");
  const dispatch = source("src/lib/external-message-dispatch.ts");
  const messaging = source("src/lib/messaging.ts");
  const deleteRoute = source("app/api/admin/contacts/[contactId]/route.ts");
  const retryRoute = source(
    "app/api/admin/inbox/messages/[messageId]/retry/route.ts",
  );
  const notifications = source("src/lib/notifications.ts");
  const directMessageRoute = source(
    "app/api/admin/inbox/threads/[threadId]/messages/route.ts",
  );

  it("registers migration 0073 at journal index 70", () => {
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const migrationIndex =
      journal.entries?.findIndex(
        (entry) => entry.tag === "0073_external_message_dispatches",
      ) ?? -1;
    expect(
      journal.entries?.slice(migrationIndex - 1, migrationIndex + 1),
    ).toEqual([
      expect.objectContaining({ idx: 69, tag: "0072_expense_integrity" }),
      expect.objectContaining({
        idx: 70,
        tag: "0073_external_message_dispatches",
      }),
    ]);
  });

  it("enforces forward-only state and immutable terminal evidence", () => {
    expect(migration).toContain("external_message_dispatch_state");
    expect(migration).toContain("requested");
    expect(migration).toContain("dispatched");
    expect(migration).toContain("succeeded");
    expect(migration).toContain("failed");
    expect(migration).toContain("reconciliation_required");
    expect(migration).toContain("external_message_dispatch_terminal_immutable");
    expect(migration).toContain(
      "external_message_dispatch_version_must_increment",
    );
    expect(migration).toContain("provider_idempotency_supported");
    expect(migration).toContain(
      "not a claim that the provider enforces exactly-once",
    );
    expect(migration).not.toMatch(/ON DELETE CASCADE/iu);
  });

  it("commits requested and dispatched before invoking any provider", () => {
    const requestedIndex = processor.indexOf(
      "await ensureMessageDispatchRequested({",
    );
    const dispatchedIndex = processor.indexOf("await claimMessageDispatch({");
    const providerIndex = processor.indexOf(
      "durableResult = await sendSmsMessage(",
    );
    const finalizedIndex = processor.indexOf("await finalizeMessageDispatch({");

    expect(requestedIndex).toBeGreaterThan(0);
    expect(dispatchedIndex).toBeGreaterThan(requestedIndex);
    expect(providerIndex).toBeGreaterThan(dispatchedIndex);
    expect(finalizedIndex).toBeGreaterThan(providerIndex);
    expect(processor).toContain("skipFinalization: true");
    expect(dispatch).toContain("message_dispatch_finalize_conflict");
    expect(dispatch).toContain("redispatchPrevented: true");
  });

  it("rechecks DNC under the contact lock and quarantines before provider dispatch", () => {
    const eligibility = dispatch.indexOf(
      "const eligibility = planContactDispatchEligibility(",
    );
    const quarantine = dispatch.indexOf(
      "quarantineReason: reason",
      eligibility,
    );
    const dispatchInsert = dispatch.indexOf(
      ".insert(externalMessageDispatches)",
      eligibility,
    );
    const existingReuse = dispatch.indexOf(
      'if (existing) return { kind: "ready" as const, dispatch: existing }',
      eligibility,
    );
    expect(eligibility).toBeGreaterThan(-1);
    expect(quarantine).toBeGreaterThan(eligibility);
    expect(existingReuse).toBeGreaterThan(quarantine);
    expect(dispatchInsert).toBeGreaterThan(quarantine);
    expect(dispatch).toContain("contact_dnc_before_message_dispatch");
    expect(dispatch).toContain('deliveryStatus: "failed"');
    expect(processor).toContain('metadata?.["allowDncOverride"] === true');
    expect(directMessageRoute).toContain("allowDncOverride: true");
    expect(directMessageRoute).toContain(
      'delete resolvedMetadata["allowDncOverride"]',
    );
    expect(directMessageRoute).toContain(
      'dncOverrideSource: "explicit_inbox_send"',
    );
    expect(notifications).not.toContain("allowDncOverride: true");
  });

  it("rechecks persisted DNC and the explicit override again at final provider claim", () => {
    const claim = dispatch.slice(
      dispatch.indexOf("export async function claimMessageDispatch"),
      dispatch.indexOf("export type FinalizeDispatchResult"),
    );
    const contactRead = claim.indexOf("doNotContact: contacts.doNotContact");
    const messageRead = claim.indexOf(
      "metadata: conversationMessages.metadata",
      contactRead,
    );
    const eligibility = claim.indexOf(
      "planContactDispatchEligibility(",
      messageRead,
    );
    const dispatchedWrite = claim.indexOf('state: "dispatched"', eligibility);

    expect(contactRead).toBeGreaterThan(-1);
    expect(messageRead).toBeGreaterThan(contactRead);
    expect(claim).toContain(
      'messageScope.metadata["allowDncOverride"] === true',
    );
    expect(eligibility).toBeGreaterThan(messageRead);
    expect(claim).toContain("contact_dnc_before_provider_dispatch");
    expect(dispatchedWrite).toBeGreaterThan(eligibility);
  });

  it("records provider IDs but refuses unsupported exactly-once claims", () => {
    expect(dispatch).toContain("providerOperationIds");
    expect(dispatch).toContain("providerOperationId");
    expect(dispatch).toContain("providerExactlyOnceClaimed: false");
    expect(messaging).toContain("providerIdempotencySupported: false");
    expect(messaging).toContain("DM_WEBHOOK_SUPPORTS_IDEMPOTENCY");
    expect(messaging).toContain('deliveryCertainty: "uncertain"');
    expect(messaging).toContain("dm_partial_delivery:");
  });

  it("fails contact deletion closed and quarantines only pre-dispatch work", () => {
    expect(deleteRoute).toContain("inArray(externalMessageDispatches.state");
    expect(deleteRoute).toContain('"dispatched"');
    expect(deleteRoute).toContain('"reconciliation_required"');
    expect(deleteRoute).toContain('inFlightDispatchPolicy: "fail_closed"');
    expect(deleteRoute).toContain(
      "contact_soft_deleted_before_provider_dispatch",
    );
    expect(deleteRoute).toContain(
      'eq(externalMessageDispatches.state, "requested")',
    );
  });

  it("blocks manual replay of succeeded or uncertain dispatches", () => {
    expect(retryRoute).toContain(
      'latestDispatch?.state === "reconciliation_required"',
    );
    expect(retryRoute).toContain('latestDispatch?.state === "dispatched"');
    expect(retryRoute).toContain('latestDispatch?.state === "succeeded"');
    expect(retryRoute).not.toContain("attempts: 0");
  });

  it("queues contact appointment and quote email through message.send", () => {
    expect(notifications).toContain('channel: "email"');
    expect(notifications).toContain("emailAttachments: calendarAttachment");
    expect(notifications).toContain(
      "estimate.confirmation:${appointment.id}:${reason}:email",
    );
    expect(notifications).toContain("quoteSentMessageDedupeKey(");
    expect(notifications).toContain("payload.sendAttemptId");
    expect(notifications).toContain(
      "quote.decision:${payload.quoteId}:${payload.decision}:${payload.source}:email",
    );
  });
});

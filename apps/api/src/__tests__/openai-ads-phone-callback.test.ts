import { jest } from "@jest/globals";
import { NextRequest } from "next/server";
import * as databaseModule from "@/db";
import { callRecords, contacts, outboxEvents } from "@/db";
import type { verifyTwilioWebhookRequest as VerifyWebhook } from "@/lib/twilio-webhook-auth";
import type { POST as DialActionPost } from "../../app/api/webhooks/twilio/dial-action/route";

const verifyTwilioWebhookRequest = jest.fn<typeof VerifyWebhook>();
const getDbMock = jest.fn<typeof databaseModule.getDb>();
let POST: typeof DialActionPost;

beforeAll(async () => {
  jest.resetModules();
  // This repository runs both CommonJS focused suites and ESM integration suites.
  const mock =
    typeof require === "function"
      ? jest.doMock.bind(jest)
      : jest.unstable_mockModule.bind(jest);
  mock("@/db", () => ({ ...databaseModule, getDb: getDbMock }));
  mock("@/lib/twilio-webhook-auth", () => ({ verifyTwilioWebhookRequest }));
  mock("../../app/api/web/utils", () => ({
    normalizePhone: (value: string) => ({ raw: value, e164: value }),
  }));
  mock("@/lib/manual-call-callbacks", () => ({
    handleManualCallDialActionCallback: jest.fn(),
    ManualCallCallbackError: Error,
  }));
  mock("@/lib/sales-escalation-call-operations", () => ({
    adoptLegacySalesEscalationCallback: jest.fn(),
    handleSalesEscalationDialActionCallback: jest.fn(),
    SalesEscalationCallbackError: Error,
  }));
  POST = (await import("../../app/api/webhooks/twilio/dial-action/route")).POST;
});

function request(): NextRequest {
  return new NextRequest(
    "https://api.example.com/api/webhooks/twilio/dial-action?mode=inbound",
    { method: "POST" },
  );
}

function verifiedPayload(patch: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    CallSid: "CAparent",
    Direction: "inbound",
    From: "+14155552671",
    To: "+14045550100",
    CallStatus: "in-progress",
    DialCallSid: "CAchild",
    DialCallStatus: "completed",
    DialCallDuration: "45",
    DialBridged: "true",
    ...patch,
  }))
    data.set(key, value);
  jest.mocked(verifyTwilioWebhookRequest).mockResolvedValue({
    ok: true,
    formData: data,
    rawBody: "",
    externalUrl: "https://api.example.com",
  } as Awaited<ReturnType<typeof verifyTwilioWebhookRequest>>);
}

function installDatabase(
  options: { consent?: boolean; failOutbox?: boolean } = {},
) {
  const events = new Map<string, Record<string, unknown>>();
  let callsWritten = 0;
  let transactionError: unknown;
  const database = {
    select: () => {
      let table: unknown;
      const chain = {
        from: (value: unknown) => {
          table = value;
          return chain;
        },
        where: () => chain,
        orderBy: () => chain,
        limit: () =>
          Promise.resolve(
            table === contacts
              ? [{ id: "contact-123" }]
              : [
                  {
                    formPayload: {
                      openaiAds: {
                        consent: options.consent ?? true,
                        consentId: "c8ce1f24-3eb8-4ec5-b024-8017ca71a19a",
                        capturedAt: new Date().toISOString(),
                        oppref: "original-click-identity",
                      },
                    },
                  },
                ],
          ),
      };
      return chain;
    },
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => ({
        onConflictDoUpdate: () => {
          expect(table).toBe(callRecords);
          callsWritten += 1;
          return Promise.resolve();
        },
        onConflictDoNothing: () => {
          expect(table).toBe(outboxEvents);
          if (options.failOutbox)
            return Promise.reject(new Error("database unavailable"));
          const id = value["id"] as string;
          if (!events.has(id)) events.set(id, value);
          return Promise.resolve();
        },
      }),
    }),
    transaction: async (callback: (tx: unknown) => Promise<void>) => {
      const previousCalls = callsWritten;
      try {
        await callback(database);
      } catch (error) {
        transactionError = error;
        callsWritten = previousCalls;
        throw error;
      }
    },
  };
  getDbMock.mockReturnValue(
    database as unknown as ReturnType<typeof databaseModule.getDb>,
  );
  return {
    events,
    callsWritten: () => callsWritten,
    transactionError: () => transactionError,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe("signed inbound dial callback ads capture", () => {
  it("queues one phone inquiry from a real completed bridged leg across duplicate callbacks", async () => {
    const fixture = installDatabase();
    verifiedPayload();
    const response = await POST(request());
    expect(getDbMock).toHaveBeenCalled();
    expect(fixture.transactionError()).toBeUndefined();
    expect(response.status).toBe(200);
    expect((await POST(request())).status).toBe(200);
    expect(fixture.events.size).toBe(1);
    const queued = [...fixture.events.values()][0]!;
    expect(queued["payload"]).toMatchObject({
      contactId: "contact-123",
      consentId: "c8ce1f24-3eb8-4ec5-b024-8017ca71a19a",
      event: {
        id: "phone:CAparent",
        type: "lead_created",
        action_source: "phone_call",
        oppref: "original-click-identity",
      },
    });
    expect(fixture.callsWritten()).toBe(2);
  });

  it.each([
    { DialCallStatus: "no-answer" },
    { Direction: "outbound-dial" },
    { DialBridged: "false" },
    { AnsweredBy: "machine_end_beep" },
    { DialCallDuration: "12", CallDuration: "300" },
  ])(
    "does not count failed, outbound, unbridged, machine, or short calls",
    async (patch) => {
      const fixture = installDatabase();
      verifiedPayload(patch);
      expect((await POST(request())).status).toBe(200);
      expect(fixture.events.size).toBe(0);
    },
  );

  it("honors a stored denial and rolls back call persistence on queue failure", async () => {
    const denied = installDatabase({ consent: false });
    verifiedPayload();
    expect((await POST(request())).status).toBe(200);
    expect(denied.events.size).toBe(0);
    jest.restoreAllMocks();
    const failed = installDatabase({ failOutbox: true });
    expect((await POST(request())).status).toBe(500);
    expect(failed.callsWritten()).toBe(0);
    expect(failed.events.size).toBe(0);
  });

  it("rejects an unauthenticated callback before opening a database transaction", async () => {
    jest.mocked(verifyTwilioWebhookRequest).mockResolvedValue({
      ok: false,
      response: new Response("invalid signature", { status: 403 }),
    });
    expect((await POST(request())).status).toBe(403);
    expect(getDbMock).not.toHaveBeenCalled();
  });
});

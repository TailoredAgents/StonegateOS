import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_SIMULATED_CHAT_MESSAGES,
  MAX_SIMULATED_CHAT_MESSAGE_CHARS,
  parseSimulatedChatRequest,
} from "@/lib/simulated-chat-request";

const apiRoute = readFileSync(
  join(process.cwd(), "app/api/admin/sales/simulated-chat/route.ts"),
  "utf8",
);
const siteRoute = readFileSync(
  join(process.cwd(), "../site/src/app/api/team/simulated-chat/route.ts"),
  "utf8",
);
const simulatorUi = readFileSync(
  join(
    process.cwd(),
    "../site/src/app/team/components/SimulatedChatSection.tsx",
  ),
  "utf8",
);

describe("Simulator safety boundary", () => {
  it("uses a simulation-only permission rather than external-send authority", () => {
    expect(apiRoute).toContain('"automation.simulate"');
    expect(siteRoute).toContain('permissions: "automation.simulate"');
    expect(apiRoute).not.toContain(
      'requirePermission(request, "messages.send")',
    );
    expect(siteRoute).not.toContain('permissions: "messages.send"');
  });

  it("does not import or invoke provider dispatch and database write APIs", () => {
    expect(apiRoute).not.toMatch(/twilio|sendSms|sendEmail|messenger|outbox/iu);
    expect(apiRoute).not.toMatch(/\.insert\(|\.update\(|\.delete\(/u);
    expect(apiRoute).toContain("simulateFacebookSalesChatTurn");
    expect(apiRoute).toContain(
      "set transaction isolation level repeatable read read only",
    );
    expect(apiRoute).toContain("readBoundedJsonRequest");
    expect(siteRoute).toContain("readBoundedRequestBytes");
  });

  it("defaults to no live contact and does not persist contact identity", () => {
    expect(simulatorUi).toContain("useState<ContactOption | null>(null)");
    expect(simulatorUi).toContain("usedLiveContact: selectedContact !== null");
    expect(simulatorUi).not.toContain("contactName: selectedContact");
    expect(simulatorUi).toContain("Contact IDs and names are not stored");
    expect(simulatorUi).toContain("No CRM changes");
  });

  it("bounds retention and supports explicit restore and deletion", () => {
    expect(simulatorUi).toContain("MAX_SAVED_RUNS = 20");
    expect(simulatorUi).toContain("MAX_SAVED_MESSAGES = 40");
    expect(simulatorUi).toContain("MAX_SAVED_BYTES = 200_000");
    expect(simulatorUi).toContain("SAVED_RUN_RETENTION_MS");
    expect(simulatorUi).toContain("fitRunsToStorageLimit");
    expect(simulatorUi).toContain("Restore transcript");
    expect(simulatorUi).toContain("Delete saved run");
    expect(simulatorUi).toContain("Confirm clear");
  });

  it("restores the unsent customer input after a recoverable failure", () => {
    expect(simulatorUi).toContain("const priorMessages = messages");
    expect(simulatorUi).toContain("setMessages(priorMessages)");
    expect(simulatorUi).toContain("setInput(body)");
    expect(simulatorUi).toContain("setIncludePhotos(priorIncludePhotos)");
    expect(simulatorUi).toContain(
      'payload?.message ?? payload?.error ?? "Simulation failed"',
    );
  });

  it("accepts the exact bounded browser contract", () => {
    expect(
      parseSimulatedChatRequest({
        channel: "sms",
        simulationMode: "assist",
        contactId: "11111111-1111-4111-8111-111111111111",
        messages: [
          {
            role: "customer",
            body: "Can you help this week?",
            mediaUrls: ["simulated-photo://customer-upload"],
            createdAt: "2026-08-09T12:00:00.000Z",
          },
        ],
        previousQuoteRange: null,
        previousOfferedSlots: [],
      }),
    ).toMatchObject({
      ok: true,
      value: {
        channel: "sms",
        simulationMode: "assist",
        messages: [{ role: "customer", body: "Can you help this week?" }],
      },
    });
  });

  it("rejects truncation, oversized text, live media URLs, and unknown fields", () => {
    const base = {
      channel: "sms",
      simulationMode: "assist",
      contactId: null,
      previousQuoteRange: null,
      previousOfferedSlots: [],
    };
    expect(
      parseSimulatedChatRequest({
        ...base,
        messages: Array.from(
          { length: MAX_SIMULATED_CHAT_MESSAGES + 1 },
          () => ({ role: "customer", body: "hello" }),
        ),
      }),
    ).toMatchObject({ ok: false, error: "invalid_messages" });
    expect(
      parseSimulatedChatRequest({
        ...base,
        messages: [
          {
            role: "customer",
            body: "x".repeat(MAX_SIMULATED_CHAT_MESSAGE_CHARS + 1),
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: "invalid_messages" });
    expect(
      parseSimulatedChatRequest({
        ...base,
        messages: [
          {
            role: "customer",
            body: "photo",
            mediaUrls: ["https://customer.example/private.jpg"],
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: "invalid_messages" });
    expect(
      parseSimulatedChatRequest({
        ...base,
        messages: [{ role: "customer", body: "hello" }],
        dispatch: true,
      }),
    ).toMatchObject({ ok: false, error: "invalid_payload" });
  });
});

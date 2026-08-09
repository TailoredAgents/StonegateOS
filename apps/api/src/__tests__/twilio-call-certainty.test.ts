import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTwilioOutboundCall } from "@/lib/twilio-calls";

const environment = { ...process.env };
const originalFetch = global.fetch;
const input = {
  to: "+15555550123",
  requestUrl:
    "https://api.example.test/api/webhooks/twilio/connect?requestKey=11111111-1111-4111-8111-111111111111",
  statusCallbackUrl:
    "https://api.example.test/api/webhooks/twilio/call-status?leg=agent&requestKey=11111111-1111-4111-8111-111111111111",
};

function configure(): void {
  process.env["TWILIO_ACCOUNT_SID"] = "AC00000000000000000000000000000000";
  process.env["TWILIO_AUTH_TOKEN"] = "twilio-test-token";
  process.env["TWILIO_FROM"] = "+15555550101";
  process.env["TWILIO_API_BASE_URL"] = "https://api.twilio.com";
  process.env["TWILIO_WEBHOOK_PUBLIC_BASE_URL"] = "https://api.example.test";
  delete process.env["E2E_RUN_ID"];
  delete process.env["TEAM_CRM_AUDIT_MODE"];
}

afterEach(() => {
  process.env = { ...environment };
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe("Twilio outbound-call certainty", () => {
  it("fails before dispatch when configuration is missing", async () => {
    delete process.env["TWILIO_ACCOUNT_SID"];
    delete process.env["TWILIO_AUTH_TOKEN"];
    delete process.env["TWILIO_FROM"];
    global.fetch = jest.fn() as typeof fetch;

    await expect(createTwilioOutboundCall(input)).resolves.toMatchObject({
      ok: false,
      deliveryCertainty: "not_sent",
      detail: "twilio_call_not_configured",
      status: null,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [429, "not_sent"],
    [400, "not_sent"],
    [408, "uncertain"],
    [503, "uncertain"],
  ] as const)(
    "classifies provider status %s as %s",
    async (status, deliveryCertainty) => {
      configure();
      global.fetch = jest.fn(() =>
        Promise.resolve(new Response("{}", { status })),
      ) as typeof fetch;

      const expectedDetail =
        status === 408 ? "twilio_call_timeout" : `twilio_call_failed:${status}`;
      await expect(createTwilioOutboundCall(input)).resolves.toMatchObject({
        ok: false,
        deliveryCertainty,
        detail: expectedDetail,
        status,
      });
    },
  );

  it("requires a valid call SID before reporting provider acceptance", async () => {
    configure();
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response("{}", {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as typeof fetch;
    await expect(createTwilioOutboundCall(input)).resolves.toMatchObject({
      ok: false,
      deliveryCertainty: "uncertain",
      detail: "twilio_call_response_invalid",
      status: 201,
    });

    const callSid = `CA${"a".repeat(32)}`;
    global.fetch = jest.fn(() =>
      Promise.resolve(Response.json({ sid: callSid }, { status: 201 })),
    ) as typeof fetch;
    await expect(createTwilioOutboundCall(input)).resolves.toEqual({
      ok: true,
      callSid,
      provider: "twilio",
      deliveryCertainty: "accepted",
      providerIdempotencySupported: false,
      retryable: false,
    });
  });

  it("classifies a transport exception as uncertain", async () => {
    configure();
    global.fetch = jest.fn(() =>
      Promise.reject(new Error("connection lost after write")),
    ) as typeof fetch;
    await expect(createTwilioOutboundCall(input)).resolves.toMatchObject({
      ok: false,
      deliveryCertainty: "uncertain",
      detail: "twilio_call_transport_error",
      status: null,
    });
  });
});

describe("manual Team call route safety", () => {
  const source = readFileSync(
    resolve(process.cwd(), "app/api/admin/calls/start/route.ts"),
    "utf8",
  );
  const operations = readFileSync(
    resolve(process.cwd(), "src/lib/manual-call-operations.ts"),
    "utf8",
  );

  it("derives both call legs from active CRM records and blocks DNC before provider work", () => {
    expect(source).not.toContain("json.toPhone");
    expect(source).not.toContain("json.agentPhone");
    expect(source).not.toContain("team_member_phones");
    expect(operations).toContain("teamMembers.phoneE164");
    expect(operations).toContain("!agent.active");
    const prepare = operations.slice(
      operations.indexOf("export async function prepareManualCallOperation"),
      operations.indexOf("function callSuccessData"),
    );
    expect(prepare.indexOf("if (contact.doNotContact)")).toBeLessThan(
      prepare.indexOf('state: "dispatched"'),
    );
    expect(source.indexOf("prepareManualCallOperation({")).toBeLessThan(
      source.indexOf("createTwilioOutboundCall({"),
    );
  });

  it("does not put phone numbers in logs or append-only audit metadata", () => {
    expect(source).not.toContain("console.");
    expect(operations).not.toMatch(/metadata:\s*\{[^}]*Phone/su);
    expect(source).toContain("terminal_receipt");
    expect(source).toContain("Do not retry");
  });
});

import {
  DEFAULT_TWILIO_API_BASE_URL,
  getTwilioApiBaseUrl,
  isTwilioAccountSid,
  isTwilioCallSid,
  isTwilioMessageSid,
  isTwilioRecordingSid,
  resolveTwilioApiEndpoint,
} from "@myst-os/sdk";

const accountSid = `AC${"0".repeat(32)}`;
const callSid = `CA${"1".repeat(32)}`;
const recordingSid = `RE${"2".repeat(32)}`;
const loopbackEnvironment = {
  E2E_RUN_ID: "twilio-audit",
  TWILIO_API_BASE_URL: "http://127.0.0.1:4010",
};

describe("Twilio provider endpoint safety", () => {
  it("uses the official credential-free HTTPS origin by default", () => {
    expect(getTwilioApiBaseUrl({}).toString()).toBe(
      new URL(DEFAULT_TWILIO_API_BASE_URL).toString(),
    );
  });

  it("resolves every active REST operation through encoded typed endpoints", () => {
    expect(
      resolveTwilioApiEndpoint(
        { kind: "messages", accountSid },
        loopbackEnvironment,
      ),
    ).toBe(
      `${loopbackEnvironment.TWILIO_API_BASE_URL}/2010-04-01/Accounts/${accountSid}/Messages.json`,
    );
    expect(
      resolveTwilioApiEndpoint(
        { kind: "calls", accountSid },
        loopbackEnvironment,
      ),
    ).toBe(
      `${loopbackEnvironment.TWILIO_API_BASE_URL}/2010-04-01/Accounts/${accountSid}/Calls.json`,
    );
    expect(
      resolveTwilioApiEndpoint(
        { kind: "recordings.list", accountSid, callSid },
        loopbackEnvironment,
      ),
    ).toBe(
      `${loopbackEnvironment.TWILIO_API_BASE_URL}/2010-04-01/Accounts/${accountSid}/Calls/${callSid}/Recordings.json`,
    );
    expect(
      resolveTwilioApiEndpoint(
        {
          kind: "recordings.download",
          accountSid,
          recordingSid,
          format: "wav",
        },
        loopbackEnvironment,
      ),
    ).toBe(
      `${loopbackEnvironment.TWILIO_API_BASE_URL}/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.wav`,
    );
    expect(
      resolveTwilioApiEndpoint(
        { kind: "recordings.delete", accountSid, recordingSid },
        loopbackEnvironment,
      ),
    ).toBe(
      `${loopbackEnvironment.TWILIO_API_BASE_URL}/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.json`,
    );
  });

  it.each([
    ["not a URL", "valid absolute URL"],
    ["ftp://provider.example", "official Twilio API origin"],
    ["http://provider.example", "official Twilio API origin"],
    ["https://user:secret@provider.example", "credentials"],
    ["https://provider.example/twilio", "a path"],
    ["https://provider.example?secret=value", "query parameters"],
    ["https://provider.example#fragment", "fragment"],
  ])("rejects unsafe API base %s", (apiBaseUrl, message) => {
    expect(() =>
      getTwilioApiBaseUrl({ TWILIO_API_BASE_URL: apiBaseUrl }),
    ).toThrow(message);
  });

  it("allows loopback only in a controlled runtime and rejects it otherwise", () => {
    expect(getTwilioApiBaseUrl(loopbackEnvironment).origin).toBe(
      loopbackEnvironment.TWILIO_API_BASE_URL,
    );
    expect(() =>
      getTwilioApiBaseUrl({
        TWILIO_API_BASE_URL: loopbackEnvironment.TWILIO_API_BASE_URL,
        NODE_ENV: "production",
      }),
    ).toThrow("official Twilio API origin");
  });

  it.each(["https://provider.example", "https://api.twilio.com.example"])(
    "rejects credential exfiltration base %s in ordinary development and production",
    (apiBaseUrl) => {
      expect(() =>
        getTwilioApiBaseUrl({ TWILIO_API_BASE_URL: apiBaseUrl }),
      ).toThrow("official Twilio API origin");
      expect(() =>
        getTwilioApiBaseUrl({
          NODE_ENV: "production",
          TWILIO_API_BASE_URL: apiBaseUrl,
        }),
      ).toThrow("official Twilio API origin");
    },
  );

  it("allows only loopback in a dual-sentinel production audit run", () => {
    expect(
      getTwilioApiBaseUrl({
        ...loopbackEnvironment,
        NODE_ENV: "production",
        TEAM_CRM_AUDIT_MODE: "1",
      }).origin,
    ).toBe(loopbackEnvironment.TWILIO_API_BASE_URL);
    expect(() =>
      getTwilioApiBaseUrl({
        E2E_RUN_ID: "twilio-audit",
        NODE_ENV: "production",
        TEAM_CRM_AUDIT_MODE: "1",
      }),
    ).toThrow("must target a loopback service");
  });

  it.each([
    { E2E_RUN_ID: "production-build-audit" },
    { TEAM_CRM_AUDIT_MODE: "1" },
    {
      E2E_RUN_ID: "production-build-audit",
      TEAM_CRM_AUDIT_MODE: "true",
    },
    {
      E2E_RUN_ID: "production-build-audit",
      TEAM_CRM_AUDIT_MODE: "0",
    },
  ])("rejects a lone or invalid production sentinel %j", (sentinels) => {
    expect(() =>
      getTwilioApiBaseUrl({ NODE_ENV: "production", ...sentinels }),
    ).toThrow("Production provider-test runtime requires both");
  });

  it("fails closed before the public fallback whenever a test sentinel is active", () => {
    expect(() => getTwilioApiBaseUrl({ E2E_RUN_ID: "twilio-audit" })).toThrow(
      "must target a loopback service",
    );
    expect(() =>
      getTwilioApiBaseUrl({
        TEAM_CRM_AUDIT_MODE: "true",
        TWILIO_API_BASE_URL: DEFAULT_TWILIO_API_BASE_URL,
      }),
    ).toThrow("must target a loopback service");
  });

  it("accepts only exact Twilio SID shapes", () => {
    expect(isTwilioAccountSid(accountSid)).toBe(true);
    expect(isTwilioCallSid(callSid)).toBe(true);
    expect(isTwilioMessageSid(`SM${"3".repeat(32)}`)).toBe(true);
    expect(isTwilioRecordingSid(recordingSid)).toBe(true);
    for (const invalid of [
      "",
      "CA123",
      `XX${"1".repeat(32)}`,
      `CA${"g".repeat(32)}`,
      `${callSid}suffix`,
    ]) {
      expect(isTwilioCallSid(invalid)).toBe(false);
    }
    expect(() =>
      resolveTwilioApiEndpoint(
        { kind: "recordings.list", accountSid, callSid: "../private" },
        loopbackEnvironment,
      ),
    ).toThrow("call SID is invalid");
  });
});

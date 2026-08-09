import type { NextRequest } from "next/server";

type RateLimitRow = { count: number; resetAt: Date };

let returnedRows: RateLimitRow[] = [];
const returning = jest.fn(() => {
  const row = returnedRows.shift();
  return Promise.resolve(row ? [row] : []);
});
const onConflictDoUpdate = jest.fn(() => ({ returning }));
const values = jest.fn(() => ({ onConflictDoUpdate }));
const mockDb = {
  insert: jest.fn(() => ({ values })),
};

jest.mock("@/db", () => ({
  getDb: () => mockDb,
  teamAuthRateLimits: {
    bucket: "team_auth_rate_limits.bucket",
    keyHash: "team_auth_rate_limits.key_hash",
    count: "team_auth_rate_limits.count",
    windowStartedAt: "team_auth_rate_limits.window_started_at",
    resetAt: "team_auth_rate_limits.reset_at",
  },
}));

import {
  consumeTeamAuthRateLimit,
  hashTeamAuthRateLimitKey,
} from "@/lib/team-auth-rate-limit";

function request(headers: Record<string, string> = {}): NextRequest {
  return { headers: new Headers(headers) } as NextRequest;
}

describe("team authentication rate limiting", () => {
  const originalBypassToken = process.env["TEAM_AUTH_RATE_LIMIT_BYPASS_TOKEN"];
  const originalRateLimitSecret = process.env["TEAM_AUTH_RATE_LIMIT_SECRET"];
  const originalNodeEnv = process.env["NODE_ENV"];

  beforeEach(() => {
    returnedRows = [];
    mockDb.insert.mockClear();
    values.mockClear();
    onConflictDoUpdate.mockClear();
    returning.mockClear();
    process.env["NODE_ENV"] = "test";
    process.env["TEAM_AUTH_RATE_LIMIT_SECRET"] = "unit-test-secret";
    delete process.env["TEAM_AUTH_RATE_LIMIT_BYPASS_TOKEN"];
  });

  afterAll(() => {
    if (originalBypassToken === undefined) {
      delete process.env["TEAM_AUTH_RATE_LIMIT_BYPASS_TOKEN"];
    } else {
      process.env["TEAM_AUTH_RATE_LIMIT_BYPASS_TOKEN"] = originalBypassToken;
    }
    if (originalRateLimitSecret === undefined) {
      delete process.env["TEAM_AUTH_RATE_LIMIT_SECRET"];
    } else {
      process.env["TEAM_AUTH_RATE_LIMIT_SECRET"] = originalRateLimitSecret;
    }
    if (originalNodeEnv === undefined) {
      delete process.env["NODE_ENV"];
    } else {
      process.env["NODE_ENV"] = originalNodeEnv;
    }
  });

  it("consumes independent IP and identity buckets without storing raw identifiers", async () => {
    const now = new Date("2026-08-08T12:05:00.000Z");
    returnedRows.push(
      { count: 1, resetAt: new Date("2026-08-08T12:15:00.000Z") },
      { count: 1, resetAt: new Date("2026-08-08T12:15:00.000Z") },
    );

    const result = await consumeTeamAuthRateLimit({
      action: "request_link",
      request: request({ "x-forwarded-for": "203.0.113.4" }),
      identity: { kind: "email", value: "staff@example.com" },
      now,
    });

    expect(result).toEqual({ limited: false, retryAfterSeconds: 0 });
    expect(mockDb.insert).toHaveBeenCalledTimes(2);
    const serializedValues = JSON.stringify(values.mock.calls);
    expect(serializedValues).not.toContain("203.0.113.4");
    expect(serializedValues).not.toContain("staff@example.com");
    expect(values.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ bucket: "request_link:ip" }),
    );
    expect(values.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ bucket: "request_link:identity" }),
    );
  });

  it("blocks when either layer exceeds its policy and returns the window retry time", async () => {
    returnedRows.push(
      { count: 2, resetAt: new Date("2026-08-08T12:15:00.000Z") },
      { count: 4, resetAt: new Date("2026-08-08T12:15:00.000Z") },
    );

    await expect(
      consumeTeamAuthRateLimit({
        action: "request_link",
        request: request({ "cf-connecting-ip": "203.0.113.5" }),
        identity: { kind: "email", value: "staff@example.com" },
        now: new Date("2026-08-08T12:05:00.000Z"),
      }),
    ).resolves.toEqual({ limited: true, retryAfterSeconds: 600 });
  });

  it("does not consume an identity bucket after the client IP is already blocked", async () => {
    returnedRows.push({
      count: 31,
      resetAt: new Date("2026-08-08T12:15:00.000Z"),
    });

    await expect(
      consumeTeamAuthRateLimit({
        action: "password_login",
        request: request({ "x-real-ip": "203.0.113.6" }),
        identity: { kind: "email", value: "staff@example.com" },
        now: new Date("2026-08-08T12:05:00.000Z"),
      }),
    ).resolves.toEqual({ limited: true, retryAfterSeconds: 600 });
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it("uses distinct HMAC keys for different scopes", () => {
    const first = hashTeamAuthRateLimitKey(
      "request_link:identity",
      "email:staff@example.com",
    );
    const second = hashTeamAuthRateLimitKey(
      "password_login:identity",
      "email:staff@example.com",
    );

    expect(first).not.toBe(second);
    expect(first).not.toContain("staff@example.com");
  });

  it("isolates partner link requests in their own IP and identity buckets", async () => {
    returnedRows.push(
      { count: 1, resetAt: new Date("2026-08-08T12:15:00.000Z") },
      { count: 1, resetAt: new Date("2026-08-08T12:15:00.000Z") },
    );
    await expect(
      consumeTeamAuthRateLimit({
        action: "partner_request_link",
        request: request({ "x-forwarded-for": "203.0.113.18" }),
        identity: { kind: "email", value: "partner@example.com" },
        now: new Date("2026-08-08T12:05:00.000Z"),
      }),
    ).resolves.toEqual({ limited: false, retryAfterSeconds: 0 });
    expect(values.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ bucket: "partner_request_link:ip" }),
    );
    expect(values.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ bucket: "partner_request_link:identity" }),
    );
  });

  it("gives break-glass exchanges their own strict IP and recovery-type buckets", async () => {
    returnedRows.push(
      { count: 1, resetAt: new Date("2026-08-08T12:15:00.000Z") },
      { count: 1, resetAt: new Date("2026-08-08T12:15:00.000Z") },
    );

    await expect(
      consumeTeamAuthRateLimit({
        action: "break_glass_exchange",
        request: request({ "x-forwarded-for": "203.0.113.8" }),
        identity: { kind: "break_glass", value: "owner" },
        now: new Date("2026-08-08T12:05:00.000Z"),
      }),
    ).resolves.toEqual({ limited: false, retryAfterSeconds: 0 });

    expect(values.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ bucket: "break_glass_exchange:ip" }),
    );
    expect(values.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ bucket: "break_glass_exchange:identity" }),
    );
    expect(JSON.stringify(values.mock.calls)).not.toContain("203.0.113.8");
  });

  it("rejects a short HMAC secret in production", () => {
    process.env["NODE_ENV"] = "production";
    process.env["TEAM_AUTH_RATE_LIMIT_SECRET"] = "too-short";

    expect(() =>
      hashTeamAuthRateLimitKey(
        "request_link:identity",
        "email:staff@example.com",
      ),
    ).toThrow("must contain at least 32 bytes");
  });

  it("honors the explicit bypass only in a test environment with an exact token", async () => {
    process.env["TEAM_AUTH_RATE_LIMIT_BYPASS_TOKEN"] = "known-e2e-bypass";

    await expect(
      consumeTeamAuthRateLimit({
        action: "password_login",
        request: request({
          "x-team-auth-rate-limit-bypass": "known-e2e-bypass",
        }),
        identity: { kind: "email", value: "staff@example.com" },
      }),
    ).resolves.toEqual({ limited: false, retryAfterSeconds: 0 });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("never honors the bypass in production", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["TEAM_AUTH_RATE_LIMIT_SECRET"] = "s".repeat(32);
    process.env["TEAM_AUTH_RATE_LIMIT_BYPASS_TOKEN"] = "known-e2e-bypass";
    returnedRows.push(
      { count: 1, resetAt: new Date("2026-08-08T12:15:00.000Z") },
      { count: 1, resetAt: new Date("2026-08-08T12:15:00.000Z") },
    );

    await consumeTeamAuthRateLimit({
      action: "password_login",
      request: request({
        "x-team-auth-rate-limit-bypass": "known-e2e-bypass",
      }),
      identity: { kind: "email", value: "staff@example.com" },
      now: new Date("2026-08-08T12:05:00.000Z"),
    });

    expect(mockDb.insert).toHaveBeenCalledTimes(2);
  });
});

import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { derivePartnerInvitationActivationToken } from "@/lib/partner-invitation-handoff";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  name: string,
  factory: () => Record<string, unknown>,
) => void;
const acceptInvitation = jest.fn();
const inspectActivation = jest.fn();
const consumeRateLimit = jest.fn();
const allowedOrigin = jest.fn();

// The route, actual operational feature flag, response contract and credential
// derivation run. Persistence, origin decisions and rate limits are isolated.
mockModule("@/lib/partner-account-invitations", () => ({
  acceptPartnerAccountInvitation: acceptInvitation,
  PartnerInvitationAcceptanceSchema: z
    .object({ token: z.string().trim().length(43) })
    .strict(),
}));
mockModule("@/lib/partner-purpose-auth", () => ({
  inspectPartnerActivationToken: inspectActivation,
}));
mockModule("@/lib/team-auth-rate-limit", () => ({
  consumeTeamAuthRateLimit: consumeRateLimit,
}));
mockModule("@/lib/partner-portal-v2-security", () => ({
  isAllowedPartnerPortalMutationOrigin: allowedOrigin,
}));

const { POST } = await import(
  "../../app/api/portal/v2/invitations/accept/route"
);

const TOKEN = "A".repeat(43);
const CORRELATION = "invitation-readiness-test";
const EXPIRY = "2099-09-10T12:30:00.000Z";
const previousNodeEnv = process.env["NODE_ENV"];
const previousFlag = process.env["PARTNER_PORTAL_PURPOSE_AUTH_ENABLED"];

function request(includeIdempotency = true): NextRequest {
  return new NextRequest(
    "https://api.stonegate.example/api/portal/v2/invitations/accept",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://stonegate.example",
        "x-correlation-id": CORRELATION,
        ...(includeIdempotency
          ? { "idempotency-key": "invitation-readiness-attempt-1" }
          : {}),
      },
      body: JSON.stringify({ token: TOKEN }),
    },
  );
}

function expectNoCredentialProcessing() {
  expect(consumeRateLimit).not.toHaveBeenCalled();
  expect(acceptInvitation).not.toHaveBeenCalled();
  expect(inspectActivation).not.toHaveBeenCalled();
}

describe("invitation acceptance requires available password activation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env["NODE_ENV"] = "production";
    process.env["PARTNER_PORTAL_PURPOSE_AUTH_ENABLED"] = "true";
    allowedOrigin.mockReturnValue(true);
    consumeRateLimit.mockResolvedValue({
      limited: false,
      retryAfterSeconds: 0,
    });
    acceptInvitation.mockResolvedValue({ activationExpiresAt: EXPIRY });
  });

  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = previousNodeEnv;
    if (previousFlag === undefined)
      delete process.env["PARTNER_PORTAL_PURPOSE_AUTH_ENABLED"];
    else process.env["PARTNER_PORTAL_PURPOSE_AUTH_ENABLED"] = previousFlag;
  });

  it.each([undefined, "false", "0", "off", "", "misspelled"])(
    "does not consume the invitation or rate-limit budget when production flag is %s",
    async (flag) => {
      if (flag === undefined)
        delete process.env["PARTNER_PORTAL_PURPOSE_AUTH_ENABLED"];
      else process.env["PARTNER_PORTAL_PURPOSE_AUTH_ENABLED"] = flag;
      const incoming = request();
      const response = await POST(incoming);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("x-correlation-id")).toBe(CORRELATION);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: "service_unavailable",
        retryable: true,
        correlationId: CORRELATION,
      });
      expect(incoming.bodyUsed).toBe(false);
      expect(allowedOrigin).not.toHaveBeenCalled();
      expectNoCredentialProcessing();
    },
  );

  it("permits the same invitation attempt after activation is enabled", async () => {
    process.env["PARTNER_PORTAL_PURPOSE_AUTH_ENABLED"] = "false";
    expect((await POST(request())).status).toBe(503);
    expectNoCredentialProcessing();

    process.env["PARTNER_PORTAL_PURPOSE_AUTH_ENABLED"] = "true";
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      activationRequired: true,
      deliveryStatus: "ready",
      activationExpiresAt: EXPIRY,
      correlationId: CORRELATION,
    });
    expect(acceptInvitation).toHaveBeenCalledTimes(1);
    expect(acceptInvitation).toHaveBeenCalledWith({
      token: TOKEN,
      correlationId: CORRELATION,
    });
    expect(inspectActivation).not.toHaveBeenCalled();
    expect(consumeRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "partner_invitation_accept",
        identity: {
          kind: "token",
          value: createHash("sha256").update(TOKEN).digest("hex"),
        },
      }),
    );
  });

  it("resumes a lost handoff only by revalidating its existing derived activation", async () => {
    acceptInvitation.mockResolvedValue(null);
    inspectActivation.mockResolvedValue({
      kind: "success",
      expiresAt: new Date(EXPIRY),
    });
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      activationRequired: true,
      deliveryStatus: "ready",
      activationExpiresAt: EXPIRY,
      correlationId: CORRELATION,
    });
    expect(inspectActivation).toHaveBeenCalledWith(
      derivePartnerInvitationActivationToken(TOKEN),
    );
    expect(acceptInvitation).toHaveBeenCalledTimes(1);
  });

  it("does not renew an expired or invalid handoff on retry", async () => {
    acceptInvitation.mockResolvedValue(null);
    inspectActivation.mockResolvedValue({ kind: "invalid" });
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthorized" });
    expect(inspectActivation).toHaveBeenCalledTimes(1);
  });

  it("keeps origin rejection before credential processing when enabled", async () => {
    allowedOrigin.mockReturnValue(false);
    expect((await POST(request())).status).toBe(403);
    expectNoCredentialProcessing();
  });

  it("keeps explicit idempotency mandatory when enabled", async () => {
    const response = await POST(request(false));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "idempotency_key_required",
    });
    expectNoCredentialProcessing();
  });

  it("keeps rate limiting before acceptance and resumable inspection", async () => {
    consumeRateLimit.mockResolvedValue({
      limited: true,
      retryAfterSeconds: 60,
    });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(acceptInvitation).not.toHaveBeenCalled();
    expect(inspectActivation).not.toHaveBeenCalled();
  });
});

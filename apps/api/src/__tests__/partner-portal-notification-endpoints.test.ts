import fs from "node:fs";
import path from "node:path";
import {
  maskPartnerSmsDestination,
  normalizePartnerSmsDestination,
} from "@/lib/partner-notification-endpoints";
import { hasRecentPartnerNotificationEndpointMfa } from "@/lib/partner-notification-endpoint-authorization";

const apiRoot = path.resolve(process.cwd());

function source(relativePath: string): string {
  return fs.readFileSync(path.join(apiRoot, relativePath), "utf8");
}

function section(
  value: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = value.indexOf(startMarker);
  const end = value.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return value.slice(start, end);
}

describe("partner SMS destination presentation", () => {
  it.each([
    ["(202) 555-0123", "+12025550123"],
    ["202.555.0123", "+12025550123"],
    ["+44 20 7946 0958", "+442079460958"],
  ])("normalizes %s to canonical E.164", (input, expected) => {
    expect(normalizePartnerSmsDestination(input)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    202_555_0123,
    "",
    "not-a-phone",
    "+1 202 555",
    "1".repeat(81),
  ])("rejects an invalid SMS destination without coercion: %p", (input) => {
    expect(normalizePartnerSmsDestination(input)).toBeNull();
  });

  it("reveals only the final four digits in the public mask", () => {
    const raw = "+12025550123";
    const masked = maskPartnerSmsDestination(raw);

    expect(masked).toBe("•••• 0123");
    expect(masked).not.toContain("202555");
    expect(masked).not.toContain(raw);
  });

  it("refuses to mask a malformed destination", () => {
    expect(() => maskPartnerSmsDestination("not-a-phone")).toThrow(TypeError);
  });
});

describe("partner notification endpoint route security contracts", () => {
  const collectionRoute = source(
    "app/api/portal/v2/notification-endpoints/route.ts",
  );
  const verifyRoute = source(
    "app/api/portal/v2/notification-endpoints/[endpointId]/verify/route.ts",
  );
  const revokeRoute = source(
    "app/api/portal/v2/notification-endpoints/[endpointId]/route.ts",
  );
  const endpointAuthorization = source(
    "src/lib/partner-notification-endpoint-authorization.ts",
  );
  const collectionRead = section(
    collectionRoute,
    "export async function GET",
    "export async function POST",
  );
  const collectionMutation = collectionRoute.slice(
    collectionRoute.indexOf("export async function POST"),
  );

  it("keeps endpoint listing intrinsic but protects every mutation with explicit security authority", () => {
    expect(collectionRead).toContain("requirePartnerCapability");
    expect(collectionRead).toContain('"portal.session.read"');
    for (const route of [collectionMutation, verifyRoute, revokeRoute]) {
      expect(route).toContain(
        "requirePartnerNotificationEndpointMutationAccess",
      );
      expect(route).toContain("partnerUserId");
      expect(route).toContain("accountId");
      expect(route).toContain("membershipId");
    }
    expect(endpointAuthorization).toContain('"account.security.manage"');
    expect(endpointAuthorization).toContain('"mfa_step_up_required"');
    expect(collectionRoute).toContain("listPartnerNotificationEndpoints");
    expect(collectionRoute).not.toContain("phoneE164");
  });

  it("denies AAL1 or stale privileged sessions and accepts recent AAL2", () => {
    const now = new Date("2026-09-01T15:00:00.000Z");
    const privileged = {
      security: { mfaRequired: true },
      session: {
        assuranceLevel: "aal1" as const,
        mfaVerifiedAt: null,
      },
    };
    expect(hasRecentPartnerNotificationEndpointMfa(privileged, now)).toBe(
      false,
    );
    expect(
      hasRecentPartnerNotificationEndpointMfa(
        {
          ...privileged,
          session: {
            assuranceLevel: "aal2",
            mfaVerifiedAt: new Date("2026-09-01T14:50:00.000Z"),
          },
        },
        now,
      ),
    ).toBe(true);
    expect(
      hasRecentPartnerNotificationEndpointMfa(
        {
          ...privileged,
          session: {
            assuranceLevel: "aal2",
            mfaVerifiedAt: new Date("2026-09-01T14:44:59.999Z"),
          },
        },
        now,
      ),
    ).toBe(false);
    expect(
      hasRecentPartnerNotificationEndpointMfa(
        {
          ...privileged,
          session: {
            assuranceLevel: "aal2",
            mfaVerifiedAt: new Date("2026-09-01T15:01:00.001Z"),
          },
        },
        now,
      ),
    ).toBe(false);
  });

  it.each([
    [
      "request",
      collectionRoute,
      "partner_notification_endpoint_request",
      1_024,
    ],
    ["verify", verifyRoute, "partner_notification_endpoint_verify", 1_024],
    ["revoke", revokeRoute, "partner_notification_endpoint_revoke", 512],
  ])(
    "requires origin, idempotency, bounded JSON, and a dedicated rate limit for %s",
    (_label, route, rateLimitAction, maximumBytes) => {
      expect(route).toContain("isAllowedPartnerPortalMutationOrigin");
      expect(route).toContain("readPortalV2IdempotencyKey");
      expect(route).toContain("runPortalV2IdempotentMutation");
      expect(route).toContain("readBoundedJsonRequest");
      expect(route).toContain(
        `maximumBytes: ${maximumBytes === 1_024 ? "1_024" : "512"}`,
      );
      expect(route).toContain("rejectDuplicateObjectKeys: true");
      expect(route).toContain(`action: "${rateLimitAction}"`);
    },
  );

  it("keeps challenge identity server-side and fingerprints sensitive idempotency input", () => {
    expect(collectionRoute).not.toContain("challengeId");
    expect(verifyRoute).not.toContain("challengeId");
    expect(collectionRoute).toContain("destinationFingerprint");
    expect(collectionRoute).not.toContain("payload: { phone");
    expect(verifyRoute).toContain("codeFingerprint");
    expect(verifyRoute).not.toMatch(/payload:\s*\{\s*code\s*:/u);
  });

  it("requires explicit, versioned SMS consent and never enables preferences in verification", () => {
    expect(verifyRoute).toMatch(/consent(?:Accepted|Affirmed)/u);
    expect(verifyRoute).toContain("PARTNER_SMS_CONSENT_VERSION");
    expect(verifyRoute).toMatch(
      /record\["consent(?:Accepted|Affirmed)"\] !== true/u,
    );
  });

  it("uses neutral failures for endpoint ownership and verification failures", () => {
    expect(revokeRoute).toContain(
      '{ status: 404, body: { ok: false, error: "not_found" } }',
    );
    expect(verifyRoute).toContain(
      '{ status: 422, body: { ok: false, error: "invalid_fields" } }',
    );
    expect(verifyRoute).not.toContain("invalid_code");
    expect(verifyRoute).not.toContain("wrong_code");
  });
});

describe("partner notification endpoint verification contracts", () => {
  const endpointService = source("src/lib/partner-notification-endpoints.ts");
  const preferenceService = source(
    "src/lib/partner-notification-preferences.ts",
  );
  const completeVerification = section(
    endpointService,
    "export async function completePartnerNotificationEndpointVerification",
    "export type RevokePartnerNotificationEndpointResult",
  );
  const revocation = section(
    endpointService,
    "export async function revokePartnerNotificationEndpoint",
    "export type PartnerNotificationSmsDeliveryOutcome",
  );
  const publicProjection = section(
    endpointService,
    "function publicEndpoint(",
    "function actorAuditValues",
  );

  it("uses asynchronous Argon2-backed hashing and verifies outside the row-lock transaction", () => {
    expect(endpointService).toContain("await hashPartnerPassword(");
    expect(completeVerification).toContain("await verifyPartnerPassword(");
    expect(
      completeVerification.indexOf("await verifyPartnerPassword("),
    ).toBeLessThan(completeVerification.indexOf("return db.transaction("));

    const passwordCrypto = source("src/lib/partner-password-crypto.ts");
    expect(passwordCrypto).toContain('from "@node-rs/argon2"');
    expect(passwordCrypto).toContain(
      "return hashArgon2(password, ARGON2_POLICY)",
    );
    expect(passwordCrypto).toContain("await verifyArgon2(encoded, password)");
  });

  it("enforces a one-use ten-minute code with a bounded attempt budget", () => {
    expect(endpointService).toContain(
      "const VERIFICATION_TTL_MS = 10 * 60 * 1_000",
    );
    expect(endpointService).toContain("const MAX_VERIFICATION_ATTEMPTS = 5");
    expect(endpointService).toContain('status: "consumed"');
    expect(endpointService).toContain('status: "expired"');
    expect(completeVerification).toContain("challenge.attemptCount + 1");
    expect(completeVerification).toContain("codeHash: null");
  });

  it("persists explicit consent metadata without auto-enabling SMS events", () => {
    expect(endpointService).toContain(
      '"partner_portal_notification_settings" as const',
    );
    expect(endpointService).toContain(
      'PARTNER_SMS_CONSENT_VERSION = "partner-sms-consent-v1"',
    );
    expect(completeVerification).toContain(
      "consentSource: PARTNER_SMS_CONSENT_SOURCE",
    );
    expect(completeVerification).toContain(
      "consentVersion: PARTNER_SMS_CONSENT_VERSION",
    );
    expect(completeVerification).not.toContain("smsEnabled: true");
  });

  it("returns only masked endpoint data and keeps raw destinations and codes out of logs", () => {
    expect(publicProjection).toContain(
      "maskedDestination: maskPartnerSmsDestination(row.normalizedDestination)",
    );
    expect(publicProjection).not.toMatch(/\bnormalizedDestination\s*:/u);
    expect(publicProjection).not.toMatch(/\bcode(?:Hash|Ciphertext)?\s*:/u);
    expect(endpointService).not.toMatch(
      /console\.(?:debug|info|log|warn|error)/u,
    );
    expect(endpointService).toContain("destinationFingerprint");
    expect(endpointService).toContain("codeCiphertext");
  });

  it("revokes active challenges and clears every linked SMS preference snapshot", () => {
    expect(revocation).toContain('status: "revoked"');
    expect(revocation).toContain("codeHash: null");
    expect(revocation).toContain("smsEnabled: false");
    expect(revocation).toContain("smsVerifiedOptInAt: null");
    expect(revocation).toContain("smsVerifiedPhoneE164: null");
    expect(revocation).toContain("smsVerifiedEndpointId: null");
    expect(revocation).toContain("smsOptInSource: null");
    expect(revocation).toContain("smsConsentVersion: null");
  });

  it("requires a currently verified identity endpoint and snapshots its consent when SMS is enabled", () => {
    expect(preferenceService).toContain(
      "partnerNotificationEndpoints.partnerUserId",
    );
    expect(preferenceService).toContain(
      'eq(partnerNotificationEndpoints.status, "verified")',
    );
    expect(preferenceService).toContain(
      'return "sms_opt_in_required" as const',
    );
    expect(preferenceService).toContain(
      "smsVerifiedEndpointId: verifiedSmsEndpoint.id",
    );
    expect(preferenceService).toContain(
      "smsVerifiedPhoneE164: verifiedSmsEndpoint.destination",
    );
    expect(preferenceService).toContain(
      "smsVerifiedOptInAt: verifiedSmsEndpoint.consentAt",
    );
    expect(preferenceService).toContain(
      "smsOptInSource: verifiedSmsEndpoint.consentSource",
    );
    expect(preferenceService).toContain(
      "smsConsentVersion: verifiedSmsEndpoint.consentVersion",
    );
  });
});

describe("partner SMS verification outbox integration", () => {
  const processor = source("src/lib/outbox-processor.ts");
  const policy = source("src/lib/outbox-dispatch-policy.ts");

  it("treats SMS-code delivery as provider-bound and retry-safe", () => {
    expect(policy).toContain('"partner.notification_endpoint.sms_code"');
    expect(processor).toContain("PARTNER_NOTIFICATION_SMS_CODE_EVENT");
    expect(processor).toContain("processPartnerNotificationSmsCode");
    expect(processor).toContain(
      "event.type === PARTNER_NOTIFICATION_SMS_CODE_EVENT",
    );
  });

  it("validates the bounded outbox envelope before invoking the SMS worker", () => {
    expect(processor).toContain("case PARTNER_NOTIFICATION_SMS_CODE_EVENT");
    expect(processor).toContain("partner_sms_code_payload_invalid");
    expect(processor).toContain("Number.isSafeInteger(generation)");
    expect(processor).toMatch(/codeCiphertext\.length\s*>\s*[\d_]+/u);
    expect(processor).toContain("outboxEventId: event.id");
    expect(processor).toContain(
      'getTeamOperationKillSwitchForRisk("external") === "external_sends"',
    );
  });
});

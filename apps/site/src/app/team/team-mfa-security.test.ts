import assert from "node:assert/strict";
import test from "node:test";
import { parseTeamMfaSecurityStatus } from "./team-mfa-security";

const valid = {
  ok: true,
  security: {
    required: true,
    enrolled: true,
    assuranceLevel: "aal2",
    recentlyVerified: true,
    mfaVerifiedAt: "2026-09-01T12:00:00.000Z",
    recentVerificationExpiresAt: "2026-09-01T12:15:00.000Z",
    configurationAllowed: true,
    recentMfaMaximumAgeSeconds: 900,
    methods: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "totp",
        label: "Work phone",
        enrolledAt: "2026-09-01T12:00:00.000Z",
        lastUsedAt: "2026-09-01T12:00:00.000Z",
        recoveryCodesRemaining: 10,
      },
    ],
  },
};

void test("parses a coherent Team MFA security response", () => {
  assert.deepEqual(parseTeamMfaSecurityStatus(valid), valid.security);
});

void test("rejects assurance and enrollment contradictions", () => {
  assert.equal(
    parseTeamMfaSecurityStatus({
      ...valid,
      security: { ...valid.security, mfaVerifiedAt: null },
    }),
    null,
  );
  assert.equal(
    parseTeamMfaSecurityStatus({
      ...valid,
      security: { ...valid.security, enrolled: false },
    }),
    null,
  );
});

void test("rejects an unexpected verification window or malformed method", () => {
  assert.equal(
    parseTeamMfaSecurityStatus({
      ...valid,
      security: { ...valid.security, recentMfaMaximumAgeSeconds: 3_600 },
    }),
    null,
  );
  assert.equal(
    parseTeamMfaSecurityStatus({
      ...valid,
      security: {
        ...valid.security,
        methods: [{ ...valid.security.methods[0], recoveryCodesRemaining: -1 }],
      },
    }),
    null,
  );
});

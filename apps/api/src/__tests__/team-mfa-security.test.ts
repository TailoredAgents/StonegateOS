import fs from "node:fs";
import path from "node:path";
import type { ActionPolicy } from "@myst-os/sdk";
import {
  TeamMfaConfigurationError,
  createTeamTotpUri,
  decryptTeamTotpSecret,
  encryptTeamTotpSecret,
  generateTeamMfaRecoveryCodes,
  hashTeamMfaRecoveryCode,
  teamTotpCodeAt,
  verifyTeamMfaRecoveryCode,
  verifyTeamTotp,
} from "@/lib/team-mfa";
import {
  isTeamMfaRecent,
  strengthenTeamMutationPolicy,
  teamMutationRequiresRecentMfa,
  TeamMutationFailure,
  type TeamMutationContext,
} from "@/lib/team-mutation";

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const METHOD_ID = "22222222-2222-4222-8222-222222222222";
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("Team TOTP and recovery security", () => {
  const previous = {
    key: process.env["TEAM_MFA_SECRET_KEY_BASE64"],
    keys: process.env["TEAM_MFA_SECRET_KEYS_JSON"],
    version: process.env["TEAM_MFA_SECRET_KEY_VERSION"],
  };

  beforeEach(() => {
    delete process.env["TEAM_MFA_SECRET_KEYS_JSON"];
    process.env["TEAM_MFA_SECRET_KEY_BASE64"] = Buffer.alloc(32, 17).toString(
      "base64",
    );
    process.env["TEAM_MFA_SECRET_KEY_VERSION"] = "3";
  });

  afterAll(() => {
    for (const [name, value] of Object.entries({
      TEAM_MFA_SECRET_KEY_BASE64: previous.key,
      TEAM_MFA_SECRET_KEYS_JSON: previous.keys,
      TEAM_MFA_SECRET_KEY_VERSION: previous.version,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("matches RFC 6238, permits bounded skew, and rejects replay", () => {
    const at = new Date(59_000);
    const code = teamTotpCodeAt(RFC_SECRET, at);
    expect(code).toBe("287082");
    const counter = verifyTeamTotp({ secret: RFC_SECRET, code, at });
    expect(counter).toBe(1);
    expect(
      verifyTeamTotp({
        secret: RFC_SECRET,
        code,
        at,
        lastAcceptedCounter: counter,
      }),
    ).toBeNull();
  });

  it("uses a Team-only issuer, keyring, AAD, and recovery-code domain", () => {
    const uri = createTeamTotpUri({
      email: "Owner@Stonegate.test",
      secret: RFC_SECRET,
    });
    expect(uri).toContain("issuer=Stonegate+Team");
    const encrypted = encryptTeamTotpSecret({
      teamMemberId: MEMBER_ID,
      secret: RFC_SECRET,
    });
    expect(encrypted.keyVersion).toBe(3);
    expect(encrypted.ciphertext).not.toContain(RFC_SECRET);
    expect(
      decryptTeamTotpSecret({ teamMemberId: MEMBER_ID, ...encrypted }),
    ).toBe(RFC_SECRET);
    expect(() =>
      decryptTeamTotpSecret({
        teamMemberId: "33333333-3333-4333-8333-333333333333",
        ...encrypted,
      }),
    ).toThrow();

    const code = generateTeamMfaRecoveryCodes(1)[0]!;
    const digest = hashTeamMfaRecoveryCode({
      code,
      teamMemberId: MEMBER_ID,
      methodId: METHOD_ID,
    });
    expect(digest.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      verifyTeamMfaRecoveryCode({
        code,
        expectedHash: digest.hash,
        teamMemberId: MEMBER_ID,
        methodId: METHOD_ID,
        keyVersion: digest.keyVersion,
      }),
    ).toBe(true);
    expect(
      verifyTeamMfaRecoveryCode({
        code,
        expectedHash: digest.hash,
        teamMemberId: MEMBER_ID,
        methodId: "44444444-4444-4444-8444-444444444444",
        keyVersion: digest.keyVersion,
      }),
    ).toBe(false);
  });

  it("fails closed without a separately configured Team key", () => {
    delete process.env["TEAM_MFA_SECRET_KEY_BASE64"];
    delete process.env["TEAM_MFA_SECRET_KEYS_JSON"];
    process.env["PARTNER_MFA_SECRET_KEY_BASE64"] = Buffer.alloc(32, 4).toString(
      "base64",
    );
    expect(() =>
      encryptTeamTotpSecret({ teamMemberId: MEMBER_ID, secret: RFC_SECRET }),
    ).toThrow(TeamMfaConfigurationError);
    delete process.env["PARTNER_MFA_SECRET_KEY_BASE64"];
  });
});

describe("Team recent-MFA mutation policy", () => {
  const policy = (
    requiredPermissions: ActionPolicy["requiredPermissions"],
    risk: ActionPolicy["risk"] = "normal",
  ) => ({ requiredPermissions, risk });
  const actor = (
    overrides: Partial<{
      type: "human" | "worker";
      role: string | null;
      authMethod: "team_session" | "break_glass" | "service";
    }> = {},
  ) => ({
    type: "human" as const,
    role: "office",
    authMethod: "team_session" as const,
    ...overrides,
  });

  it("protects every Owner mutation and sensitive staff categories", () => {
    expect(
      teamMutationRequiresRecentMfa(
        policy(["contacts.read"]),
        actor({ role: "owner" }),
      ),
    ).toBe(true);
    expect(
      teamMutationRequiresRecentMfa(
        policy(["partners.applications.approve"]),
        actor(),
      ),
    ).toBe(true);
    expect(
      teamMutationRequiresRecentMfa(
        policy(["appointments.update"], "external"),
        actor(),
      ),
    ).toBe(true);
    expect(
      teamMutationRequiresRecentMfa(policy(["contacts.write"]), actor()),
    ).toBe(false);
  });

  it("keeps verified services and break-glass in their existing boundaries", () => {
    expect(
      teamMutationRequiresRecentMfa(
        policy(["partners.accounts.close"], "destructive"),
        actor({ authMethod: "break_glass" }),
      ),
    ).toBe(false);
    expect(
      teamMutationRequiresRecentMfa(
        policy(["outbox.dispatch"], "external"),
        actor({ type: "worker", role: null, authMethod: "service" }),
      ),
    ).toBe(false);
  });

  it("accepts only AAL2 timestamps inside the 15-minute window", () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    expect(
      isTeamMfaRecent(
        {
          assuranceLevel: "aal2",
          mfaVerifiedAt: "2026-09-01T11:45:00.000Z",
        },
        now,
      ),
    ).toBe(true);
    expect(
      isTeamMfaRecent(
        {
          assuranceLevel: "aal2",
          mfaVerifiedAt: "2026-09-01T11:44:59.999Z",
        },
        now,
      ),
    ).toBe(false);
    expect(
      isTeamMfaRecent({ assuranceLevel: "aal1", mfaVerifiedAt: null }, now),
    ).toBe(false);
  });

  it("fails closed when a data-dependent branch strengthens into partner access", () => {
    const mutation = {
      policy: {
        principalTypes: ["human"],
        requiredPermissions: ["contacts.read"],
        risk: "normal",
        requiresIdempotency: false,
        auditAction: "test.read",
      },
      actor: {
        type: "human",
        id: MEMBER_ID,
        role: "office",
        sessionId: "55555555-5555-4555-8555-555555555555",
        authMethod: "team_session",
        assuranceLevel: "aal1",
        mfaVerifiedAt: null,
      },
      principalType: "human",
      operationId: "66666666-6666-4666-8666-666666666666",
      correlationId: "correlation:test",
      idempotencyKeyHash: null,
      expectedVersion: null,
      audit: {},
    } as unknown as TeamMutationContext;
    expect(() =>
      strengthenTeamMutationPolicy(mutation, ["partners.accounts.manage"]),
    ).toThrow(TeamMutationFailure);
  });
});

describe("Team MFA migration contract", () => {
  it("keeps Team credentials separate and break-glass at AAL1", () => {
    const sql = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "src/db/migrations/0138_team_mfa_assurance.sql",
      ),
      "utf8",
    );
    expect(sql).toContain('CREATE TABLE "team_mfa_methods"');
    expect(sql).toContain('CREATE TABLE "team_mfa_recovery_codes"');
    expect(sql).toContain("\"auth_method\" = 'team_session'");
    expect(sql).not.toContain("partner_mfa_methods");
    expect(sql).not.toContain("partner_user_id");
  });
});

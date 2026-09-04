import fs from "node:fs";
import path from "node:path";
import {
  strengthenTeamMutationPolicy,
  type TeamMutationContext,
} from "@/lib/team-mutation";

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";

describe("Team mutation policy without mandatory MFA", () => {
  it("keeps data-dependent permission strengthening available at AAL1", () => {
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
    const strengthened = strengthenTeamMutationPolicy(mutation, [
      "partners.accounts.manage",
    ]);
    expect(strengthened.policy.requiredPermissions).toEqual([
      "contacts.read",
      "partners.accounts.manage",
    ]);
    expect(strengthened.actor).toBe(mutation.actor);
  });
});

describe("retired Team MFA endpoints", () => {
  it("has no live Team MFA API handlers", () => {
    const root = path.resolve(process.cwd(), "../..");
    const retiredHandlers = [
      "apps/api/app/api/admin/team/mfa/route.ts",
      "apps/api/app/api/admin/team/mfa/revoke/route.ts",
      "apps/api/app/api/admin/team/mfa/step-up/route.ts",
      "apps/api/app/api/admin/team/mfa/totp/enrollment/route.ts",
      "apps/api/app/api/admin/team/mfa/totp/enrollment/[challengeId]/confirm/route.ts",
      "apps/site/src/app/api/team/security/mfa/route.ts",
      "apps/site/src/app/api/team/security/mfa/[...segments]/route.ts",
    ];
    for (const handler of retiredHandlers) {
      expect(fs.existsSync(path.join(root, handler))).toBe(false);
    }
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PartnerCapability } from "@/lib/partner-account-authorization";
import {
  hashPartnerInvitationToken,
  mayAssignInvitationRole,
  normalizeInvitationEmail,
  PartnerInvitationAcceptanceSchema,
  PartnerInvitationActionSchema,
  PartnerInvitationCreateSchema,
} from "@/lib/partner-account-invitations";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const source = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

describe("partner account invitation security policy", () => {
  const administrator = [
    "portal.session.read",
    "portal.session.switch_account",
    "account.read",
    "account.members.read",
    "account.members.manage",
  ] as const satisfies readonly PartnerCapability[];

  it("normalizes the mailbox and stores only a deterministic digest", () => {
    expect(normalizeInvitationEmail("  Teammate@Example.COM  ")).toBe("teammate@example.com");
    expect(hashPartnerInvitationToken("one-use-secret")).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashPartnerInvitationToken("one-use-secret")).not.toContain("one-use-secret");
  });

  it("accepts bounded exact create/action/acceptance payloads", () => {
    expect(PartnerInvitationCreateSchema.safeParse({
      email: "teammate@example.com",
      name: "Taylor Partner",
      roleKey: "scheduler",
      persona: "property_manager",
    }).success).toBe(true);
    expect(PartnerInvitationCreateSchema.safeParse({
      email: "teammate@example.com",
      name: "Taylor Partner",
      roleKey: "owner",
      persona: "other",
      accountId: "cross-account-override",
    }).success).toBe(false);
    expect(PartnerInvitationActionSchema.safeParse({ action: "resend" }).success).toBe(true);
    expect(PartnerInvitationActionSchema.safeParse({ action: "accept" }).success).toBe(false);
    expect(PartnerInvitationAcceptanceSchema.safeParse({ token: "x".repeat(43) }).success).toBe(true);
  });

  it("prevents an administrator from inviting a role above their authority", () => {
    expect(mayAssignInvitationRole({
      actorCapabilities: administrator,
      roleCapabilities: ["account.read", "account.members.read"],
    })).toBe(true);
    expect(mayAssignInvitationRole({
      actorCapabilities: administrator,
      roleCapabilities: ["account.read", "payments.manage"],
    })).toBe(false);
  });
});

describe("partner invitation route and persistence contract", () => {
  const migration = source("apps/api/src/db/migrations/0119_partner_account_invitations.sql");
  const journal = JSON.parse(
    source("apps/api/src/db/migrations/meta/_journal.json"),
  ) as { entries?: Array<{ idx?: number; tag?: string }> };
  const service = source("apps/api/src/lib/partner-account-invitations.ts");
  const delivery = source("apps/api/src/lib/partner-account-invitation-delivery.ts");
  const collectionRoute = source("apps/api/app/api/portal/v2/invitations/route.ts");
  const itemRoute = source("apps/api/app/api/portal/v2/invitations/[invitationId]/route.ts");
  const acceptRoute = source("apps/api/app/api/portal/v2/invitations/accept/route.ts");
  const acceptancePage = source("apps/site/src/app/partners/(public)/invitations/accept/page.tsx");
  const acceptanceCompleteRoute = source("apps/site/src/app/partners/invitations/accept/complete/route.ts");

  it("is expand-only, tenant-bound, and never persists a raw credential column", () => {
    expect(migration).toContain('CREATE TABLE "partner_account_invitations"');
    expect(migration).toContain('"token_hash" varchar(64)');
    expect(migration).not.toMatch(/"(?:raw_)?token"\s/u);
    expect(migration).toContain('FOREIGN KEY ("invited_by_membership_id", "partner_account_id")');
    expect(migration).toContain('FOREIGN KEY ("accepted_membership_id", "partner_account_id")');
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/iu);
    expect(journal.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idx: 116,
          tag: "0119_partner_account_invitations",
        }),
      ]),
    );
  });

  it("requires capability, AAL2 guard, origin, idempotency, rate limits, ETags, and opaque tenant misses", () => {
    expect(collectionRoute).toContain('"account.members.manage"');
    expect(collectionRoute).toContain("isAllowedPartnerPortalMutationOrigin");
    expect(collectionRoute).toContain("readPortalV2IdempotencyKey");
    expect(collectionRoute).toContain('action: "partner_invitation_management"');
    expect(itemRoute).toContain("hasPartnerAccountInvitation");
    expect(itemRoute.indexOf("await hasPartnerAccountInvitation")).toBeLessThan(itemRoute.lastIndexOf("readPortalV2IdempotencyKey"));
    expect(itemRoute).toContain('request.headers.get("if-match")');
    expect(itemRoute).toContain('"not_found", 404');
    expect(acceptRoute).toContain("isAllowedPartnerPortalMutationOrigin");
    expect(acceptRoute).toContain('action: "partner_invitation_accept"');
    expect(acceptancePage).toContain('method="post"');
    expect(acceptancePage).toContain('/partners/invitations/accept/complete');
    expect(acceptanceCompleteRoute).toContain('request.headers.get("origin")');
    expect(acceptanceCompleteRoute).toContain('requestOrigin !== request.nextUrl.origin');
  });

  it("binds acceptance to invitation account/email/role and creates the selected-account session atomically", () => {
    expect(service).toContain("eq(partnerAccountInvitations.tokenHash, tokenHash)");
    expect(service).toContain("eq(partnerRoleTemplates.id, invitation.roleTemplateId)");
    expect(service).toContain("eq(partnerRoleTemplates.version, invitation.roleTemplateVersion)");
    expect(service).toContain("eq(partnerAccountMemberships.partnerAccountId, account.id)");
    expect(service).toContain("activePartnerAccountId: account.id");
    expect(service).toContain("activeMembershipId: membershipId");
    expect(service).toContain('existingMembership.status !== "active"');
  });

  it("places the intended URL only in delivery payload/content and omits it from audit metadata", () => {
    expect(service).toContain('type: "partner.account_invitation.email"');
    expect(service).toContain("deliveryUrl: url");
    expect(service).not.toMatch(/\.values\(\{[^}]*rawToken/su);
    expect(delivery).toContain('row.deliveryStatus === "dispatching"');
    expect(delivery).toContain('deliveryStatus: "reconciliation_required"');
    expect(delivery).toContain("providerIdempotencySupported: false");
    expect(delivery).not.toMatch(/meta:\s*\{[^}]*deliveryUrl/su);
  });

  it("keeps duplicate, existing-member, and self invitation delivery responses neutral", () => {
    expect(service).toContain("normalizeInvitationEmail(input.principal.email)");
    expect(service).toContain('action: "partner.account_invitation.request_suppressed"');
    expect(service).toContain('status: 202, body: { ok: true, status: "queued" }');
    expect(service).toContain("invitedEmailHash: input.emailHash");
    expect(service).not.toMatch(/meta:\s*\{[^}]*normalizedEmail/su);
  });
});

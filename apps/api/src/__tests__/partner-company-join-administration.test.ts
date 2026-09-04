import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPartnerJoinDecisionNotification,
  PartnerJoinDecisionSchema,
  verifiedJoinDomain,
} from "@/lib/partner-company-join-administration";
import { PARTNER_NOTIFICATION_EVENT_KEYS } from "@/lib/partner-notification-preferences";

const REPO_ROOT = resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);
const source = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

describe("partner verified-domain join administration", () => {
  it("revalidates an exact non-public work domain", () => {
    expect(
      verifiedJoinDomain("https://www.example.com/about", "person@example.com"),
    ).toBe(true);
    expect(verifiedJoinDomain("example.com", "person@other.example.com")).toBe(
      false,
    );
    expect(verifiedJoinDomain("gmail.com", "person@gmail.com")).toBe(false);
    expect(verifiedJoinDomain(null, "person@example.com")).toBe(false);
  });

  it("accepts bounded exact approve, decline, and needs-information decisions", () => {
    expect(
      PartnerJoinDecisionSchema.safeParse({
        action: "approve",
        roleKey: "operations",
        persona: "property_manager",
        note: null,
      }).success,
    ).toBe(true);
    expect(
      PartnerJoinDecisionSchema.safeParse({
        action: "approve",
        roleKey: "administrator",
        persona: "other",
        partnerAccountId: "cross-account-override",
      }).success,
    ).toBe(false);
    expect(
      PartnerJoinDecisionSchema.safeParse({
        action: "decline",
        note: "Domain could not be verified.",
      }).success,
    ).toBe(true);
    expect(
      PartnerJoinDecisionSchema.safeParse({ action: "decline", note: "" })
        .success,
    ).toBe(false);
    expect(
      PartnerJoinDecisionSchema.safeParse({
        action: "needs_information",
        note: "Confirm your relationship to the company.",
      }).success,
    ).toBe(true);
    expect(
      PartnerJoinDecisionSchema.safeParse({
        action: "needs_information",
        note: "x",
        internalAccountId: "override",
      }).success,
    ).toBe(false);
  });

  it.each(["approved", "declined", "needs_information"] as const)(
    "builds safe transactional %s copy without request text or internal identifiers",
    (status) => {
      const sensitiveRequestText = "Gate code 1234; internal review details";
      const internalId = "11111111-1111-4111-8111-111111111111";
      const content = buildPartnerJoinDecisionNotification({
        status,
        accountName: "Example Property Group\n",
        userName: "Alex\r\nBcc: attacker@example.test",
        portalUrl: "https://stonegate.example/partners",
      });
      const serialized = JSON.stringify(content);
      expect(content.eventKey).toBe("account_access");
      expect(content.actionPath).toBe("/partners");
      expect(content.emailBody).toContain("https://stonegate.example/partners");
      expect(serialized).not.toContain(sensitiveRequestText);
      expect(serialized).not.toContain(internalId);
      expect(serialized).not.toContain("\r");
      expect(serialized).not.toContain("\nBcc:");
    },
  );

  it("publishes account-access preferences with safe-on defaults", () => {
    expect(PARTNER_NOTIFICATION_EVENT_KEYS).toContain("account_access");
  });
});

describe("partner join-decision route contract", () => {
  const service = source(
    "apps/api/src/lib/partner-company-join-administration.ts",
  );
  const collection = source(
    "apps/api/app/api/portal/v2/join-requests/route.ts",
  );
  const item = source(
    "apps/api/app/api/portal/v2/join-requests/[requestId]/route.ts",
  );
  const manager = source(
    "apps/site/src/app/partners/components/PartnerJoinRequestManager.tsx",
  );

  it("uses capability, origin, idempotency, rate, revision, and tenant guards", () => {
    expect(collection).toContain('"account.members.manage"');
    expect(item).toContain('"account.members.manage"');
    expect(item).toContain("requirePartnerCapability");
    expect(item).not.toContain("requireRecentPartnerMfaCapability");
    expect(item).toContain("isAllowedPartnerPortalMutationOrigin");
    expect(item).toContain("readPortalV2IdempotencyKey");
    expect(item).toContain('request.headers.get("if-match")');
    expect(item).toContain('action: "partner_join_decision"');
    expect(item).toContain("hasAccountJoinRequest");
    expect(item.indexOf("await hasAccountJoinRequest")).toBeLessThan(
      item.lastIndexOf("readPortalV2IdempotencyKey"),
    );
  });

  it("forbids self approval, revalidates domain and role authority, and never reactivates stale access", () => {
    expect(service).toContain(
      "request.partnerUserId === input.principal.partnerUserId",
    );
    expect(service).toContain('reason: "self_approval"');
    expect(service).toContain(
      "verifiedJoinDomain(account.domain, request.userEmail)",
    );
    expect(service).toContain("mayAssignInvitationRole");
    expect(service).toContain(
      'reason: existingMembership.status === "active" ? "already_member" : "existing_access_requires_staff_review"',
    );
    expect(service).toContain("resolvedMembershipId: membership.id");
  });

  it("scopes every resource lookup and mutation to the selected account with opaque misses", () => {
    expect(service).toContain(
      "eq(partnerCompanyJoinRequests.partnerAccountId, accountId)",
    );
    expect(service).toContain(
      "eq(partnerAccountMemberships.partnerAccountId, accountId)",
    );
    expect(service).toContain(
      '{ status: 404, body: { ok: false, error: "not_found" } }',
    );
    expect(service).toContain('.for("update")');
  });

  it("atomically queues one preference-aware in-app and email effect per decision", () => {
    expect(service).toContain(
      'partnerNotificationPreferences.eventKey, "account_access"',
    );
    expect(service).toContain("partnerNotifications");
    expect(service).toContain("deterministicNotificationId(operationHash)");
    expect(service).toContain(
      ".onConflictDoNothing({ target: partnerNotifications.id })",
    );
    expect(service).toContain(
      "arePartnerPortalOutboundNotificationsEnabled(input.decisionAccountId)",
    );
    expect(service).toContain("queueSystemOutboundMessage");
    expect(service).toContain("nextQuietHoursEnd");
    expect(service).toContain(
      "dedupeKey: `partner.join.decision:${operationHash}`",
    );
    expect(service).toContain('kind: "partner.company_join_decision"');
    expect(service).toContain(
      "defaultNotificationTarget(tx, request.partnerUserId)",
    );
  });

  it("supports needs-information decisions without exposing reviewer notes in delivery copy", () => {
    expect(service).toContain('action: z.literal("needs_information")');
    expect(service).toContain('reason: "information_already_requested"');
    expect(service).toContain("buildPartnerJoinDecisionNotification({");
    expect(service).not.toContain(
      "reviewNote: input.decision.note,\n    emailBody",
    );
    expect(manager).toContain('decide("needs_information")');
    expect(manager).toContain("not emailed");
  });
});

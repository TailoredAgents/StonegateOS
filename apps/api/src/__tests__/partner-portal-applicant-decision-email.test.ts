import fs from "node:fs";
import path from "node:path";
import {
  buildPartnerAccessApplicationDecisionEmail,
  partnerAccessApplicationEmailEventId,
} from "@/lib/partner-access-application-email-delivery";
import { arePartnerPortalApplicantNotificationsEnabled } from "@/lib/partner-portal-feature-flags";

const apiRoot = path.resolve(process.cwd());

function source(relativePath: string): string {
  return fs.readFileSync(path.join(apiRoot, relativePath), "utf8");
}

describe("partner applicant decision email", () => {
  const priorNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    delete process.env.PARTNER_PORTAL_V2_READS_ENABLED;
    delete process.env.PARTNER_PORTAL_V2_WRITES_ENABLED;
    delete process.env.PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED;
  });

  afterAll(() => {
    process.env.NODE_ENV = priorNodeEnv;
  });

  it("uses a deterministic status-and-version-bound event identity", () => {
    const input = {
      applicationId: "11111111-1111-4111-8111-111111111111",
      status: "needs_information" as const,
      version: 2,
    };

    expect(partnerAccessApplicationEmailEventId(input)).toBe(
      partnerAccessApplicationEmailEventId(input),
    );
    expect(
      partnerAccessApplicationEmailEventId({ ...input, version: 3 }),
    ).not.toBe(partnerAccessApplicationEmailEventId(input));
    expect(
      partnerAccessApplicationEmailEventId({ ...input, status: "declined" }),
    ).not.toBe(partnerAccessApplicationEmailEventId(input));
  });

  it("fails closed unless all pre-account notification rollout flags are on", () => {
    expect(arePartnerPortalApplicantNotificationsEnabled()).toBe(false);
    process.env.PARTNER_PORTAL_V2_READS_ENABLED = "1";
    process.env.PARTNER_PORTAL_V2_WRITES_ENABLED = "1";
    expect(arePartnerPortalApplicantNotificationsEnabled()).toBe(false);
    process.env.PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED = "1";
    expect(arePartnerPortalApplicantNotificationsEnabled()).toBe(true);
  });

  it("builds bounded applicant-visible needs-information copy", () => {
    const copy = buildPartnerAccessApplicationDecisionEmail({
      status: "needs_information",
      name: "  Ada\u0000   Lovelace  ",
      companyName: " Example\nProperties ",
      informationRequest: `Provide the property list.\u0007${"x".repeat(4_000)}`,
      applicationUrl: "https://stonegate.example/partners/application",
    });

    expect(copy.subject).toBe(
      "More information is needed for your partner access request",
    );
    expect(copy.text).toContain("Hi Ada Lovelace,");
    expect(copy.text).toContain("Example Properties");
    expect(copy.text).toContain("Provide the property list. x");
    expect(copy.text).toContain(
      "https://stonegate.example/partners/application",
    );
    expect(
      Array.from(copy.text).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (
          codePoint <= 8 ||
          codePoint === 11 ||
          codePoint === 12 ||
          (codePoint >= 14 && codePoint <= 31) ||
          codePoint === 127
        );
      }),
    ).toBe(false);
    expect(copy.text.length).toBeLessThanOrEqual(2_700);
  });

  it("keeps declined copy neutral and excludes the staff decision note", () => {
    const copy = buildPartnerAccessApplicationDecisionEmail({
      status: "declined",
      name: "Morgan",
      companyName: "Northwind",
      informationRequest: "INTERNAL DECLINE REASON MUST NOT LEAVE STONEGATE",
      applicationUrl: "https://stonegate.example/partners/application",
    });

    expect(copy.subject).toBe(
      "Update on your Stonegate partner access request",
    );
    expect(copy.text).toContain("could not approve");
    expect(copy.text).toContain("No partner account");
    expect(copy.text).not.toContain("INTERNAL DECLINE REASON");
    expect(copy.text).not.toContain("stonegate.example/partners/application");
  });

  it("queues a privacy-safe deterministic event inside the authorized decision transaction", () => {
    const route = source(
      "app/api/admin/partners/access-applications/[applicationId]/route.ts",
    );
    const delivery = source(
      "src/lib/partner-access-application-email-delivery.ts",
    );
    const processor = source("src/lib/outbox-processor.ts");
    const policy = source("src/lib/outbox-dispatch-policy.ts");
    const payloadStart = delivery.indexOf("const payload = {");
    const payloadEnd = delivery.indexOf("};", payloadStart) + 2;
    const durablePayload = delivery.slice(payloadStart, payloadEnd);

    expect(route).toContain("application.flowVersion === 2");
    const flowV2NotificationBranch = route.slice(
      route.indexOf("const notification ="),
      route.indexOf("const audit =", route.indexOf("const notification =")),
    );
    expect(flowV2NotificationBranch).toContain(
      "arePartnerPortalApplicantNotificationsEnabled()",
    );
    expect(
      flowV2NotificationBranch.indexOf(
        "arePartnerPortalApplicantNotificationsEnabled()",
      ),
    ).toBeLessThan(
      flowV2NotificationBranch.indexOf(
        "queuePartnerAccessApplicationDecisionEmail(tx",
      ),
    );
    expect(flowV2NotificationBranch).toContain('email: "feature_disabled"');
    expect(route).toContain("queuePartnerAccessApplicationDecisionEmail(tx");
    expect(
      route.indexOf("queuePartnerAccessApplicationDecisionEmail(tx"),
    ).toBeLessThan(route.indexOf("mutation.audit.insertSuccess(tx"));
    expect(route).toContain("claimTeamMutationIdempotency");
    expect(route).toContain("completeTeamMutationIdempotency(");

    expect(durablePayload).toContain("applicationId: input.applicationId");
    expect(durablePayload).toContain("status: input.status");
    expect(durablePayload).toContain("version: input.version");
    expect(durablePayload).toContain("correlationId: input.correlationId");
    expect(durablePayload).not.toContain("normalizedEmail");
    expect(durablePayload).not.toContain("reviewNote");
    expect(durablePayload).not.toContain("companyName");
    expect(delivery).toContain(
      "onConflictDoNothing({ target: outboxEvents.id })",
    );
    expect(delivery).toContain(
      'throw new Error("partner_application_email_outbox_conflict")',
    );
    expect(delivery).toContain(
      "input.outboxEventId !== partnerAccessApplicationEmailEventId(input)",
    );
    expect(delivery).toContain("emailFingerprint(normalizedEmail)");
    expect(delivery).toContain(
      "partner-application:${input.outboxEventId}:${input.version}",
    );
    expect(delivery).toContain("delivery_reconciliation_required");
    expect(delivery).not.toContain("insert(partnerUsers)");
    expect(delivery).not.toContain("insert(partnerAccounts)");
    expect(delivery).not.toContain("insert(partnerAccountMemberships)");
    expect(delivery).not.toContain("insert(contacts)");

    expect(policy).toContain('"partner.access_application.email"');
    const handler = processor.indexOf(
      "case PARTNER_ACCESS_APPLICATION_EMAIL_EVENT",
    );
    expect(handler).toBeGreaterThan(-1);
    expect(
      processor.indexOf(
        'getTeamOperationKillSwitchForRisk("external")',
        handler,
      ),
    ).toBeLessThan(
      processor.indexOf(
        "processPartnerAccessApplicationDecisionEmail({",
        handler,
      ),
    );
    expect(
      processor.indexOf(
        "arePartnerPortalApplicantNotificationsEnabled()",
        handler,
      ),
    ).toBeLessThan(
      processor.indexOf(
        "processPartnerAccessApplicationDecisionEmail({",
        handler,
      ),
    );
  });
});

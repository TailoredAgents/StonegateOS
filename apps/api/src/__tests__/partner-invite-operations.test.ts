import {
  partnerInviteProviderRequestKey,
  partnerInviteSemanticHash,
  planPartnerInviteTerminal,
} from "@/lib/partner-invite-operations";
import type { PartnerInviteProviderEvidence } from "@/lib/partner-invite-delivery";

function evidence(
  channel: "email" | "sms",
  state: "succeeded" | "failed" | "reconciliation_required",
): PartnerInviteProviderEvidence {
  return {
    channel,
    state,
    provider: channel === "email" ? "smtp" : "twilio",
    providerOperationId: state === "succeeded" ? `${channel}-id` : null,
    providerOperationIds: state === "succeeded" ? [`${channel}-id`] : [],
    providerIdempotencySupported: false,
    providerExactlyOnceClaimed: false,
    detail: null,
  };
}

describe("partner access-link operation primitives", () => {
  const target = {
    orgContactId: "11111111-1111-4111-8111-111111111111",
    partnerUserId: "22222222-2222-4222-8222-222222222222",
    email: "Portal@Example.Test",
    phoneE164: "+14045550123",
    requestedChannels: ["sms", "email"] as const,
  };

  it("builds a stable privacy-safe semantic identity independent of channel order", () => {
    const first = partnerInviteSemanticHash(target);
    const second = partnerInviteSemanticHash({
      ...target,
      email: " portal@example.test ",
      requestedChannels: ["email", "sms"],
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toBe(first);
    expect(first).not.toContain("portal@example.test");
  });

  it("keeps public login-link and team-invite identities distinct", () => {
    expect(
      partnerInviteSemanticHash({
        ...target,
        operationKind: "public_login_link",
      }),
    ).not.toBe(
      partnerInviteSemanticHash({ ...target, operationKind: "team_invite" }),
    );
  });

  it("derives stable per-channel provider request keys from the durable operation", () => {
    const operationId = "33333333-3333-4333-8333-333333333333";
    expect(partnerInviteProviderRequestKey(operationId, "email")).toBe(
      `${operationId}.partner-access-link.email`,
    );
    expect(partnerInviteProviderRequestKey(operationId, "sms")).toBe(
      `${operationId}.partner-access-link.sms`,
    );
  });

  it("allows retry only when every requested provider proves a known non-send", () => {
    expect(
      planPartnerInviteTerminal(
        ["email", "sms"],
        [evidence("email", "failed"), evidence("sms", "failed")],
      ),
    ).toMatchObject({
      state: "failed",
      failedChannels: ["email", "sms"],
      uncertainChannels: [],
    });
  });

  it.each([
    {
      label: "missing channel evidence",
      evidence: [evidence("email", "failed")],
    },
    {
      label: "duplicate channel evidence",
      evidence: [evidence("email", "failed"), evidence("email", "failed")],
    },
    {
      label: "uncertain provider result",
      evidence: [
        evidence("email", "failed"),
        evidence("sms", "reconciliation_required"),
      ],
    },
  ])("quarantines $label", ({ evidence: results }) => {
    expect(
      planPartnerInviteTerminal(["email", "sms"], results),
    ).toMatchObject({ state: "reconciliation_required" });
  });
});

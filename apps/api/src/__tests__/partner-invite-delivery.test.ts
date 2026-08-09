import {
  classifyPartnerInviteProviderResult,
  summarizePartnerInviteDeliveries,
} from "@/lib/partner-invite-delivery";

describe("partner portal invite delivery truthfulness", () => {
  it("requires explicit provider acceptance before reporting success", () => {
    expect(
      classifyPartnerInviteProviderResult("email", {
        ok: true,
        provider: "smtp",
      }),
    ).toMatchObject({
      state: "reconciliation_required",
      providerExactlyOnceClaimed: false,
    });
  });

  it("reports all known non-sends as a failed invite", () => {
    const summary = summarizePartnerInviteDeliveries([
      classifyPartnerInviteProviderResult("email", {
        ok: false,
        provider: "smtp",
        deliveryCertainty: "not_sent",
        detail: "email_not_configured",
      }),
      classifyPartnerInviteProviderResult("sms", {
        ok: false,
        provider: "twilio",
        deliveryCertainty: "not_sent",
        detail: "sms_not_configured",
      }),
    ]);

    expect(summary).toEqual({
      state: "failed",
      acceptedChannels: [],
      failedChannels: ["email", "sms"],
      uncertainChannels: [],
      providerOperationIds: [],
    });
  });

  it("lets one accepted channel succeed while retaining known partial failure evidence", () => {
    const summary = summarizePartnerInviteDeliveries([
      classifyPartnerInviteProviderResult("email", {
        ok: true,
        provider: "smtp",
        providerMessageId: "mail-1",
        providerOperationIds: ["mail-1", "mail-1"],
        providerIdempotencySupported: false,
        deliveryCertainty: "accepted",
      }),
      classifyPartnerInviteProviderResult("sms", {
        ok: false,
        provider: "twilio",
        deliveryCertainty: "not_sent",
        detail: "sms_failed:400",
      }),
    ]);

    expect(summary).toEqual({
      state: "succeeded",
      acceptedChannels: ["email"],
      failedChannels: ["sms"],
      uncertainChannels: [],
      providerOperationIds: ["mail-1"],
    });
  });

  it("makes any uncertain provider effect override a separate accepted channel", () => {
    const summary = summarizePartnerInviteDeliveries([
      classifyPartnerInviteProviderResult("email", {
        ok: true,
        provider: "smtp",
        providerMessageId: "mail-2",
        deliveryCertainty: "accepted",
      }),
      classifyPartnerInviteProviderResult("sms", {
        ok: false,
        provider: "twilio",
        deliveryCertainty: "uncertain",
        detail: "sms_transport_error",
      }),
    ]);

    expect(summary).toMatchObject({
      state: "reconciliation_required",
      acceptedChannels: ["email"],
      failedChannels: [],
      uncertainChannels: ["sms"],
      providerOperationIds: ["mail-2"],
    });
  });
});

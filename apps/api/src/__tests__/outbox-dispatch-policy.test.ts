import { getOutboxDispatchBlock } from "@/lib/outbox-dispatch-policy";

describe("outbox dispatch kill-switch policy", () => {
  beforeEach(() => {
    delete process.env.TEAM_KILL_OUTBOX_DISPATCH;
    delete process.env.TEAM_KILL_EXTERNAL_SENDS;
  });

  afterAll(() => {
    delete process.env.TEAM_KILL_OUTBOX_DISPATCH;
    delete process.env.TEAM_KILL_EXTERNAL_SENDS;
  });

  it("blocks every event when outbox dispatch is disabled", () => {
    process.env.TEAM_KILL_OUTBOX_DISPATCH = "1";
    expect(getOutboxDispatchBlock("expense.receipt.analyze")).toEqual({
      reason: "outbox_dispatch_disabled",
      retryAfterMs: 60_000,
    });
  });

  it.each([
    "appointment.calendar_sync_requested",
    "estimate.requested",
    "message.send",
    "partner.account_invitation.email",
    "partner.access_application.email",
    "partner.auth.email",
    "partner.notification.dispatch",
    "partner.notification_endpoint.sms_code",
    "quote.send_requested.v2",
    "quote.accepted_and_booked.v2",
    "sales.escalation.call",
    "staff_notification.dispatch",
  ])(
    "blocks provider-bound %s events when external sends are disabled",
    (type) => {
      process.env.TEAM_KILL_EXTERNAL_SENDS = "true";
      expect(getOutboxDispatchBlock(type)?.reason).toBe(
        "external_sends_disabled",
      );
    },
  );

  it("allows internal processing while only external sends are disabled", () => {
    process.env.TEAM_KILL_EXTERNAL_SENDS = "1";
    expect(getOutboxDispatchBlock("expense.receipt.analyze")).toBeNull();
    expect(getOutboxDispatchBlock("facebook.dm.inbound")).toBeNull();
    expect(getOutboxDispatchBlock("quote.change_requested.v2")).toBeNull();
    expect(getOutboxDispatchBlock("quote.response_recorded.v2")).toBeNull();
    expect(
      getOutboxDispatchBlock("quote.deposit_checkout_requested.v2"),
    ).toBeNull();
  });
});

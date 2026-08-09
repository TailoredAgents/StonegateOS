import { publicSalesActivityContext } from "@/lib/sales-activity-public";

describe("public Sales Activity context", () => {
  const contactId = "123e4567-e89b-42d3-a456-426614174000";
  const threadId = "223e4567-e89b-42d3-a456-426614174001";
  const callRecordId = "323e4567-e89b-42d3-a456-426614174002";

  it("returns only bounded operational identifiers and safe tokens", () => {
    const context = publicSalesActivityContext({
      entityType: "conversation_message",
      entityId: "provider-message-id",
      meta: {
        contactId,
        threadId,
        callRecordId,
        channel: "SMS",
        actionType: "quote_followup",
        terminalOutcome: "connected",
        to: "+15555550123",
        from: "customer@example.com",
        messageBody: "private customer message",
        reason: "Customer asked about a private address",
        providerOperationId: "SM-provider-secret",
      },
    });

    expect(context).toEqual({
      contactId,
      leadId: null,
      threadId,
      callRecordId,
      taskId: null,
      channel: "sms",
      actionType: "quote_followup",
      terminalOutcome: "connected",
    });
    expect(JSON.stringify(context)).not.toContain("+15555550123");
    expect(JSON.stringify(context)).not.toContain("customer@example.com");
    expect(JSON.stringify(context)).not.toContain("private customer message");
    expect(JSON.stringify(context)).not.toContain("provider-secret");
  });

  it("rejects malformed identifiers, unknown channels, and free-form tokens", () => {
    expect(
      publicSalesActivityContext({
        entityType: "contact",
        entityId: "not-a-uuid",
        meta: {
          contactId: "also-not-a-uuid",
          threadId: `${threadId}?customer=private`,
          channel: "carrier pigeon",
          actionType: "Call the customer at +15555550123",
          terminalOutcome: "connected<script>",
        },
      }),
    ).toEqual({
      contactId: null,
      leadId: null,
      threadId: null,
      callRecordId: null,
      taskId: null,
      channel: null,
      actionType: null,
      terminalOutcome: null,
    });
  });

  it("uses a known UUID entity only for its matching relationship type", () => {
    expect(
      publicSalesActivityContext({
        entityType: "contact",
        entityId: contactId,
        meta: null,
      }).contactId,
    ).toBe(contactId);
    expect(
      publicSalesActivityContext({
        entityType: "provider_call",
        entityId: callRecordId,
        meta: null,
      }).callRecordId,
    ).toBeNull();
  });
});

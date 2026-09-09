import { calculatePartnerInvoiceLines, PartnerBillingCommandSchema } from "@/lib/partner-billing-administration";
import { renderPartnerBillingDocument, PartnerBillingDocumentSnapshotSchema } from "@/lib/partner-billing-document-renderer";
import { refundSquarePayment } from "@/lib/square-client";

describe("CRM-first billing contracts", () => {
  it("calculates fractional quantities in integer minor units with explicit tax and discount", () => {
    expect(calculatePartnerInvoiceLines([{ description: "Service", quantity: "1.125", unitAmountCents: 100 }], 9, 2))
      .toMatchObject({ subtotalCents: 113, totalCents: 120, lines: [{ lineTotalCents: 113 }] });
    expect(() => calculatePartnerInvoiceLines([{ description: "Service", quantity: "0", unitAmountCents: 100 }], 0, 0)).toThrow();
    expect(() => calculatePartnerInvoiceLines([{ description: "Service", quantity: "999999.999", unitAmountCents: 2_147_483_647 }], 0, 0)).toThrow();
  });
  it("requires an explicit separate acknowledgment for an already-given manual refund", () => {
    const refund = { action: "record_manual_refund", invoiceId: "11111111-1111-4111-8111-111111111111",
      paymentId: "22222222-2222-4222-8222-222222222222", amountCents: 100, reason: "Duplicate collection" };
    expect(PartnerBillingCommandSchema.safeParse(refund).success).toBe(false);
    expect(PartnerBillingCommandSchema.safeParse({ ...refund, confirmation: "REFUND ALREADY GIVEN" }).success).toBe(true);
    expect(PartnerBillingCommandSchema.safeParse({ ...refund, action: "refund_payment", provider: "manual" }).success).toBe(false);
  });
  it("renders a real bounded PDF deterministically and rejects internal snapshot metadata", async () => {
    const snapshot = { title: "Invoice", number: "SG-TEST", accountName: "Example company", issuedAt: "2026-09-08T12:00:00.000Z", currency: "USD",
      lines: [{ description: "Service", quantity: "1", amountCents: 12345 }], totals: [{ label: "Balance due", amountCents: 12345 }], notes: [] };
    const first = await renderPartnerBillingDocument(snapshot); const second = await renderPartnerBillingDocument(snapshot);
    expect(first.subarray(0, 5).toString()).toBe("%PDF-"); expect(first.length).toBeGreaterThan(1000); expect(first.length).toBeLessThan(100_000);
    expect(first.equals(second)).toBe(true);
    expect(PartnerBillingDocumentSnapshotSchema.safeParse({ ...snapshot, internalNotes: "must not be serialized" }).success).toBe(false);
  });
  it("posts a refund with one stable idempotency key and verifies the returned payment binding", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = ((_url: unknown, init: RequestInit) => { calls.push(init); return Promise.resolve(new Response(JSON.stringify({ refund: {
      id: "refund-test", payment_id: "payment-test", status: "PENDING", amount_money: { amount: 100, currency: "USD" },
    } }), { status: 200 })); }) as typeof fetch;
    const command = { idempotencyKey: "11111111-1111-4111-8111-111111111111", paymentId: "payment-test", amountCents: 100, currency: "USD" as const, reason: "Duplicate collection" };
    await expect(refundSquarePayment(command, { accessToken: "local-test-token", fetchImpl })).resolves.toMatchObject({ status: "PENDING" });
    await refundSquarePayment(command, { accessToken: "local-test-token", fetchImpl });
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
    expect(calls[0]!.body).toEqual(calls[1]!.body);
    await expect(refundSquarePayment({ ...command, paymentId: "different-payment" }, { accessToken: "local-test-token", fetchImpl })).rejects.toThrow("binding_mismatch");
  });
});

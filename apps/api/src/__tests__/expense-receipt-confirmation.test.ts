import {
  parseExpenseReceiptConfirmation,
  storedExpenseReceiptExtractionRequiresDumpReview,
} from "@/lib/expense-receipt-confirmation";
import { normalizeScaleTicketDuplicateIdentity } from "@/lib/expense-receipt-evidence";

describe("expense receipt scale-ticket confirmation guard", () => {
  const submission = {
    amountCents: 5_000,
    purchaseDate: "2026-08-27",
    categoryId: "fuel",
    payerType: "company" as const,
    paidByMemberId: null,
  };

  it.each([
    [{ schemaVersion: 3, raw: { documentType: "scale_ticket" } }],
    [{ schemaVersion: 1, raw: { receiptType: "scale_ticket" } }],
    [{ raw: { documentType: "unknown", dumpTicket: { net: "bad" } } }],
    [{ raw: { documentType: "unknown", dumpDetails: {} } }],
  ])(
    "fails closed for recognizable scale evidence in malformed or future storage",
    (stored) => {
      expect(storedExpenseReceiptExtractionRequiresDumpReview(stored)).toBe(
        true,
      );
    },
  );

  it.each([
    [null],
    [{ schemaVersion: 3, raw: { documentType: "standard_receipt" } }],
    [{ raw: { documentType: "unknown", dumpTicket: null } }],
  ])("does not invent a scale review requirement for %p", (stored) => {
    expect(storedExpenseReceiptExtractionRequiresDumpReview(stored)).toBe(
      false,
    );
  });

  it("normalizes facility and ticket identifiers but ignores incomplete keys", () => {
    expect(
      normalizeScaleTicketDuplicateIdentity({
        facilityName: "  Speedway TRANSFER-Station ",
        ticketNumber: " Ticket # 697723 ",
      }),
    ).toEqual({
      facilityName: "speedway transfer station",
      ticketNumber: "ticket 697723",
    });
    expect(
      normalizeScaleTicketDuplicateIdentity({
        facilityName: "Speedway Transfer Station",
        ticketNumber: null,
      }),
    ).toBeNull();
    expect(
      normalizeScaleTicketDuplicateIdentity({
        facilityName: "Café Transfer",
        ticketNumber: "A&B É123",
      }),
    ).toEqual({
      facilityName: "cafe transfer",
      ticketNumber: "a and b e123",
    });
  });

  it("accepts only an explicit human not-scale-ticket disposition without dump facts", () => {
    expect(
      parseExpenseReceiptConfirmation({
        ...submission,
        scaleTicketDisposition: "not_scale_ticket",
      }),
    ).toMatchObject({
      scaleTicketDisposition: "not_scale_ticket",
      submission: { dumpDetails: null },
    });
    expect(() =>
      parseExpenseReceiptConfirmation({
        ...submission,
        scaleTicketDisposition: "ordinary_receipt",
      }),
    ).toThrow("Choose a valid receipt classification");
    expect(() =>
      parseExpenseReceiptConfirmation({
        ...submission,
        categoryId: "dump_fees",
        scaleTicketDisposition: "not_scale_ticket",
        dumpDetails: {
          weightStatus: "confirmed",
          netWeightPounds: 2_900,
          reviewed: true,
        },
      }),
    ).toThrow("cannot be both a reviewed scale ticket");
  });

  it("strips and validates the scale-review contract marker", () => {
    expect(
      parseExpenseReceiptConfirmation({
        ...submission,
        receiptReviewContractVersion: 2,
      }),
    ).toMatchObject({ receiptReviewContractVersion: 2 });
    expect(parseExpenseReceiptConfirmation(submission)).toMatchObject({
      receiptReviewContractVersion: null,
    });
    expect(() =>
      parseExpenseReceiptConfirmation({
        ...submission,
        receiptReviewContractVersion: 1,
      }),
    ).toThrow("Refresh StonegateOS");
    expect(() =>
      parseExpenseReceiptConfirmation({
        ...submission,
        receiptReviewContractVersion: "2",
      }),
    ).toThrow("Refresh StonegateOS");
  });
});

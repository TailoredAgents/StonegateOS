import { calculatePartnerInvoiceSettlement } from "@/lib/partner-invoice-ledger";

const now = new Date("2026-09-08T15:00:00Z");
describe("CRM-first invoice settlement", () => {
  it("combines settled cash, card, and ACH principal without counting tips", () => {
    expect(calculatePartnerInvoiceSettlement({ totalCents: 20_000, dueAt: null, now,
      entries: [
        { allocatedCents: 5_000, refundedJobCents: 0 },
        { allocatedCents: 10_000, refundedJobCents: 0 },
        { allocatedCents: 5_000, refundedJobCents: 0 },
      ],
    })).toEqual({ paidCents: 20_000, balanceCents: 0, status: "paid" });
  });
  it("reflects a settled partial refund without rewriting invoice charges", () => {
    expect(calculatePartnerInvoiceSettlement({ totalCents: 20_000, dueAt: null, now,
      entries: [{ allocatedCents: 20_000, refundedJobCents: 3_000 }],
    })).toEqual({ paidCents: 17_000, balanceCents: 3_000, status: "partially_paid" });
  });
  it("reconciles a replacement payment after a refund without double counting", () => {
    expect(calculatePartnerInvoiceSettlement({ totalCents: 20_000, dueAt: null, now,
      entries: [
        { allocatedCents: 20_000, refundedJobCents: 3_000 },
        { allocatedCents: 3_000, refundedJobCents: 0 },
      ],
    })).toEqual({ paidCents: 20_000, balanceCents: 0, status: "paid" });
  });
  it("leaves overdue balances overdue even after partial collection", () => {
    expect(calculatePartnerInvoiceSettlement({ totalCents: 20_000,
      dueAt: new Date("2026-09-07T23:59:59Z"), now,
      entries: [{ allocatedCents: 5_000, refundedJobCents: 0 }],
    }).status).toBe("overdue");
  });
  it("rejects invalid or overallocated amounts rather than hiding extra collection", () => {
    expect(() => calculatePartnerInvoiceSettlement({ totalCents: 10_000, dueAt: null,
      entries: [{ allocatedCents: 10_001, refundedJobCents: 0 }],
    })).toThrow("overallocated");
    expect(() => calculatePartnerInvoiceSettlement({ totalCents: 10_000, dueAt: null,
      entries: [{ allocatedCents: 1.5, refundedJobCents: 0 }],
    })).toThrow("invalid_amount");
  });
});

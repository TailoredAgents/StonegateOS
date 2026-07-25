import {
  isPaymentLedgerSchemaAvailable,
  type PaymentSchemaProbeDatabase,
} from "@/lib/payment-schema";

function probeReturning(
  value: unknown,
): PaymentSchemaProbeDatabase {
  return {
    execute: jest.fn().mockResolvedValue([{ available: value }]),
  } as unknown as PaymentSchemaProbeDatabase;
}

describe("payment ledger schema availability", () => {
  it("reports the provider-neutral ledger when the probe succeeds", async () => {
    await expect(
      isPaymentLedgerSchemaAvailable(probeReturning(true)),
    ).resolves.toBe(true);
  });

  it("keeps Release A disabled when the payment schema is absent", async () => {
    await expect(
      isPaymentLedgerSchemaAvailable(probeReturning(false)),
    ).resolves.toBe(false);
    await expect(
      isPaymentLedgerSchemaAvailable(probeReturning(null)),
    ).resolves.toBe(false);
  });

  it("fails closed when the schema probe cannot run", async () => {
    const database = {
      execute: jest.fn().mockRejectedValue(new Error("database unavailable")),
    } as unknown as PaymentSchemaProbeDatabase;

    await expect(
      isPaymentLedgerSchemaAvailable(database),
    ).resolves.toBe(false);
  });
});

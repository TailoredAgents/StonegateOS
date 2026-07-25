import "dotenv/config";
import Module from "node:module";
import path from "node:path";

function registerAliases() {
  const originalResolve = (Module as unknown as { _resolveFilename: Module['_resolveFilename'] })._resolveFilename;
  (Module as unknown as { _resolveFilename: Module['_resolveFilename'] })._resolveFilename = function (
    request: string,
    parent: any,
    isMain: boolean,
    options: any
  ) {
    if (request.startsWith("@/")) {
      const absolute = path.resolve("apps/api/src", request.slice(2));
      return originalResolve.call(this, absolute, parent, isMain, options);
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };
}

async function main() {
  registerAliases();
  const { getDb, payments } = await import("../apps/api/src/db");
  const paymentSummary = await import("../apps/api/src/lib/payment-summary");
  const stripeLib = await import("../apps/api/src/lib/stripe");
  const matching = await import("../apps/api/src/lib/payment-matching");

  const days = Number(process.env["STRIPE_BACKFILL_DAYS"] ?? 14);
  const charges = await stripeLib.listRecentCharges(days);
  const db = getDb();

  let upserted = 0;
  for (const c of charges) {
    const row = stripeLib.mapChargeToPaymentRow(c);
    const resolvedAppointmentId = row.appointmentId ?? (await matching.resolveAppointmentIdForCharge(db, c));
    const canonicalStatus = paymentSummary.mapProviderPaymentStatus("stripe", row.status);
    const paidAt = row.capturedAt ?? row.createdAt;

    await db
      .insert(payments)
      .values({
        stripeChargeId: row.stripeChargeId,
        provider: "stripe",
        providerPaymentId: row.stripeChargeId,
        amount: row.amount,
        jobAmountCents: row.amount,
        tipCents: 0,
        totalAmountCents: row.amount,
        refundedAmountCents: 0,
        currency: row.currency,
        status: row.status,
        canonicalStatus,
        providerStatus: row.status,
        method: row.method ?? null,
        tenderType: row.method ?? null,
        cardBrand: row.cardBrand ?? null,
        last4: row.last4 ?? null,
        receiptUrl: row.receiptUrl ?? null,
        legacySource: "stripe_import",
        metadata: row.metadata ?? null,
        appointmentId: resolvedAppointmentId ?? null,
        createdAt: row.createdAt,
        providerCreatedAt: row.createdAt,
        paidAt,
        capturedAt: row.capturedAt ?? null
      })
      .onConflictDoUpdate({
        target: payments.stripeChargeId,
        set: {
          provider: "stripe",
          providerPaymentId: row.stripeChargeId,
          amount: row.amount,
          jobAmountCents: row.amount,
          tipCents: 0,
          totalAmountCents: row.amount,
          refundedAmountCents: 0,
          currency: row.currency,
          status: row.status,
          canonicalStatus,
          providerStatus: row.status,
          method: row.method ?? null,
          tenderType: row.method ?? null,
          cardBrand: row.cardBrand ?? null,
          last4: row.last4 ?? null,
          receiptUrl: row.receiptUrl ?? null,
          legacySource: "stripe_import",
          metadata: row.metadata ?? null,
          appointmentId: resolvedAppointmentId ?? null,
          providerCreatedAt: row.createdAt,
          paidAt,
          capturedAt: row.capturedAt ?? null,
          updatedAt: new Date()
        }
      });
    upserted += 1;
  }

  console.log(JSON.stringify({ ok: true, upserted, days }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

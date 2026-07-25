import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, payments } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { mapProviderPaymentStatus } from "@/lib/payment-summary";
import { listRecentCharges, mapChargeToPaymentRow } from "@/lib/stripe";
import { resolveAppointmentIdForCharge } from "@/lib/payment-matching";
import { requirePermission } from "@/lib/permissions";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "payments.manage");
  if (permissionError) return permissionError;

  let rawBody: unknown = {};
  try {
    rawBody = await request.json();
  } catch {
    rawBody = {};
  }

  const daysInput =
    rawBody && typeof rawBody === "object" && "days" in rawBody
      ? (rawBody as Record<string, unknown>)["days"]
      : undefined;
  const days =
    typeof daysInput === "number" && daysInput > 0 && daysInput <= 90 ? daysInput : 14;

  try {
    const db = getDb();
    const paymentLedgerAvailable =
      await isPaymentLedgerSchemaAvailable(db);
    const charges = await listRecentCharges(days);

    let upserted = 0;
    for (const charge of charges) {
      const row = mapChargeToPaymentRow(charge);
      const resolvedAppointmentId = row.appointmentId ?? (await resolveAppointmentIdForCharge(db, charge));
      if (!paymentLedgerAvailable) {
        await db
          .insert(payments)
          .values({
            stripeChargeId: row.stripeChargeId,
            amount: row.amount,
            currency: row.currency,
            status: row.status,
            method: row.method ?? null,
            cardBrand: row.cardBrand ?? null,
            last4: row.last4 ?? null,
            receiptUrl: row.receiptUrl ?? null,
            metadata: row.metadata ?? null,
            appointmentId: resolvedAppointmentId ?? null,
            createdAt: row.createdAt,
            capturedAt: row.capturedAt ?? null,
          })
          .onConflictDoUpdate({
            target: payments.stripeChargeId,
            set: {
              amount: row.amount,
              currency: row.currency,
              status: row.status,
              method: row.method ?? null,
              cardBrand: row.cardBrand ?? null,
              last4: row.last4 ?? null,
              receiptUrl: row.receiptUrl ?? null,
              metadata: row.metadata ?? null,
              appointmentId: resolvedAppointmentId ?? null,
              capturedAt: row.capturedAt ?? null,
              updatedAt: new Date(),
            },
          });
        upserted += 1;
        continue;
      }
      const canonicalStatus = mapProviderPaymentStatus("stripe", row.status);
      const paidAt = row.capturedAt ?? row.createdAt;
      // Upsert by stripeChargeId
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
            totalAmountCents: row.amount,
            currency: row.currency,
            status: row.status,
            providerStatus: row.status,
            method: row.method ?? null,
            tenderType: row.method ?? null,
            cardBrand: row.cardBrand ?? null,
            last4: row.last4 ?? null,
            receiptUrl: row.receiptUrl ?? null,
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

    return NextResponse.json({ ok: true, upserted, days });
  } catch (error) {
    return NextResponse.json({ error: "backfill_failed", details: String(error) }, { status: 500 });
  }
}

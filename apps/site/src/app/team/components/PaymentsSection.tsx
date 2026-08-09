import React, { type ReactElement } from "react";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { PaymentsList } from "../PaymentsList";
import { callAdminApiAs } from "../lib/api";
import { attachPaymentAction, detachPaymentAction } from "../actions";

type PaymentDto = {
  id: string;
  stripeChargeId: string | null;
  provider: string;
  providerPaymentId: string | null;
  providerOrderId: string | null;
  amount: number;
  jobAmountCents: number;
  tipCents: number;
  totalAmountCents: number;
  currency: string;
  status: string;
  canonicalStatus: string;
  method: string | null;
  tenderType: string | null;
  cardBrand: string | null;
  last4: string | null;
  receiptUrl: string | null;
  legacySource: string | null;
  createdAt: string;
  updatedAt: string;
  appointment: null | {
    id: string;
    status: string;
    startAt: string | null;
    contactName: string | null;
  };
};

export async function PaymentsSection(): Promise<ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const res = await callAdminApiAs(principal, "/api/payments?status=all");
  if (!res.ok) throw new Error("Failed to load payments");

  const payload = (await res.json()) as {
    payments: PaymentDto[];
    summary: {
      total: number;
      matched: number;
      unmatched: number;
      needsReview?: number;
    };
  };

  return (
    <PaymentsList
      initial={payload.payments}
      summary={payload.summary}
      attachAction={attachPaymentAction}
      detachAction={detachPaymentAction}
      canChangeAssociations={
        hasTeamPermission(principal, "payments.reconcile") &&
        hasTeamPermission(principal, "payments.manage")
      }
    />
  );
}

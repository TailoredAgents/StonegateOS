"use server";
import {
  requireCurrentTeamPrincipal,
  hasTeamPermission,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  readTeamMutationError,
  readTeamMutationSuccess,
} from "../lib/mutation-feedback";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export type AllocationReconciliationView = {
  revision: string;
  job: {
    id: string;
    accountName: string;
    finalTotalCents: number | null;
    quotedTotalCents: number | null;
    status: string;
  };
  blockers: string[];
  unexplainedPaidPrincipalCents: number;
  invoices: {
    id: string;
    number: string;
    status: string;
    currency: string;
    totalCents: number;
    paidCents: number;
    creditedCents: number;
    balanceCents: number;
    version: number;
  }[];
  payments: {
    id: string;
    method: string | null;
    currency: string;
    jobAmountCents: number | null;
    tipCents: number;
    status: string;
    capturedAt: string | null;
    createdAt: string;
  }[];
  allocations: {
    id: string;
    partnerInvoiceId: string;
    paymentId: string;
    amountCents: number;
    state: string;
  }[];
  refunds: {
    id: string;
    paymentId: string;
    jobAmountCents: number;
    tipCents: number;
    amountCents: number;
    status: string;
  }[];
  refundAllocations: {
    partnerInvoiceId: string;
    refundId: string;
    jobAmountCents: number;
  }[];
  history: {
    id: string;
    paymentId: string;
    reason: string;
    evidenceReference: string;
    createdAt: string;
  }[];
};
export async function loadPartnerAllocationReconciliation(
  accountId: string,
  jobId: string,
): Promise<
  | { ok: true; data: AllocationReconciliationView }
  | { ok: false; message: string }
> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !uuid.test(accountId) ||
    !uuid.test(jobId) ||
    !hasTeamPermission(principal, "partners.commercial.read")
  )
    return { ok: false, message: "Choose a company job you can view." };
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/accounts/${accountId}/billing/reconciliation/${jobId}`,
      { timeoutMs: 15000 },
    );
    if (!response.ok)
      return {
        ok: false,
        message: await readTeamMutationError(
          response,
          "The reconciliation records could not be loaded.",
        ),
      };
    const payload = (await response.json()) as {
      ok?: boolean;
      data?: AllocationReconciliationView;
    };
    if (
      !payload.ok ||
      payload.data?.job.id !== jobId ||
      !/^[a-f0-9]{64}$/u.test(payload.data.revision) ||
      !Array.isArray(payload.data.payments) ||
      !Array.isArray(payload.data.invoices)
    )
      return {
        ok: false,
        message: "The financial record response could not be verified.",
      };
    return { ok: true, data: payload.data };
  } catch {
    return {
      ok: false,
      message: "The reconciliation records could not be loaded. Try again.",
    };
  }
}
export async function savePartnerAllocationReconciliation(
  accountId: string,
  jobId: string,
  revision: string,
  command: unknown,
  key: string,
) {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !uuid.test(accountId) ||
    !uuid.test(jobId) ||
    !uuid.test(key) ||
    !/^[a-f0-9]{64}$/u.test(revision) ||
    !hasTeamPermission(principal, "partners.commercial.manage")
  )
    return {
      ok: false,
      message: "Your role cannot reconcile this company’s payments.",
    };
  try {
    const body = JSON.stringify(command);
    if (body.length > 256 * 1024)
      return { ok: false, message: "Use a smaller reconciliation batch." };
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/accounts/${accountId}/billing/reconciliation/${jobId}`,
      {
        method: "POST",
        body,
        timeoutMs: 30000,
        headers: { "Idempotency-Key": key, "If-Match": `"${revision}"` },
      },
    );
    if (!response.ok)
      return {
        ok: false,
        message: await readTeamMutationError(
          response,
          "No allocation change was confirmed. Refresh the records before retrying.",
        ),
      };
    const receipt = await readTeamMutationSuccess(response);
    return receipt
      ? {
          ok: true,
          message:
            "Reconciliation recorded without collecting money. Existing records are preserved; verified historical receipts and corrected allocation documents are being prepared.",
        }
      : {
          ok: false,
          message:
            "The result could not be verified. Retry this same request or refresh; do not record a new payment.",
        };
  } catch {
    return {
      ok: false,
      message:
        "The result could not be confirmed. Retry this same request or refresh; do not record a new payment.",
    };
  }
}

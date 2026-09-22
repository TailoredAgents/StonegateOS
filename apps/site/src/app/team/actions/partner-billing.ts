"use server";
import {
  parsePartnerQuoteServiceSeeds,
  type PartnerQuoteServiceSeed,
} from "../lib/quote-v2-composer-model";
import { revalidatePath } from "next/cache";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  readTeamMutationError,
  readTeamMutationSuccess,
} from "../lib/mutation-feedback";

export type BillingLine = {
  description: string;
  quantity: string;
  unitAmountCents: number;
  lineTotalCents: number;
};
export type BillingInvoice = {
  id: string;
  jobId: string | null;
  requestModelVersion?: number | null;
  number: string;
  currency: string;
  status: string;
  version: number;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  depositCents: number;
  totalCents: number;
  paidCents: number;
  creditedCents: number;
  balanceCents: number;
  dueDate: string | null;
  poNumber: string | null;
  costCenter: string | null;
  billingContact: { name?: string; email?: string };
  terms: string | null;
  documentId: string | null;
  lines: BillingLine[];
  payments: {
    paymentId: string;
    provider: string;
    method: string | null;
    totalCents: number;
    amountCents: number;
    refundedCents: number;
    status: string;
  }[];
  documents: {
    id: string;
    kind: string;
    status: string;
    documentId: string | null;
  }[];
  refunds: {
    id: string;
    paymentId: string;
    amountCents: number;
    status: string;
  }[];
  historyLoaded: false;
};
export type BillingHistoryKind = "documents" | "refunds";
export type BillingHistoryItem = {
  id: string;
  createdAt: string;
  status: string;
} & (
  | { kind: string; documentId: string | null }
  | { paymentId: string; amountCents: number }
);
export type BillingHistoryPage = {
  accountId: string;
  invoiceId: string;
  kind: BillingHistoryKind;
  items: BillingHistoryItem[];
  nextCursor: string | null;
};
export type BillingAdministrationData = {
  account: { id: string; name: string };
  invoices: BillingInvoice[];
  jobs: {
    id: string;
    service: string | null;
    status: string;
    arrivalAt: string | null;
    reference: string | null;
    totalCents: number | null;
    serviceLines?: PartnerQuoteServiceSeed[];
  }[];
  statements: {
    id: string;
    periodStart: string;
    periodEnd: string;
    revision: number;
    documentId: string | null;
    closingBalanceCents: number;
  }[];
  nextCursor: string | null;
  nextJobCursor: string | null;
  nextStatementCursor: string | null;
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function loadPartnerBillingHistory(
  accountId: string,
  invoiceId: string,
  kind: BillingHistoryKind,
  cursor?: string,
): Promise<
  { ok: true; data: BillingHistoryPage } | { ok: false; message: string }
> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !UUID.test(accountId) ||
    !UUID.test(invoiceId) ||
    !["documents", "refunds"].includes(kind) ||
    !hasTeamPermission(principal, "partners.commercial.read") ||
    (cursor !== undefined &&
      (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)))
  )
    return { ok: false, message: "Choose an invoice you can view." };
  try {
    const query = new URLSearchParams({ kind });
    if (cursor) query.set("cursor", cursor);
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/accounts/${accountId}/billing/invoices/${invoiceId}/history?${query}`,
      { timeoutMs: 15_000 },
    );
    const payload = response.ok
      ? ((await response.json()) as BillingHistoryPage & { ok?: boolean })
      : null;
    if (
      !payload?.ok ||
      payload.accountId !== accountId ||
      payload.invoiceId !== invoiceId ||
      payload.kind !== kind ||
      !Array.isArray(payload.items) ||
      payload.items.length > 100 ||
      !(payload.nextCursor === null || typeof payload.nextCursor === "string")
    )
      return {
        ok: false,
        message:
          "History could not be loaded. Retry, or refresh the history to start again.",
      };
    return { ok: true, data: payload };
  } catch {
    return {
      ok: false,
      message:
        "History could not be loaded. Your current records are unchanged; try again.",
    };
  }
}
export async function loadPartnerBillingAdministration(
  accountId: string,
  options: {
    cursor?: string;
    jobCursor?: string;
    statementCursor?: string;
    invoiceId?: string;
  } = {},
): Promise<
  { ok: true; data: BillingAdministrationData } | { ok: false; message: string }
> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !UUID.test(accountId) ||
    !hasTeamPermission(principal, "partners.commercial.read") ||
    Object.values(options).some(
      (value) => typeof value !== "string" || !UUID.test(value),
    )
  )
    return { ok: false, message: "Choose a company you can manage." };
  try {
    const query = new URLSearchParams(options);
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/accounts/${accountId}/billing?${query}`,
      { timeoutMs: 15_000 },
    );
    const payload = response.ok
      ? ((await response.json()) as BillingAdministrationData & {
          ok?: boolean;
        })
      : null;
    if (
      !payload?.ok ||
      payload.account?.id !== accountId ||
      !Array.isArray(payload.invoices) ||
      !Array.isArray(payload.jobs) ||
      payload.jobs.some(
        (job) =>
          job.serviceLines !== undefined &&
          !parsePartnerQuoteServiceSeeds(job.serviceLines),
      )
    )
      return { ok: false, message: "Billing could not be loaded. Try again." };
    return { ok: true, data: payload };
  } catch {
    return { ok: false, message: "Billing could not be loaded. Try again." };
  }
}

export async function savePartnerBillingCommand(
  accountId: string,
  command: unknown,
  key: string,
  version?: number,
): Promise<{ ok: boolean; message: string; invoiceId?: string }> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !UUID.test(accountId) ||
    !UUID.test(key) ||
    !hasTeamPermission(principal, "partners.commercial.manage")
  )
    return {
      ok: false,
      message: "Your role cannot change this company's billing.",
    };
  if (
    command &&
    typeof command === "object" &&
    "action" in command &&
    command.action === "record_manual_payment" &&
    !hasTeamPermission(principal, "payments.collect")
  )
    return { ok: false, message: "Your role cannot record received payments." };
  let body: string;
  try {
    body = JSON.stringify(command);
  } catch {
    return { ok: false, message: "Check the invoice fields." };
  }
  if (body.length > 64 * 1024)
    return { ok: false, message: "Use fewer or shorter invoice lines." };
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/accounts/${accountId}/billing`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": key,
          ...(version ? { "If-Match": `"${version}"` } : {}),
        },
        body,
      },
    );
    if (!response.ok)
      return {
        ok: false,
        message: await readTeamMutationError(
          response,
          "The billing change could not be completed.",
        ),
      };
    const receipt = await readTeamMutationSuccess<{
      invoiceId?: string;
      operationId?: string;
      refundRequestId?: string;
    }>(response);
    if (!receipt)
      return {
        ok: false,
        message: "The result could not be verified. Refresh before retrying.",
      };
    revalidatePath("/team/partners");
    return {
      ok: true,
      message: receipt.data.refundRequestId
        ? "Refund requested. It remains pending until Square confirms the result."
        : receipt.data.operationId
          ? "Saved. The financial document is being prepared; partners will be notified when it is ready."
          : "Invoice draft saved. Review it before issuing.",
      ...(receipt.data.invoiceId ? { invoiceId: receipt.data.invoiceId } : {}),
    };
  } catch {
    return {
      ok: false,
      message:
        "The result could not be confirmed. Retry this same action or refresh to check; do not create a second payment or refund.",
    };
  }
}

export async function getStaffBillingDocument(
  accountId: string,
  documentId: string,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const principal = await requireCurrentTeamPrincipal();
  if (
    !UUID.test(accountId) ||
    !UUID.test(documentId) ||
    !hasTeamPermission(principal, "partners.commercial.read")
  )
    return { ok: false, message: "This document is not available." };
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/accounts/${accountId}/billing/documents/${documentId}`,
    );
    const payload = response.ok
      ? ((await response.json()) as { ok?: boolean; url?: string })
      : null;
    if (
      !payload?.ok ||
      !payload.url ||
      new URL(payload.url).protocol !== "https:"
    )
      return {
        ok: false,
        message: "Document download is unavailable. Try again.",
      };
    return { ok: true, url: payload.url };
  } catch {
    return {
      ok: false,
      message: "Document download is unavailable. Try again.",
    };
  }
}

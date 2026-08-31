import type { Metadata, Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  CircleDollarSign,
  FileClock,
  FileText,
  ReceiptText,
  ScrollText,
} from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import { PartnerDocumentDownloadButton } from "@/app/partners/components/PartnerDocumentDownloadButton";
import {
  PartnerInvoicePaymentAction,
  PartnerPaymentReturnStatus,
  type PartnerPaymentSecurity,
} from "@/app/partners/components/PartnerInvoicePayment";
import {
  PartnerEmptyState,
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
  PartnerStatusBadge,
} from "@/app/partners/components/PartnerPortalUi";
import {
  formatPartnerDate,
  formatPartnerMoney,
  isPartnerDocument,
  isPartnerInvoice,
  isPartnerQuote,
  isPartnerStatement,
  loadPartnerCommercial,
  type PartnerCommercialState,
} from "@/app/partners/lib/portal-commercial";
import { isPartnerPaymentIntentId } from "@/app/partners/lib/portal-payments";
import {
  parsePartnerServiceRateCard,
  type PartnerServiceRateCardState,
  type PartnerServiceRateItem,
} from "@/app/partners/lib/partner-service-rate-card";
import type {
  PartnerDocument,
  PartnerInvoice,
  PartnerQuote,
  PartnerStatement,
} from "@/app/partners/lib/portal-v2";

export const metadata: Metadata = { title: "Billing & documents" };

type PaymentAccess = {
  available: boolean;
  canManagePayments: boolean;
  security: PartnerPaymentSecurity | null;
  payerEmail: string | null;
};

async function loadRateCard(): Promise<PartnerServiceRateCardState> {
  const response = await callPartnerApi("/api/portal/v2/service-catalog", {
    timeoutMs: 15_000,
  }).catch(() => null);
  if (!response) return { status: "unavailable" };
  if (response.status === 401 || response.status === 403)
    return { status: "forbidden" };
  if ([404, 409, 501, 503].includes(response.status))
    return { status: "unavailable" };
  if (!response.ok) return { status: "error" };
  return parsePartnerServiceRateCard(
    (await response.json().catch(() => null)) as unknown,
  );
}

async function loadPaymentAccess(): Promise<PaymentAccess> {
  const response = await callPartnerApi("/api/portal/v2/me", {
    timeoutMs: 12_000,
  }).catch(() => null);
  if (!response?.ok) {
    return {
      available: false,
      canManagePayments: false,
      security: null,
      payerEmail: null,
    };
  }
  const payload = (await response.json().catch(() => null)) as {
    ok?: unknown;
    partnerUser?: { email?: unknown };
    membership?: { capabilities?: unknown; accessLevel?: unknown };
    security?: { mfaEnrolled?: unknown; mfaSatisfied?: unknown };
  } | null;
  const capabilities = payload?.membership?.capabilities;
  const canManagePayments =
    payload?.ok === true &&
    payload.membership?.accessLevel === "account" &&
    Array.isArray(capabilities) &&
    capabilities.includes("payments.manage");
  if (payload?.ok !== true || !Array.isArray(capabilities)) {
    return {
      available: false,
      canManagePayments: false,
      security: null,
      payerEmail: null,
    };
  }
  return {
    available: true,
    canManagePayments,
    security:
      typeof payload?.security?.mfaEnrolled === "boolean" &&
      typeof payload.security.mfaSatisfied === "boolean"
        ? {
            enrolled: payload.security.mfaEnrolled,
            satisfied: payload.security.mfaSatisfied,
          }
        : null,
    payerEmail:
      typeof payload.partnerUser?.email === "string" &&
      payload.partnerUser.email.length <= 320
        ? payload.partnerUser.email
        : null,
  };
}

function formatLabel(value: string | null): string {
  if (!value) return "Document";
  return value
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${value} bytes`;
}

function CollectionFallback({
  state,
  resource,
}: {
  state: Exclude<PartnerCommercialState<unknown>, { status: "ready" }>;
  resource: string;
}) {
  if (state.status === "forbidden") {
    return (
      <PartnerNotice tone="info">
        Your account role does not include access to {resource}. Ask an account
        administrator if you need it.
      </PartnerNotice>
    );
  }
  if (state.status === "unavailable") {
    return (
      <PartnerNotice tone="warning">
        {formatLabel(resource)} are not available through the account service
        yet. No records are being hidden or treated as paid.
      </PartnerNotice>
    );
  }
  return (
    <PartnerNotice tone="error">
      We could not load {resource}. Refresh this page before relying on the
      list.
    </PartnerNotice>
  );
}

function MoreRecordsNotice() {
  return (
    <PartnerNotice tone="info" className="mt-4">
      This view shows the 100 most recent records. Contact Stonegate if you need
      older account history while portal pagination is being completed.
    </PartnerNotice>
  );
}

export default async function PartnerBillingPage({
  searchParams,
}: {
  searchParams?: Promise<{ paymentIntentId?: string | string[] }>;
}) {
  const resolvedSearchParams: Promise<{
    paymentIntentId?: string | string[];
  }> = searchParams ?? Promise.resolve({});
  const [
    rates,
    invoices,
    quotes,
    statements,
    documents,
    paymentAccess,
    params,
  ] = await Promise.all([
    loadRateCard(),
    loadPartnerCommercial("invoices", "invoices", isPartnerInvoice),
    loadPartnerCommercial("quotes", "quotes", isPartnerQuote),
    loadPartnerCommercial("statements", "statements", isPartnerStatement),
    loadPartnerCommercial("documents", "documents", isPartnerDocument),
    loadPaymentAccess(),
    resolvedSearchParams,
  ]);
  const paymentIntentId = isPartnerPaymentIntentId(params.paymentIntentId)
    ? params.paymentIntentId
    : null;

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow="Account financial records"
        title="Billing & documents"
        description="Review account pricing, quotes, invoices, statements, and secure documents without mixing them with operational job totals."
        breadcrumbs={[
          { label: "Overview", href: "/partners" },
          { label: "Billing & documents", href: "/partners/billing" },
        ]}
      >
        <PartnerNotice tone="info">
          {!paymentAccess.available
            ? "Protected payment controls are temporarily unavailable. Invoice records remain visible, but no payment has been started or treated as complete."
            : paymentAccess.canManagePayments
              ? "Required deposits can be paid by card through Square’s secure form in this page. Remaining invoice balances open on Square’s hosted payment page. ACH is not offered in this portal."
              : "Invoice status is read-only for your current role. An authorized account billing user can pay eligible balances by card on Square, or contact Stonegate for assistance."}
        </PartnerNotice>
      </PartnerPageHeader>

      <PartnerPanel>
        <SectionHeading
          icon={<CircleDollarSign className="h-5 w-5" aria-hidden="true" />}
          eyebrow="Current account"
          title="Partner rate card"
        />
        {rates.status !== "ready" ? (
          <div className="mt-5">
            <PartnerNotice
              tone={rates.status === "error" ? "error" : "warning"}
            >
              {rates.status === "forbidden"
                ? "Your role does not include account pricing."
                : rates.status === "error"
                  ? "We could not load the rate card. Refresh before using these prices."
                  : "Online account pricing is not available right now. Contact Stonegate for a current quote."}
            </PartnerNotice>
          </div>
        ) : rates.items.length === 0 ? (
          <div className="mt-5">
            <PartnerEmptyState
              title="No online rates available"
              description="Contact Stonegate for pricing and to confirm which services should be enabled for your account."
              action={{ href: "/partners/help", label: "Contact Stonegate" }}
              icon={<CircleDollarSign className="h-6 w-6" aria-hidden="true" />}
            />
          </div>
        ) : (
          <RateCard currency={rates.currency} items={rates.items} />
        )}
      </PartnerPanel>

      <PartnerPanel>
        <SectionHeading
          icon={<ReceiptText className="h-5 w-5" aria-hidden="true" />}
          eyebrow="Amounts due and paid"
          title="Invoices"
        />
        <div className="mt-5">
          <PartnerPaymentReturnStatus
            paymentIntentId={paymentIntentId}
            accessAvailable={paymentAccess.available}
            canManagePayments={paymentAccess.canManagePayments}
            initialSecurity={paymentAccess.security}
          />
          {invoices.status !== "ready" ? (
            <CollectionFallback state={invoices} resource="invoices" />
          ) : invoices.items.length === 0 ? (
            <PartnerEmptyState
              title="No invoices shared"
              description="Account invoices will appear here after they are issued and shared with your role."
              icon={<ReceiptText className="h-6 w-6" aria-hidden="true" />}
            />
          ) : (
            <InvoiceList items={invoices.items} paymentAccess={paymentAccess} />
          )}
          {invoices.status === "ready" && invoices.page.hasMore ? (
            <MoreRecordsNotice />
          ) : null}
        </div>
      </PartnerPanel>

      <PartnerPanel>
        <SectionHeading
          icon={<FileClock className="h-5 w-5" aria-hidden="true" />}
          eyebrow="Proposed scope and pricing"
          title="Quotes"
        />
        <div className="mt-5">
          {quotes.status !== "ready" ? (
            <CollectionFallback state={quotes} resource="quotes" />
          ) : quotes.items.length === 0 ? (
            <PartnerEmptyState
              title="No quotes shared"
              description="New account quotes will appear here when Stonegate sends them."
              icon={<FileClock className="h-6 w-6" aria-hidden="true" />}
            />
          ) : (
            <QuoteList items={quotes.items} />
          )}
          {quotes.status === "ready" && quotes.page.hasMore ? (
            <MoreRecordsNotice />
          ) : null}
        </div>
      </PartnerPanel>

      <PartnerPanel>
        <SectionHeading
          icon={<ScrollText className="h-5 w-5" aria-hidden="true" />}
          eyebrow="Account periods"
          title="Statements"
        />
        <div className="mt-5">
          {statements.status !== "ready" ? (
            <CollectionFallback state={statements} resource="statements" />
          ) : statements.items.length === 0 ? (
            <PartnerEmptyState
              title="No statements shared"
              description="Generated account statements will appear here by period."
              icon={<ScrollText className="h-6 w-6" aria-hidden="true" />}
            />
          ) : (
            <StatementList items={statements.items} />
          )}
          {statements.status === "ready" && statements.page.hasMore ? (
            <MoreRecordsNotice />
          ) : null}
        </div>
      </PartnerPanel>

      <PartnerPanel>
        <SectionHeading
          icon={<FileText className="h-5 w-5" aria-hidden="true" />}
          eyebrow="Secure account files"
          title="Documents"
        />
        <div className="mt-5">
          {documents.status !== "ready" ? (
            <CollectionFallback state={documents} resource="documents" />
          ) : documents.items.length === 0 ? (
            <PartnerEmptyState
              title="No documents shared"
              description="Generated invoices, statements, proof files, and other account documents will appear here."
              action={{ href: "/partners/help", label: "Request a document" }}
              icon={<FileText className="h-6 w-6" aria-hidden="true" />}
            />
          ) : (
            <DocumentList items={documents.items} />
          )}
          {documents.status === "ready" && documents.page.hasMore ? (
            <MoreRecordsNotice />
          ) : null}
        </div>
      </PartnerPanel>
    </div>
  );
}

function SectionHeading({
  icon,
  eyebrow,
  title,
}: {
  icon: ReactNode;
  eyebrow: string;
  title: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 text-primary-700">
        {icon}
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
          {eyebrow}
        </p>
        <h2 className="mt-0.5 text-lg font-semibold text-slate-950">{title}</h2>
      </div>
    </div>
  );
}

function RateCard({
  currency,
  items,
}: {
  currency: string;
  items: PartnerServiceRateItem[];
}) {
  const grouped = items.reduce<Map<string, PartnerServiceRateItem[]>>(
    (groups, item) => {
      const current = groups.get(item.serviceKey) ?? [];
      current.push(item);
      groups.set(item.serviceKey, current);
      return groups;
    },
    new Map(),
  );
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency });
  return (
    <>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {Array.from(grouped.entries()).map(([serviceKey, serviceItems]) => (
          <section
            key={serviceKey}
            className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"
          >
            <h3 className="font-semibold text-slate-950">
              {serviceItems[0]?.serviceLabel || formatLabel(serviceKey)}
            </h3>
            <dl className="mt-3 divide-y divide-slate-200">
              {serviceItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
                >
                  <dt className="text-sm text-slate-600">
                    {item.label?.trim() || formatLabel(item.tierKey)}
                  </dt>
                  <dd className="shrink-0 text-sm font-semibold text-slate-950">
                    {money.format(item.amountCents / 100)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="mt-5 text-xs leading-5 text-slate-500">
        Rates support online scheduling. Final scope, approved changes, labor,
        materials, and disposal conditions can change a completed-job amount.
      </p>
    </>
  );
}

function InvoiceList({
  items,
  paymentAccess,
}: {
  items: PartnerInvoice[];
  paymentAccess: PaymentAccess;
}) {
  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {items.map((invoice) => (
        <li
          key={invoice.id}
          className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-slate-950">
                {invoice.invoiceNumber
                  ? `Invoice ${invoice.invoiceNumber}`
                  : "Invoice"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Issued {formatPartnerDate(invoice.issuedAt)}
              </p>
            </div>
            <PartnerStatusBadge status={invoice.status} />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-slate-500">Total</dt>
              <dd className="mt-1 font-semibold text-slate-950">
                {formatPartnerMoney(invoice.amounts.total)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Balance</dt>
              <dd className="mt-1 font-semibold text-slate-950">
                {formatPartnerMoney(invoice.amounts.balance)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Due date</dt>
              <dd className="mt-1 text-slate-800">
                {formatPartnerDate(invoice.dueDate)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">PO / cost center</dt>
              <dd className="mt-1 break-words text-slate-800">
                {[invoice.poNumber, invoice.costCenter]
                  .filter(Boolean)
                  .join(" · ") || "Not provided"}
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap items-start gap-2 border-t border-slate-200 pt-3">
            {invoice.documentId ? (
              <PartnerDocumentDownloadButton
                documentId={invoice.documentId}
                label="Download invoice"
              />
            ) : (
              <span className="text-xs leading-5 text-slate-500">
                Invoice file not generated
              </span>
            )}
            {invoice.bookingId ? (
              <Link
                href={`/partners/bookings/${invoice.bookingId}` as Route}
                className="inline-flex min-h-11 items-center text-sm font-semibold text-primary-800 underline underline-offset-4"
              >
                Open related job
              </Link>
            ) : null}
            <PartnerInvoicePaymentAction
              invoice={invoice}
              canManagePayments={paymentAccess.canManagePayments}
              initialSecurity={paymentAccess.security}
              payerEmail={paymentAccess.payerEmail}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function QuoteList({ items }: { items: PartnerQuote[] }) {
  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {items.map((quote) => (
        <li
          key={quote.id}
          className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-slate-950">
                {quote.quoteNumber ? `Quote ${quote.quoteNumber}` : "Quote"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Version {quote.version} · {quote.lineCount} line
                {quote.lineCount === 1 ? "" : "s"}
              </p>
            </div>
            <PartnerStatusBadge status={quote.status} />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-slate-500">Quoted total</dt>
              <dd className="mt-1 font-semibold text-slate-950">
                {formatPartnerMoney(quote.amounts.total)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Expires</dt>
              <dd className="mt-1 text-slate-800">
                {formatPartnerDate(quote.expiresAt)}
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap items-start gap-2 border-t border-slate-200 pt-3">
            {quote.documentId ? (
              <PartnerDocumentDownloadButton
                documentId={quote.documentId}
                label="Download quote"
              />
            ) : (
              <span className="text-xs leading-5 text-slate-500">
                Quote file not generated
              </span>
            )}
            {quote.bookingId ? (
              <Link
                href={`/partners/bookings/${quote.bookingId}` as Route}
                className="inline-flex min-h-11 items-center text-sm font-semibold text-primary-800 underline underline-offset-4"
              >
                Open related job
              </Link>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function StatementList({ items }: { items: PartnerStatement[] }) {
  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {items.map((statement) => (
        <li
          key={statement.id}
          className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4"
        >
          <p className="font-semibold text-slate-950">
            {formatPartnerDate(statement.periodStart)} –{" "}
            {formatPartnerDate(statement.periodEnd)}
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-slate-500">Invoices</dt>
              <dd className="mt-1 font-semibold text-slate-950">
                {formatPartnerMoney(statement.amounts.invoices)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Payments</dt>
              <dd className="mt-1 font-semibold text-slate-950">
                {formatPartnerMoney(statement.amounts.payments)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Opening balance</dt>
              <dd className="mt-1 text-slate-800">
                {formatPartnerMoney(statement.amounts.openingBalance)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Closing balance</dt>
              <dd className="mt-1 text-slate-800">
                {formatPartnerMoney(statement.amounts.closingBalance)}
              </dd>
            </div>
          </dl>
          <div className="mt-4 border-t border-slate-200 pt-3">
            {statement.documentId ? (
              <PartnerDocumentDownloadButton
                documentId={statement.documentId}
                label="Download statement"
              />
            ) : (
              <span className="text-xs leading-5 text-slate-500">
                Statement file not generated
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function DocumentList({ items }: { items: PartnerDocument[] }) {
  return (
    <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200">
      {items.map((document) => (
        <li
          key={document.id}
          className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-950">
              {document.filename}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {formatLabel(document.documentType)} · v{document.version} ·{" "}
              {formatBytes(document.byteSize)} ·{" "}
              {formatPartnerDate(document.generatedAt)}
            </p>
          </div>
          <PartnerDocumentDownloadButton documentId={document.id} />
        </li>
      ))}
    </ul>
  );
}

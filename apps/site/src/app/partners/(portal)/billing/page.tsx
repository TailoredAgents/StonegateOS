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
} from "@/app/partners/components/PartnerInvoicePayment";
import { PartnerInvoiceDisputeManager } from "@/app/partners/components/PartnerInvoiceDisputeManager";
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
  type PartnerServiceAgreementPresentation,
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
  canRequestBillingDisputes: boolean;
  payerEmail: string | null;
  payerName: string | null;
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
      canRequestBillingDisputes: false,
      payerEmail: null,
      payerName: null,
    };
  }
  const payload = (await response.json().catch(() => null)) as {
    ok?: unknown;
    partnerUser?: { email?: unknown; name?: unknown };
    membership?: { capabilities?: unknown; accessLevel?: unknown };
  } | null;
  const capabilities = payload?.membership?.capabilities;
  const canManagePayments =
    payload?.ok === true &&
    payload.membership?.accessLevel === "account" &&
    Array.isArray(capabilities) &&
    capabilities.includes("payments.initiate");
  if (payload?.ok !== true || !Array.isArray(capabilities)) {
    return {
      available: false,
      canManagePayments: false,
      canRequestBillingDisputes: false,
      payerEmail: null,
      payerName: null,
    };
  }
  return {
    available: true,
    canManagePayments,
    canRequestBillingDisputes: capabilities.includes(
      "invoices.disputes.request",
    ),
    payerEmail:
      typeof payload.partnerUser?.email === "string" &&
      payload.partnerUser.email.length <= 320
        ? payload.partnerUser.email
        : null,
    payerName:
      typeof payload.partnerUser?.name === "string" &&
      payload.partnerUser.name.length <= 128
        ? payload.partnerUser.name
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
      This page shows the 100 newest records. Contact Stonegate if you need
      older account history.
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
        eyebrow="Pricing, bills & records"
        title="Billing & documents"
        description="Find current rates, review quotes, pay eligible invoices, and download account records in one place. Job estimates stay separate."
        breadcrumbs={[
          { label: "Overview", href: "/partners/overview" },
          { label: "Billing & documents", href: "/partners/billing" },
        ]}
      >
        <PartnerNotice tone="info">
          {!paymentAccess.available
            ? "Protected payment controls are temporarily unavailable. Invoice records remain visible, but no payment has been started or treated as complete."
            : paymentAccess.canManagePayments
              ? "Pay eligible deposits securely by card or, when enabled, ACH through Square. ACH stays pending until Square confirms settlement. Remaining invoice balances open on Square’s hosted payment page."
              : "Billing is read-only for your role. An authorized billing user can pay eligible balances through Square, or you can contact Stonegate for help."}
        </PartnerNotice>
      </PartnerPageHeader>

      <PartnerPanel>
        <SectionHeading
          icon={<CircleDollarSign className="h-5 w-5" aria-hidden="true" />}
          eyebrow="Current account"
          title="Service agreement & rates"
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
        ) : (
          <div className="mt-5 space-y-5">
            {rates.agreement ? (
              <AgreementSummary agreement={rates.agreement} />
            ) : (
              <PartnerNotice tone="warning">
                The account agreement summary is unavailable. Contact Stonegate
                before relying on these rates or inclusions.
              </PartnerNotice>
            )}
            {rates.items.length === 0 ? (
              <PartnerEmptyState
                title="A quote may be needed for your service"
                description="No fixed online rates are available here. Review the agreement above or ask Stonegate for current pricing before requesting service."
                action={{ href: "/partners/help", label: "Ask about pricing" }}
                icon={
                  <CircleDollarSign className="h-6 w-6" aria-hidden="true" />
                }
              />
            ) : (
              <RateCard currency={rates.currency} items={rates.items} />
            )}
          </div>
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
          />
          {invoices.status !== "ready" ? (
            <CollectionFallback state={invoices} resource="invoices" />
          ) : invoices.items.length === 0 ? (
            <PartnerEmptyState
              title="No invoices available here"
              description="Invoices will appear here after Stonegate issues them and shares them with your role."
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
              title="No quotes to review"
              description="New quotes will appear here when Stonegate sends them to this account."
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
              title="No statements available here"
              description="Generated account statements will appear here by billing period."
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
              title="No account documents available here"
              description="Invoices, statements, proof files, and other shared records will appear here when they are ready."
              action={{ href: "/partners/help", label: "Ask for a document" }}
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
        A rate applies only to the contracted scope shown here. Material scope
        discrepancies require an explicit revised quote or change order before
        the new price is accepted. Schedule, service, and proof changes still
        need separate Stonegate confirmation.
      </p>
    </>
  );
}

function AgreementSummary({
  agreement,
}: {
  agreement: PartnerServiceAgreementPresentation;
}) {
  return (
    <section
      className="rounded-2xl border border-primary-200 bg-primary-50/50 p-4 sm:p-5"
      aria-labelledby="account-agreement-summary"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary-700">
            Active account terms
          </p>
          <h3
            id="account-agreement-summary"
            className="mt-1 font-semibold text-slate-950"
          >
            {agreement.label}
          </h3>
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-primary-800 shadow-sm">
          {agreement.currency}
        </span>
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Effective from</dt>
          <dd className="mt-1 font-medium text-slate-950">
            <time dateTime={agreement.effectiveFrom}>
              {formatPartnerDate(agreement.effectiveFrom)}
            </time>
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Effective until</dt>
          <dd className="mt-1 font-medium text-slate-950">
            {agreement.effectiveTo ? (
              <time dateTime={agreement.effectiveTo}>
                {formatPartnerDate(agreement.effectiveTo)}
              </time>
            ) : (
              "No scheduled end"
            )}
          </dd>
        </div>
      </dl>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <TermsList
          title="Included"
          items={agreement.inclusions}
          empty="No account-wide inclusions are listed."
        />
        <TermsList
          title="Excluded"
          items={agreement.exclusions}
          empty="No account-wide exclusions are listed."
        />
      </div>
      {agreement.services.length > 0 ? (
        <div className="mt-4">
          <h4 className="text-sm font-semibold text-slate-950">
            Entitled service rules
          </h4>
          <ul className="mt-2 grid gap-3 lg:grid-cols-2">
            {agreement.services.map((service) => (
              <li
                key={service.serviceKey}
                className="rounded-xl border border-primary-100 bg-white/80 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-950">
                    {formatLabel(service.serviceKey)}
                  </span>
                  <span className="text-xs font-medium text-slate-600">
                    {formatLabel(service.pricingState)}
                  </span>
                </div>
                {service.inclusions.length > 0 ? (
                  <p className="mt-2 text-xs leading-5 text-slate-600">
                    Included: {service.inclusions.join("; ")}
                  </p>
                ) : null}
                {service.exclusions.length > 0 ? (
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    Excluded: {service.exclusions.join("; ")}
                  </p>
                ) : null}
                {service.quoteRule ? (
                  <p className="mt-1 text-xs font-medium leading-5 text-amber-800">
                    {service.quoteRule}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {agreement.quoteRules ? (
        <PartnerNotice tone="warning" className="mt-4">
          {agreement.quoteRules}
        </PartnerNotice>
      ) : null}
      {agreement.document ? (
        <p className="mt-4 text-xs text-slate-600">
          Agreement document:{" "}
          <span className="font-semibold">{agreement.document.filename}</span>.
          Find the secure copy in Documents below.
        </p>
      ) : null}
      <p className="mt-4 text-xs leading-5 text-slate-600">
        If the requested or on-site work differs from these terms, ask Stonegate
        before proceeding. The portal will not treat a mismatched service,
        currency, estimate, or quote-required item as final contracted pricing.
      </p>
    </section>
  );
}

function TermsList({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty: string;
}) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-slate-950">{title}</h4>
      {items.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-slate-500">{empty}</p>
      )}
    </div>
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
              payerEmail={paymentAccess.payerEmail}
              payerName={paymentAccess.payerName}
            />
          </div>
          <PartnerInvoiceDisputeManager
            invoiceId={invoice.id}
            canRequest={paymentAccess.canRequestBillingDisputes}
          />
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
                Version {quote.version}
                {quote.lineCount === null
                  ? ""
                  : ` · ${quote.lineCount} line${quote.lineCount === 1 ? "" : "s"}`}
              </p>
            </div>
            <PartnerStatusBadge status={quote.status} />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-slate-500">Quoted total</dt>
              <dd className="mt-1 font-semibold text-slate-950">
                {formatQuoteTotal(quote)}
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
            <Link
              href={`/partners/billing/quotes/${quote.id}` as Route}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-primary-800 underline underline-offset-4"
            >
              {quote.actionable ? "Review and respond" : "Review quote"}
            </Link>
            {quote.documentId ? (
              <PartnerDocumentDownloadButton
                documentId={quote.documentId}
                label="Download quote"
              />
            ) : quote.authority === "legacy_snapshot" ? (
              <span className="text-xs leading-5 text-slate-500">
                Historical quote file not available
              </span>
            ) : null}
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

function formatQuoteTotal(quote: PartnerQuote): string {
  if (!quote.amounts) return "Pending finalization";
  if ("total" in quote.amounts) {
    return formatPartnerMoney(quote.amounts.total);
  }
  const minimum = formatPartnerMoney(quote.amounts.totalMin);
  const maximum = formatPartnerMoney(quote.amounts.totalMax);
  return minimum === maximum ? minimum : `${minimum}–${maximum}`;
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

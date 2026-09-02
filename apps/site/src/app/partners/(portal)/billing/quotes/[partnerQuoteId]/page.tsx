import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, FileClock, ShieldCheck } from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import { PartnerQuoteDecisionForm } from "@/app/partners/components/PartnerQuoteDecisionForm";
import {
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
  PartnerStatusBadge,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";
import {
  formatPartnerDate,
  formatPartnerMoney,
  isPartnerQuoteDetail,
} from "@/app/partners/lib/portal-commercial";
import type {
  PartnerMoney,
  PartnerQuoteDetail,
  PartnerQuoteLineItem,
} from "@/app/partners/lib/portal-v2";

export const metadata: Metadata = { title: "Quote details" };

type LoadState =
  | { status: "ready"; quote: PartnerQuoteDetail; etag: string | null }
  | { status: "forbidden" | "unavailable" | "error" };

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

async function loadQuote(partnerQuoteId: string): Promise<LoadState> {
  const response = await callPartnerApi(
    `/api/portal/v2/quotes/${encodeURIComponent(partnerQuoteId)}`,
    { timeoutMs: 20_000 },
  ).catch(() => null);
  if (!response) return { status: "unavailable" };
  if (response.status === 404) notFound();
  if (response.status === 401 || response.status === 403) {
    return { status: "forbidden" };
  }
  if ([409, 501, 503].includes(response.status)) {
    return { status: "unavailable" };
  }
  if (!response.ok) return { status: "error" };
  const payload = (await response.json().catch(() => null)) as {
    ok?: unknown;
    data?: unknown;
  } | null;
  if (payload?.ok !== true || !isPartnerQuoteDetail(payload.data)) {
    return { status: "error" };
  }
  return {
    status: "ready",
    quote: payload.data,
    etag: response.headers.get("etag") ?? payload.data.etag,
  };
}

async function loadSignerDefaults(): Promise<{
  name: string;
  company: string;
}> {
  const response = await callPartnerApi("/api/portal/v2/me", {
    timeoutMs: 12_000,
  }).catch(() => null);
  if (!response?.ok) return { name: "", company: "" };
  const payload = (await response.json().catch(() => null)) as {
    partnerUser?: { name?: unknown };
    account?: { name?: unknown };
  } | null;
  return {
    name:
      typeof payload?.partnerUser?.name === "string"
        ? payload.partnerUser.name.slice(0, 160)
        : "",
    company:
      typeof payload?.account?.name === "string"
        ? payload.account.name.slice(0, 200)
        : "",
  };
}

function quoteTotal(quote: PartnerQuoteDetail): string {
  if (!quote.amounts) return "Pending finalization";
  if ("total" in quote.amounts) return formatPartnerMoney(quote.amounts.total);
  return moneyRange(quote.amounts.totalMin, quote.amounts.totalMax);
}

function moneyRange(minimum: PartnerMoney, maximum: PartnerMoney): string {
  const min = formatPartnerMoney(minimum);
  const max = formatPartnerMoney(maximum);
  return min === max ? min : `${min}–${max}`;
}

function lineAmount(line: PartnerQuoteLineItem, currency: string): string {
  const minimum: PartnerMoney = {
    amountMinor: line.unitPriceMinCents,
    currency,
    minorUnit: 2,
  };
  const maximum: PartnerMoney = {
    amountMinor: line.unitPriceMaxCents ?? line.unitPriceMinCents,
    currency,
    minorUnit: 2,
  };
  return moneyRange(minimum, maximum);
}

function DetailFallback({ status }: { status: Exclude<LoadState["status"], "ready"> }) {
  return (
    <PartnerPanel>
      <PartnerNotice tone={status === "forbidden" ? "info" : "error"}>
        {status === "forbidden"
          ? "Your current account role or location scope does not include this quote. No commercial details were exposed."
          : "We could not verify this quote right now. Refresh before relying on its price, status, or response state."}
      </PartnerNotice>
      <Link
        href="/partners/billing"
        className={`${partnerSecondaryButtonClass} mt-4`}
      >
        Back to billing
      </Link>
    </PartnerPanel>
  );
}

export default async function PartnerQuoteDetailPage({
  params,
}: {
  params: Promise<{ partnerQuoteId: string }>;
}) {
  const { partnerQuoteId } = await params;
  if (!isUuid(partnerQuoteId)) notFound();
  const [state, signer] = await Promise.all([
    loadQuote(partnerQuoteId),
    loadSignerDefaults(),
  ]);

  if (state.status !== "ready") {
    return (
      <div className="space-y-5 sm:space-y-6">
        <PartnerPageHeader
          eyebrow="Account proposal"
          title="Quote details"
          description="Review the exact proposal and its current response state."
          breadcrumbs={[
            { label: "Overview", href: "/partners/overview" },
            { label: "Billing & documents", href: "/partners/billing" },
            { label: "Quote details", href: `/partners/billing/quotes/${partnerQuoteId}` },
          ]}
        />
        <DetailFallback status={state.status} />
      </div>
    );
  }

  const { quote } = state;
  const document = quote.document;
  const baseLines =
    document?.pricing.lineItems.filter((line) => !line.optionGroupId) ?? [];

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow="Account proposal"
        title={quote.quoteNumber ? `Quote ${quote.quoteNumber}` : "Quote details"}
        description="Review scope, pricing, terms, proposal evidence, and the current response state in one place."
        breadcrumbs={[
          { label: "Overview", href: "/partners/overview" },
          { label: "Billing & documents", href: "/partners/billing" },
          { label: quote.quoteNumber ?? "Quote", href: `/partners/billing/quotes/${quote.id}` },
        ]}
      >
        <div className="flex flex-wrap items-center gap-3">
          <PartnerStatusBadge status={quote.status} />
          <span className="text-sm text-slate-600">Version {quote.version}</span>
        </div>
      </PartnerPageHeader>

      {quote.notice ? (
        <PartnerNotice
          tone={quote.authority === "legacy_snapshot" ? "warning" : "info"}
        >
          {quote.notice}
        </PartnerNotice>
      ) : null}

      <PartnerPanel>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
              Current version
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">
              {quote.projectName || document?.parties.projectName || "Service proposal"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {document?.parties.serviceAddress || "Service location not included in this historical record."}
            </p>
          </div>
          {quote.proposalDocument ? (
            <a
              href={`/api/partners/portal/quotes/${encodeURIComponent(quote.id)}/document`}
              className={partnerSecondaryButtonClass}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download proposal PDF
            </a>
          ) : null}
        </div>
        <dl className="mt-5 grid gap-4 border-t border-slate-200 pt-5 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Total
            </dt>
            <dd className="mt-1 text-lg font-semibold text-slate-950">
              {quoteTotal(quote)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Issued
            </dt>
            <dd className="mt-1 text-sm text-slate-800">
              {formatPartnerDate(quote.issuedAt)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Expires
            </dt>
            <dd className="mt-1 text-sm text-slate-800">
              {formatPartnerDate(quote.expiresAt)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Reference
            </dt>
            <dd className="mt-1 break-words text-sm text-slate-800">
              {[document?.parties.purchaseOrder, document?.parties.reference]
                .filter(Boolean)
                .join(" · ") || "Not provided"}
            </dd>
          </div>
        </dl>
      </PartnerPanel>

      {document ? (
        <>
          <PartnerPanel>
            <h2 className="text-lg font-semibold text-slate-950">Scope of work</h2>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
              {document.scope}
            </p>
            <div className="mt-5 grid gap-5 lg:grid-cols-3">
              <ProposalList title="Included" items={document.inclusions} />
              <ProposalList title="Excluded" items={document.exclusions} />
              <ProposalList title="Assumptions" items={document.assumptions} />
            </div>
          </PartnerPanel>

          <PartnerPanel>
            <div className="flex items-center gap-3">
              <FileClock className="h-5 w-5 text-primary-700" aria-hidden="true" />
              <div>
                <h2 className="text-lg font-semibold text-slate-950">
                  Pricing and selections
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Unit prices are shown before quantity and captured adjustments.
                </p>
              </div>
            </div>
            <LineList lines={baseLines} currency={document.pricing.currency} />
            {document.pricing.optionGroups.map((group) => (
              <section
                key={group.id}
                className="mt-5 rounded-xl border border-slate-200 bg-slate-50/70 p-4"
                aria-labelledby={`quote-option-group-${group.id}`}
              >
                <h3
                  id={`quote-option-group-${group.id}`}
                  className="font-semibold text-slate-950"
                >
                  {group.label}
                </h3>
                <p className="mt-1 text-xs text-slate-600">
                  Choose {group.minimumSelections}
                  {group.maximumSelections !== group.minimumSelections
                    ? `–${group.maximumSelections}`
                    : ""} option{group.maximumSelections === 1 ? "" : "s"} when accepting.
                </p>
                <LineList
                  lines={document.pricing.lineItems.filter(
                    (line) => line.optionGroupId === group.id,
                  )}
                  currency={document.pricing.currency}
                  compact
                />
              </section>
            ))}
          </PartnerPanel>

          <PartnerPanel>
            <h2 className="text-lg font-semibold text-slate-950">
              Terms and payment
            </h2>
            <div className="mt-4 grid gap-5 lg:grid-cols-3">
              <TermBlock title="Proposal terms" body={document.terms.terms} />
              <TermBlock title="Payment terms" body={document.terms.paymentTerms} />
              <TermBlock
                title="Change-order rules"
                body={document.terms.changeOrderRules}
              />
            </div>
          </PartnerPanel>
        </>
      ) : quote.legacyTerms ? (
        <PartnerPanel>
          <h2 className="text-lg font-semibold text-slate-950">
            Historical terms
          </h2>
          <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
            {quote.legacyTerms}
          </p>
        </PartnerPanel>
      ) : (
        <PartnerNotice tone="warning">
          The proposal document could not be verified. Do not rely on this
          quote for scope or terms; contact Stonegate for a reconciled copy.
        </PartnerNotice>
      )}

      {quote.response ? (
        <PartnerPanel>
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-950">
                Response recorded
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                This version was {quote.response.decision} on {formatPartnerDate(quote.response.respondedAt)}. The response is immutable.
              </p>
            </div>
          </div>
        </PartnerPanel>
      ) : null}

      {document ? (
        <PartnerQuoteDecisionForm
          quoteId={quote.id}
          initialEtag={state.etag}
          allowedActions={quote.allowedActions}
          signerName={signer.name}
          signerCompany={signer.company}
          consentVersion={document.terms.consentVersion}
          optionGroups={document.pricing.optionGroups}
          lineItems={document.pricing.lineItems}
        />
      ) : null}

      <PartnerPanel>
        <h2 className="text-lg font-semibold text-slate-950">Version history</h2>
        {quote.history.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">
            Version history is not available for this historical snapshot.
          </p>
        ) : (
          <ol className="mt-4 divide-y divide-slate-200 rounded-xl border border-slate-200">
            {quote.history.map((version) => (
              <li
                key={version.id}
                className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-semibold text-slate-950">
                    Version {version.version}{version.current ? " · Current" : ""}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Issued {formatPartnerDate(version.issuedAt)} · Expires {formatPartnerDate(version.expiresAt)}
                  </p>
                </div>
                <PartnerStatusBadge status={version.state} />
              </li>
            ))}
          </ol>
        )}
        <Link
          href="/partners/billing"
          className={`${partnerSecondaryButtonClass} mt-5`}
        >
          Back to billing & documents
        </Link>
      </PartnerPanel>
    </div>
  );
}

function ProposalList({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h3 className="font-semibold text-slate-950">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">None listed.</p>
      ) : (
        <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-700">
          {items.map((item, index) => (
            <li key={`${title}-${index}`} className="break-words">
              {item}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LineList({
  lines,
  currency,
  compact = false,
}: {
  lines: PartnerQuoteLineItem[];
  currency: string;
  compact?: boolean;
}) {
  if (lines.length === 0) {
    return compact ? (
      <p className="mt-3 text-sm text-slate-500">No selectable lines.</p>
    ) : null;
  }
  return (
    <ul className={`${compact ? "mt-3" : "mt-5"} divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white`}>
      {lines.map((line) => (
        <li
          key={line.id}
          className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="min-w-0">
            <p className="break-words font-semibold text-slate-950">{line.name}</p>
            {line.description ? (
              <p className="mt-1 break-words text-xs leading-5 text-slate-600">
                {line.description}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-slate-500">
              {line.quantity} {line.unit}
            </p>
          </div>
          <p className="shrink-0 text-sm font-semibold text-slate-950">
            {lineAmount(line, currency)} / {line.unit}
          </p>
        </li>
      ))}
    </ul>
  );
}

function TermBlock({ title, body }: { title: string; body: string }) {
  return (
    <section>
      <h3 className="font-semibold text-slate-950">{title}</h3>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
        {body}
      </p>
    </section>
  );
}

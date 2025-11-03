import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";

type QuoteStatus = "pending" | "sent" | "accepted" | "declined";

interface LineItem {
  id: string;
  label: string;
  amount: number;
  category?: string | null;
}

interface PublicQuoteResponse {
  quote: {
    id: string;
    status: QuoteStatus;
    services: string[];
    addOns: string[] | null;
    lineItems: LineItem[];
    subtotal: number;
    total: number;
    depositDue: number;
    balanceDue: number;
    sentAt: string | null;
    expiresAt: string | null;
    expired: boolean;
    decisionNotes: string | null;
    customerName: string;
    serviceArea: string;
  };
}

async function fetchQuote(token: string): Promise<PublicQuoteResponse["quote"] | null> {
  const response = await fetch(`${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as unknown;
  if (
    !data ||
    typeof data !== "object" ||
    !("quote" in data) ||
    typeof (data as { quote: unknown }).quote !== "object"
  ) {
    return null;
  }

  return (data as PublicQuoteResponse).quote;
}

function formatCurrency(value: number) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

function formatDate(iso: string | null) {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function statusLabel(status: QuoteStatus) {
  switch (status) {
    case "pending":
      return "Draft";
    case "sent":
      return "Awaiting response";
    case "accepted":
      return "Accepted";
    case "declined":
      return "Declined";
    default:
      return status;
  }
}

function statusTone(status: QuoteStatus) {
  switch (status) {
    case "sent":
      return "bg-amber-100 text-amber-700 border-amber-200";
    case "accepted":
      return "bg-emerald-100 text-emerald-700 border-emerald-200";
    case "declined":
      return "bg-rose-100 text-rose-700 border-rose-200";
    default:
      return "bg-neutral-200 text-neutral-700 border-neutral-300";
  }
}

export async function acceptQuoteAction(formData: FormData) {
  "use server";

  const token = formData.get("token");
  if (typeof token !== "string" || token.trim().length === 0) {
    return;
  }

  await fetch(`${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "accepted" })
  });

  revalidatePath(`/quote/${token}`);
  redirect(`/quote/${token}`);
}

export async function declineQuoteAction(formData: FormData) {
  "use server";

  const token = formData.get("token");
  if (typeof token !== "string" || token.trim().length === 0) {
    return;
  }

  await fetch(`${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "declined" })
  });

  revalidatePath(`/quote/${token}`);
  redirect(`/quote/${token}`);
}

export default async function PublicQuotePage({
  params
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!token) {
    notFound();
  }

  const quote = await fetchQuote(token);
  if (!quote) {
    notFound();
  }

  const showDecisionForm = quote.status === "sent" && !quote.expired;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
          Stonegate Junk Removal
        </p>
        <h1 className="text-3xl font-semibold text-primary-900">Your junk removal quote</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-500">
          <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusTone(quote.status)}`}>
            {statusLabel(quote.status)}
          </span>
          <span>Prepared for {quote.customerName}</span>
          <span>•</span>
          <span>{quote.serviceArea}</span>
        </div>
      </header>

      <section className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-primary-900">Summary</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">
              Total investment
            </dt>
            <dd className="text-2xl font-semibold text-primary-900">{formatCurrency(quote.total)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">
              Deposit due
            </dt>
            <dd className="text-lg font-medium text-neutral-700">{formatCurrency(quote.depositDue)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">
              Remaining balance
            </dt>
            <dd className="text-lg font-medium text-neutral-700">{formatCurrency(quote.balanceDue)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">
              Sent
            </dt>
            <dd className="text-sm text-neutral-600">{formatDate(quote.sentAt)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">
              Expires
            </dt>
            <dd className={`text-sm ${quote.expired ? "text-rose-600" : "text-neutral-600"}`}>
              {quote.expiresAt ? formatDate(quote.expiresAt) : "—"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-primary-900">Line items</h2>
        <div className="mt-4 overflow-hidden rounded-lg border border-neutral-200">
          <table className="min-w-full divide-y divide-neutral-200">
            <tbody className="divide-y divide-neutral-200 text-sm text-neutral-700">
              {quote.lineItems.map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-primary-900">{item.label}</div>
                    {item.category ? (
                      <div className="text-xs uppercase tracking-[0.12em] text-neutral-500">{item.category}</div>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-medium">
                    {formatCurrency(item.amount)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="px-4 py-3 text-sm font-semibold text-primary-900">Subtotal</td>
                <td className="px-4 py-3 text-right text-sm font-semibold text-primary-900">
                  {formatCurrency(quote.subtotal)}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-base font-semibold text-primary-900">Total</td>
                <td className="px-4 py-3 text-right text-base font-semibold text-primary-900">
                  {formatCurrency(quote.total)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {quote.decisionNotes ? (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-4 text-sm text-emerald-700">
          {quote.decisionNotes}
        </section>
      ) : null}

      {quote.expired ? (
        <section className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-700">
          This quote has expired. Contact Stonegate Junk Removal to request an updated proposal.
        </section>
      ) : null}

      {showDecisionForm ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-primary-900">Ready to move forward?</h2>
          <p className="mt-2 text-sm text-neutral-600">
            Accepting locks in this pricing and reserves the next available service window. Declining lets us know you&apos;d rather pass.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <form action={acceptQuoteAction}>
              <input type="hidden" name="token" value={token} />
              <button className="rounded-md border border-emerald-400 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-100">
                Accept quote
              </button>
            </form>
            <form action={declineQuoteAction}>
              <input type="hidden" name="token" value={token} />
              <button className="rounded-md border border-rose-300 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-600 hover:bg-rose-100">
                Decline quote
              </button>
            </form>
          </div>
        </section>
      ) : null}

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-500">
        <span>Stonegate Junk Removal • Licensed & insured • Make-It-Right Guarantee</span>
        <Link href="/" className="text-accent-600 hover:underline">
          Back to homepage
        </Link>
      </footer>
    </main>
  );
}



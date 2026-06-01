import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

export const metadata = {
  title: "Quote",
  robots: { index: false, follow: false }
};

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
    displayStatus: string;
    quoteNumber: string;
    services: string[];
    addOns: string[] | null;
    lineItems: LineItem[];
    subtotal: number;
    total: number;
    depositDue: number;
    balanceDue: number;
    jobDurationMinutes: number;
    clientScope: string | null;
    sentAt: string | null;
    expiresAt: string | null;
    expired: boolean;
    decisionNotes: string | null;
    refreshRequestedAt: string | null;
    acceptedAppointmentId: string | null;
    customerName: string;
    addressLine1: string;
    serviceArea: string;
  };
}

interface QuoteSlot {
  startAt: string;
  endAt: string;
  label: string;
}

interface AvailabilityResponse {
  ok?: boolean;
  booked?: boolean;
  appointmentId?: string;
  suggestions?: QuoteSlot[];
  days?: Array<{ date: string; slots: QuoteSlot[] }>;
  durationMinutes?: number;
  timezone?: string;
}

async function fetchQuote(token: string, preview: boolean): Promise<PublicQuoteResponse["quote"] | null> {
  const url = new URL(`${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}`);
  if (preview) url.searchParams.set("preview", "1");
  const response = await fetch(url.toString(), { cache: "no-store" });

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

async function fetchAvailability(token: string): Promise<AvailabilityResponse | null> {
  const response = await fetch(`${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}/availability`, {
    cache: "no-store"
  });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as AvailabilityResponse | null;
}

function formatCurrency(value: number) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

function formatDate(iso: string | null) {
  if (!iso) return "-";
  const date = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatDay(isoDate: string) {
  const date = new Date(`${isoDate}T12:00:00`);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(date);
}

function statusLabel(status: string) {
  switch (status) {
    case "draft":
      return "Draft";
    case "sent":
      return "Awaiting response";
    case "viewed":
      return "Viewed";
    case "accepted":
      return "Accepted";
    case "booked":
      return "Booked";
    case "rejected":
      return "Rejected";
    case "expired":
      return "Expired";
    case "refresh_requested":
      return "Refresh requested";
    default:
      return status;
  }
}

function statusTone(status: string) {
  switch (status) {
    case "sent":
    case "viewed":
      return "bg-amber-100 text-amber-700 border-amber-200";
    case "accepted":
    case "booked":
      return "bg-emerald-100 text-emerald-700 border-emerald-200";
    case "declined":
    case "rejected":
    case "expired":
      return "bg-rose-100 text-rose-700 border-rose-200";
    default:
      return "bg-neutral-200 text-neutral-700 border-neutral-300";
  }
}

function paymentTerms(quote: PublicQuoteResponse["quote"]): string {
  if (quote.depositDue > 0) {
    return `${formatCurrency(quote.depositDue)} deposit is due per quote terms. Remaining balance is ${formatCurrency(quote.balanceDue)}.`;
  }
  return "No deposit is required. Payment is due after service.";
}

export async function acceptQuoteAction(formData: FormData) {
  "use server";

  const token = formData.get("token");
  if (typeof token !== "string" || token.trim().length === 0) return;

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
  const reason = formData.get("reason");
  const notes = formData.get("notes");
  if (typeof token !== "string" || token.trim().length === 0) return;

  await fetch(`${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      decision: "declined",
      reason: typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : undefined,
      notes: typeof notes === "string" && notes.trim().length > 0 ? notes.trim() : undefined
    })
  });

  revalidatePath(`/quote/${token}`);
  redirect(`/quote/${token}`);
}

export async function refreshQuoteAction(formData: FormData) {
  "use server";

  const token = formData.get("token");
  if (typeof token !== "string" || token.trim().length === 0) return;

  await fetch(`${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "refresh" })
  });

  revalidatePath(`/quote/${token}`);
  redirect(`/quote/${token}`);
}

export async function bookQuoteAction(formData: FormData) {
  "use server";

  const token = formData.get("token");
  const startAt = formData.get("startAt");
  if (
    typeof token !== "string" ||
    token.trim().length === 0 ||
    typeof startAt !== "string" ||
    startAt.trim().length === 0
  ) {
    return;
  }

  const holdResponse = await fetch(`${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}/hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startAt })
  });
  const hold = (await holdResponse.json().catch(() => null)) as { holdId?: string } | null;
  if (!holdResponse.ok || !hold?.holdId) {
    redirect(`/quote/${token}?booking=failed`);
  }

  const bookResponse = await fetch(`${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}/book`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startAt, holdId: hold.holdId })
  });
  if (!bookResponse.ok) {
    redirect(`/quote/${token}?booking=failed`);
  }

  revalidatePath(`/quote/${token}`);
  redirect(`/quote/${token}?booking=confirmed`);
}

export default async function PublicQuotePage({
  params,
  searchParams
}: {
  params: Promise<{ token: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = searchParams ? await searchParams : {};
  if (!token) notFound();

  const preview = query["preview"] === "1";
  const bookingFlag = typeof query["booking"] === "string" ? query["booking"] : null;
  const quote = await fetchQuote(token, preview);
  if (!quote) notFound();

  const availability =
    quote.status === "accepted" && !quote.acceptedAppointmentId && !quote.expired
      ? await fetchAvailability(token)
      : null;
  const showDecisionForm = quote.status === "sent" && !quote.expired;
  const showRefreshForm = quote.expired || quote.displayStatus === "refresh_requested";

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
          Stonegate Junk Removal | Licensed & insured | Make-It-Right Guarantee
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold text-primary-900">Your junk removal quote</h1>
            <p className="mt-1 text-sm text-neutral-500">Quote {quote.quoteNumber} prepared for {quote.customerName}</p>
          </div>
          <span className={`w-fit rounded-full border px-3 py-1 text-xs font-semibold ${statusTone(quote.displayStatus)}`}>
            {statusLabel(quote.displayStatus)}
          </span>
        </div>
        <p className="text-sm text-neutral-600">
          {[quote.addressLine1, quote.serviceArea].filter(Boolean).join(", ")}
        </p>
      </header>

      {bookingFlag === "confirmed" ? (
        <section className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-800">
          Your service window is booked. Stonegate will send a confirmation and follow up if anything needs clarification.
        </section>
      ) : null}
      {bookingFlag === "failed" ? (
        <section className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-700">
          That time was no longer available. Please pick another service window.
        </section>
      ) : null}

      <section className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-primary-900">Summary</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">Total investment</dt>
            <dd className="text-2xl font-semibold text-primary-900">{formatCurrency(quote.total)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">Deposit terms</dt>
            <dd className="text-sm font-medium text-neutral-700">{quote.depositDue > 0 ? formatCurrency(quote.depositDue) : "No deposit"}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">Estimated duration</dt>
            <dd className="text-sm font-medium text-neutral-700">{Math.round(quote.jobDurationMinutes / 60 * 10) / 10} hr</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">Sent</dt>
            <dd className="text-sm text-neutral-600">{formatDate(quote.sentAt)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">Valid until</dt>
            <dd className={`text-sm ${quote.expired ? "text-rose-600" : "text-neutral-600"}`}>
              {formatDate(quote.expiresAt)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">Payment</dt>
            <dd className="text-sm text-neutral-600">{paymentTerms(quote)}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-5 text-sm text-emerald-900">
        <h2 className="text-base font-semibold">Scope of work</h2>
        <p className="mt-3 whitespace-pre-wrap leading-6">
          {quote.clientScope?.trim() ||
            "Loading, haul-away, disposal, and cleanup of the quoted junk removal items. Final price can change if volume, weight, access, or materials differ on site."}
        </p>
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
                    {item.category ? <div className="text-xs uppercase tracking-[0.12em] text-neutral-500">{item.category}</div> : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-medium">{formatCurrency(item.amount)}</td>
                </tr>
              ))}
              <tr>
                <td className="px-4 py-3 text-sm font-semibold text-primary-900">Subtotal</td>
                <td className="px-4 py-3 text-right text-sm font-semibold text-primary-900">{formatCurrency(quote.subtotal)}</td>
              </tr>
              <tr>
                <td className="px-4 py-3 text-base font-semibold text-primary-900">Total</td>
                <td className="px-4 py-3 text-right text-base font-semibold text-primary-900">{formatCurrency(quote.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {quote.decisionNotes ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-700">
          <span className="font-semibold">Response note:</span> {quote.decisionNotes}
        </section>
      ) : null}

      {showRefreshForm ? (
        <section className="rounded-lg border border-rose-300 bg-rose-50 p-5 text-sm text-rose-700">
          {quote.refreshRequestedAt ? (
            <p>Refresh requested. Stonegate will follow up with updated pricing or availability.</p>
          ) : (
            <form action={refreshQuoteAction} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p>This quote has expired. Request a refreshed quote and Stonegate will follow up.</p>
              <input type="hidden" name="token" value={token} />
              <button className="rounded-md border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-700">
                Request refresh
              </button>
            </form>
          )}
        </section>
      ) : null}

      {showDecisionForm ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-primary-900">Accept and pick a time</h2>
          <p className="mt-2 text-sm text-neutral-600">
            Accepting confirms you want to book this quoted scope. After accepting, you can choose from the next available service windows.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <form action={acceptQuoteAction}>
              <input type="hidden" name="token" value={token} />
              <button className="w-full rounded-md border border-emerald-400 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-100">
                Accept quote
              </button>
            </form>
            <details className="rounded-md border border-rose-200 bg-rose-50 p-3">
              <summary className="cursor-pointer text-sm font-semibold text-rose-700">Decline quote</summary>
              <form action={declineQuoteAction} className="mt-3 space-y-3">
                <input type="hidden" name="token" value={token} />
                <label className="block text-xs font-semibold text-rose-800">
                  Reason
                  <select name="reason" className="mt-1 w-full rounded-md border border-rose-200 bg-white px-3 py-2 text-sm text-neutral-800">
                    <option value="">Prefer not to say</option>
                    <option value="Price">Price</option>
                    <option value="Timing">Timing</option>
                    <option value="Scope changed">Scope changed</option>
                    <option value="Chose another provider">Chose another provider</option>
                  </select>
                </label>
                <label className="block text-xs font-semibold text-rose-800">
                  Optional note
                  <textarea name="notes" rows={3} className="mt-1 w-full rounded-md border border-rose-200 bg-white px-3 py-2 text-sm text-neutral-800" />
                </label>
                <button className="w-full rounded-md border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-700">
                  Send rejection
                </button>
              </form>
            </details>
          </div>
        </section>
      ) : null}

      {quote.status === "accepted" && !quote.acceptedAppointmentId && !quote.expired ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-primary-900">Choose your service window</h2>
          <p className="mt-2 text-sm text-neutral-600">These openings are held briefly while booking. If a time fails, choose another one.</p>
          <div className="mt-4 space-y-4">
            {(availability?.days ?? []).some((day) => day.slots.length > 0) ? (
              availability?.days?.map((day) =>
                day.slots.length ? (
                  <div key={day.date}>
                    <h3 className="text-sm font-semibold text-neutral-700">{formatDay(day.date)}</h3>
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      {day.slots.slice(0, 6).map((slot) => (
                        <form key={slot.startAt} action={bookQuoteAction}>
                          <input type="hidden" name="token" value={token} />
                          <input type="hidden" name="startAt" value={slot.startAt} />
                          <button className="w-full rounded-md border border-accent-300 bg-accent-50 px-3 py-2 text-sm font-semibold text-accent-700">
                            {slot.label}
                          </button>
                        </form>
                      ))}
                    </div>
                  </div>
                ) : null
              )
            ) : (
              <p className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600">
                No online windows are available right now. Stonegate will follow up to schedule manually.
              </p>
            )}
          </div>
        </section>
      ) : null}

      {quote.acceptedAppointmentId ? (
        <section className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-800">
          This quote is booked. Stonegate will see it on the calendar and follow up as needed.
        </section>
      ) : null}

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-500">
        <span>Stonegate Junk Removal | Licensed & insured | Make-It-Right Guarantee</span>
        <Link href="/" className="text-accent-600 hover:underline">
          Back to homepage
        </Link>
      </footer>
    </main>
  );
}

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getPublicCompanyProfile } from "@/lib/company";

export const metadata = {
  title: "Quote",
  robots: { index: false, follow: false },
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

async function fetchQuote(
  token: string,
  preview: boolean,
): Promise<PublicQuoteResponse["quote"] | null> {
  const url = new URL(
    `${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}`,
  );
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

async function fetchAvailability(
  token: string,
): Promise<AvailabilityResponse | null> {
  const response = await fetch(
    `${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}/availability`,
    {
      cache: "no-store",
    },
  );
  if (!response.ok) return null;
  return (await response
    .json()
    .catch(() => null)) as AvailabilityResponse | null;
}

function formatCurrency(value: number) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

function formatDate(iso: string | null) {
  if (!iso) return "-";
  const date = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatDay(isoDate: string) {
  const date = new Date(`${isoDate}T12:00:00`);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
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
  const notes = formData.get("customerNote");
  if (typeof token !== "string" || token.trim().length === 0) return;

  await fetch(`${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      decision: "accepted",
      notes:
        typeof notes === "string" && notes.trim().length > 0
          ? notes.trim()
          : undefined,
    }),
  });

  revalidatePath(`/quote/${token}`);
  redirect(`/quote/${token}?approval=received`);
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
      reason:
        typeof reason === "string" && reason.trim().length > 0
          ? reason.trim()
          : undefined,
      notes:
        typeof notes === "string" && notes.trim().length > 0
          ? notes.trim()
          : undefined,
    }),
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
    body: JSON.stringify({ action: "refresh" }),
  });

  revalidatePath(`/quote/${token}`);
  redirect(`/quote/${token}`);
}

export async function requestQuoteChangesAction(formData: FormData) {
  "use server";

  const token = formData.get("token");
  const reason = formData.get("reason");
  const message = formData.get("message");
  if (typeof token !== "string" || token.trim().length === 0) return;

  await fetch(
    `${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}/changes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason:
          typeof reason === "string" && reason.trim().length > 0
            ? reason.trim()
            : "Other",
        message:
          typeof message === "string" && message.trim().length > 0
            ? message.trim()
            : undefined,
      }),
    },
  );

  revalidatePath(`/quote/${token}`);
  redirect(`/quote/${token}?changes=sent`);
}

export async function bookQuoteAction(formData: FormData) {
  "use server";

  const token = formData.get("token");
  const startAt = formData.get("startAt");
  const customerNote = formData.get("customerNote");
  if (
    typeof token !== "string" ||
    token.trim().length === 0 ||
    typeof startAt !== "string" ||
    startAt.trim().length === 0
  ) {
    return;
  }

  const holdResponse = await fetch(
    `${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}/hold`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startAt }),
    },
  );
  const hold = (await holdResponse.json().catch(() => null)) as {
    holdId?: string;
  } | null;
  if (!holdResponse.ok || !hold?.holdId) {
    redirect(`/quote/${token}?booking=failed`);
  }

  const bookResponse = await fetch(
    `${API_BASE_URL.replace(/\/$/, "")}/api/public/quotes/${token}/book`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startAt,
        holdId: hold.holdId,
        customerNote:
          typeof customerNote === "string" && customerNote.trim().length > 0
            ? customerNote.trim()
            : undefined,
      }),
    },
  );
  if (!bookResponse.ok) {
    redirect(`/quote/${token}?booking=failed`);
  }

  revalidatePath(`/quote/${token}`);
  redirect(`/quote/${token}?booking=confirmed`);
}

export default async function PublicQuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = searchParams ? await searchParams : {};
  if (!token) notFound();

  const preview = query["preview"] === "1";
  const bookingFlag =
    typeof query["booking"] === "string" ? query["booking"] : null;
  const approvalFlag =
    typeof query["approval"] === "string" ? query["approval"] : null;
  const changesFlag =
    typeof query["changes"] === "string" ? query["changes"] : null;
  const quote = await fetchQuote(token, preview);
  if (!quote) notFound();

  const availability =
    (quote.status === "sent" || quote.status === "accepted") &&
    !quote.acceptedAppointmentId &&
    !quote.expired
      ? await fetchAvailability(token)
      : null;
  const showApproveAndBook =
    (quote.status === "sent" || quote.status === "accepted") &&
    !quote.acceptedAppointmentId &&
    !quote.expired;
  const showRefreshForm =
    quote.expired || quote.displayStatus === "refresh_requested";
  const company = getPublicCompanyProfile();
  const hasAvailableSlots = (availability?.days ?? []).some(
    (day) => day.slots.length > 0,
  );
  const smsHref = `sms:${company.phoneE164}`;
  const mailHref = `mailto:${company.email}?subject=${encodeURIComponent(`Question about quote ${quote.quoteNumber}`)}`;

  return (
    <main className="min-h-screen bg-[#f6f4ef] text-neutral-950">
      <section className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
          <header className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary-700">
                {company.name} | Licensed and insured | Make-It-Right Guarantee
              </p>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-primary-950 sm:text-5xl">
                Your junk removal proposal
              </h1>
              <p className="mt-3 text-base leading-7 text-neutral-600">
                Quote {quote.quoteNumber} prepared for {quote.customerName}.
                Review the scope, approve the quote, and book your service
                window in one step.
              </p>
            </div>
            <div className="flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm shadow-sm lg:min-w-72">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
                  Status
                </span>
                <span
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusTone(quote.displayStatus)}`}
                >
                  {statusLabel(quote.displayStatus)}
                </span>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
                  Valid until
                </div>
                <div
                  className={`mt-1 text-lg font-semibold ${quote.expired ? "text-rose-700" : "text-primary-950"}`}
                >
                  {formatDate(quote.expiresAt)}
                </div>
              </div>
              <a
                href={`/quote/${token}/pdf`}
                className="inline-flex items-center justify-center rounded-lg border border-primary-200 bg-white px-4 py-2 text-sm font-semibold text-primary-800 transition hover:border-primary-300 hover:bg-primary-50"
              >
                Download PDF
              </a>
            </div>
          </header>

          <div className="grid gap-4 md:grid-cols-3">
            <a
              href={`tel:${company.phoneE164}`}
              className="rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-semibold text-primary-800 shadow-sm hover:border-primary-300"
            >
              Call {company.phoneDisplay}
            </a>
            <a
              href={smsHref}
              className="rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-semibold text-primary-800 shadow-sm hover:border-primary-300"
            >
              Text {company.phoneDisplay}
            </a>
            <a
              href={mailHref}
              className="rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-semibold text-primary-800 shadow-sm hover:border-primary-300"
            >
              Email {company.email}
            </a>
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-8">
        <div className="space-y-6">
          {bookingFlag === "confirmed" ? (
            <section className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">
              Your service window is booked. Stonegate will send a confirmation
              and follow up if anything needs clarification.
            </section>
          ) : null}
          {bookingFlag === "failed" ? (
            <section className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-sm font-medium text-rose-800">
              That time was no longer available. Please pick another service
              window.
            </section>
          ) : null}
          {approvalFlag === "received" ? (
            <section className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">
              Quote approved. Stonegate will follow up to schedule the job.
            </section>
          ) : null}
          {changesFlag === "sent" ? (
            <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm font-medium text-amber-900">
              Change request received. Your quote is still available to approve
              while Stonegate reviews your request.
            </section>
          ) : null}

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
                  Proposal total
                </p>
                <div className="mt-2 text-5xl font-semibold tracking-tight text-primary-950">
                  {formatCurrency(quote.total)}
                </div>
                <p className="mt-2 text-sm text-neutral-600">
                  {paymentTerms(quote)}
                </p>
              </div>
              <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700 sm:min-w-64">
                <div className="font-semibold text-primary-950">
                  Service property
                </div>
                <div className="mt-2">
                  {[quote.addressLine1, quote.serviceArea]
                    .filter(Boolean)
                    .join(", ")}
                </div>
                <div className="mt-4 font-semibold text-primary-950">
                  Estimated duration
                </div>
                <div className="mt-1">
                  {Math.round((quote.jobDurationMinutes / 60) * 10) / 10} hr
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
                  Scope
                </p>
                <h2 className="mt-1 text-2xl font-semibold text-primary-950">
                  What this quote includes
                </h2>
              </div>
            </div>
            <p className="mt-5 whitespace-pre-wrap text-base leading-8 text-neutral-700">
              {quote.clientScope?.trim() ||
                "Loading, haul-away, disposal, and completion of the quoted junk removal scope. Final price can change if volume, weight, access, or materials differ on site."}
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
                <div className="font-semibold">Transparent pricing</div>
                <p className="mt-1 text-emerald-900">
                  Line items and total are visible before you approve.
                </p>
              </div>
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
                <div className="font-semibold">Disposal included</div>
                <p className="mt-1 text-emerald-900">
                  The quoted service includes haul-away and disposal for the
                  listed scope.
                </p>
              </div>
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
                <div className="font-semibold">Make-It-Right Guarantee</div>
                <p className="mt-1 text-emerald-900">
                  If something is not right, Stonegate will work to make it
                  right.
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
              Pricing
            </p>
            <h2 className="mt-1 text-2xl font-semibold text-primary-950">
              Line-item quote
            </h2>
            <div className="mt-5 overflow-hidden rounded-2xl border border-neutral-200">
              <table className="min-w-full divide-y divide-neutral-200">
                <tbody className="divide-y divide-neutral-200 text-sm text-neutral-700">
                  {quote.lineItems.map((item) => (
                    <tr key={item.id}>
                      <td className="px-4 py-4">
                        <div className="font-semibold text-primary-950">
                          {item.label}
                        </div>
                        {item.category ? (
                          <div className="text-xs uppercase tracking-[0.12em] text-neutral-500">
                            {item.category}
                          </div>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-4 text-right font-semibold">
                        {formatCurrency(item.amount)}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-neutral-50">
                    <td className="px-4 py-4 font-semibold text-primary-950">
                      Subtotal
                    </td>
                    <td className="px-4 py-4 text-right font-semibold text-primary-950">
                      {formatCurrency(quote.subtotal)}
                    </td>
                  </tr>
                  <tr className="bg-primary-950 text-white">
                    <td className="px-4 py-4 text-base font-semibold">Total</td>
                    <td className="px-4 py-4 text-right text-base font-semibold">
                      {formatCurrency(quote.total)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
              Next steps
            </p>
            <h2 className="mt-1 text-2xl font-semibold text-primary-950">
              What happens after approval
            </h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-4">
              {[
                "Approve quote",
                "Pick a time",
                "Crew confirms",
                "Service completed",
              ].map((step, index) => (
                <div
                  key={step}
                  className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-950 text-sm font-semibold text-white">
                    {index + 1}
                  </div>
                  <div className="mt-3 font-semibold text-primary-950">
                    {step}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8">
            <details>
              <summary className="cursor-pointer list-none text-lg font-semibold text-primary-950">
                Request changes to this quote
              </summary>
              <p className="mt-2 text-sm text-neutral-600">
                Send a structured request to Stonegate. The quote stays
                available to approve while the team reviews it.
              </p>
              <form
                action={requestQuoteChangesAction}
                className="mt-5 space-y-4"
              >
                <input type="hidden" name="token" value={token} />
                <label className="block text-sm font-semibold text-neutral-700">
                  What needs to change?
                  <select
                    name="reason"
                    className="mt-2 w-full rounded-xl border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900"
                  >
                    <option value="Scope changed">Scope changed</option>
                    <option value="Price question">Price question</option>
                    <option value="Timing issue">Timing issue</option>
                    <option value="Address issue">Address issue</option>
                    <option value="Need to add/remove items">
                      Need to add/remove items
                    </option>
                    <option value="Other">Other</option>
                  </select>
                </label>
                <label className="block text-sm font-semibold text-neutral-700">
                  Details
                  <textarea
                    name="message"
                    rows={4}
                    className="mt-2 w-full rounded-xl border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900"
                    placeholder="Tell us what should change."
                  />
                </label>
                <button className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900 hover:bg-amber-100">
                  Send change request
                </button>
              </form>
            </details>
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 text-sm text-neutral-700 shadow-sm sm:p-8">
            <h2 className="text-lg font-semibold text-primary-950">
              Terms and assumptions
            </h2>
            <p className="mt-3 leading-7">
              This quote assumes the listed scope, normal access, and
              non-hazardous materials. Pricing may change if volume, weight,
              access, disposal requirements, or item conditions differ on site.
            </p>
          </section>
        </div>

        <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <section className="rounded-3xl border border-primary-200 bg-white p-6 shadow-lg shadow-neutral-200/70">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
              Approve and schedule
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-primary-950">
              Ready to move forward?
            </h2>
            {showRefreshForm ? (
              <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                {quote.refreshRequestedAt ? (
                  <p>
                    Refresh requested. Stonegate will follow up with updated
                    pricing or availability.
                  </p>
                ) : (
                  <form action={refreshQuoteAction} className="space-y-3">
                    <p>
                      This quote has expired. Request a refreshed quote and
                      Stonegate will follow up.
                    </p>
                    <input type="hidden" name="token" value={token} />
                    <button className="w-full rounded-xl border border-rose-300 bg-white px-4 py-3 text-sm font-semibold text-rose-700">
                      Request refresh
                    </button>
                  </form>
                )}
              </div>
            ) : showApproveAndBook ? (
              <div className="mt-5 space-y-5">
                {hasAvailableSlots ? (
                  <form action={bookQuoteAction} className="space-y-4">
                    <input type="hidden" name="token" value={token} />
                    <label className="block text-sm font-semibold text-neutral-700">
                      Optional note for scheduling
                      <textarea
                        name="customerNote"
                        rows={3}
                        className="mt-2 w-full rounded-xl border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900"
                        placeholder="Gate code, access notes, timing preference, or anything we should know."
                      />
                    </label>
                    {availability?.days?.map((day) =>
                      day.slots.length ? (
                        <div key={day.date}>
                          <div className="text-sm font-semibold text-neutral-700">
                            {formatDay(day.date)}
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            {day.slots.slice(0, 4).map((slot) => (
                              <button
                                key={slot.startAt}
                                name="startAt"
                                value={slot.startAt}
                                className="rounded-xl border border-primary-200 bg-primary-50 px-3 py-3 text-sm font-semibold text-primary-900 hover:bg-primary-100"
                              >
                                {quote.status === "sent"
                                  ? "Approve and book"
                                  : "Book"}{" "}
                                {slot.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null,
                    )}
                    <p className="text-xs leading-5 text-neutral-500">
                      By booking, you agree to our{" "}
                      <Link
                        href="/service-agreement"
                        className="font-semibold text-primary-700 hover:underline"
                      >
                        Service Agreement and Cancellation Policy
                      </Link>
                      .
                    </p>
                  </form>
                ) : (
                  <form action={acceptQuoteAction} className="space-y-3">
                    <input type="hidden" name="token" value={token} />
                    <label className="block text-sm font-semibold text-neutral-700">
                      Optional note for scheduling
                      <textarea
                        name="customerNote"
                        rows={3}
                        className="mt-2 w-full rounded-xl border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900"
                        placeholder="Gate code, access notes, timing preference, or anything we should know."
                      />
                    </label>
                    <p className="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600">
                      No online windows are available right now. Approve the
                      quote and Stonegate will schedule with you directly.
                    </p>
                    <button className="w-full rounded-xl bg-primary-950 px-4 py-3 text-sm font-semibold text-white hover:bg-primary-900">
                      Approve quote and have Stonegate schedule me
                    </button>
                    <p className="text-xs leading-5 text-neutral-500">
                      By approving this quote, you agree to our{" "}
                      <Link
                        href="/service-agreement"
                        className="font-semibold text-primary-700 hover:underline"
                      >
                        Service Agreement and Cancellation Policy
                      </Link>
                      .
                    </p>
                  </form>
                )}
              </div>
            ) : quote.acceptedAppointmentId ? (
              <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                This quote is booked. Stonegate will see it on the calendar and
                follow up as needed.
              </div>
            ) : (
              <div className="mt-5 rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-600">
                This quote is no longer open for online approval.
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-primary-950">
              Need help?
            </h2>
            <div className="mt-4 space-y-2 text-sm">
              <a
                href={`tel:${company.phoneE164}`}
                className="block rounded-xl border border-neutral-200 px-3 py-3 font-semibold text-primary-800 hover:border-primary-300"
              >
                Call {company.phoneDisplay}
              </a>
              <a
                href={smsHref}
                className="block rounded-xl border border-neutral-200 px-3 py-3 font-semibold text-primary-800 hover:border-primary-300"
              >
                Text {company.phoneDisplay}
              </a>
              <a
                href={mailHref}
                className="block rounded-xl border border-neutral-200 px-3 py-3 font-semibold text-primary-800 hover:border-primary-300"
              >
                Email {company.email}
              </a>
            </div>
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
            <details>
              <summary className="cursor-pointer list-none text-sm font-semibold text-neutral-700">
                Decline quote
              </summary>
              <form action={declineQuoteAction} className="mt-4 space-y-3">
                <input type="hidden" name="token" value={token} />
                <select
                  name="reason"
                  className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900"
                >
                  <option value="">Prefer not to say</option>
                  <option value="Price">Price</option>
                  <option value="Timing">Timing</option>
                  <option value="Scope changed">Scope changed</option>
                  <option value="Chose another provider">
                    Chose another provider
                  </option>
                </select>
                <textarea
                  name="notes"
                  rows={3}
                  className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900"
                  placeholder="Optional note"
                />
                <button className="w-full rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 hover:bg-rose-100">
                  Send rejection
                </button>
              </form>
            </details>
          </section>
        </aside>
      </div>

      <footer className="border-t border-neutral-200 bg-white px-4 py-6 text-xs text-neutral-500 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <span>
            {company.name} | Licensed and insured | Make-It-Right Guarantee
          </span>
          <Link
            href="/"
            className="font-semibold text-accent-700 hover:underline"
          >
            Back to homepage
          </Link>
        </div>
      </footer>
    </main>
  );
}

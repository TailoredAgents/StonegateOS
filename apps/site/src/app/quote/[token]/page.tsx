import { randomUUID } from "node:crypto";
import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers as requestHeaders } from "next/headers";
import { getPublicCompanyProfile } from "@/lib/company";
import { quotePublicProxyNetworkHeaders } from "@/lib/quote-public-proxy-network";
import {
  PublicQuoteSubmitButton,
  QuoteChangeRequestForm,
  type QuoteChangeRequestActionState,
} from "./PublicQuoteForms";
import { QuoteV2CustomerProposal } from "./QuoteV2CustomerProposal";
import {
  normalizeQuoteV2PublicPayload,
  type QuoteV2PublicEnvelope,
} from "./quote-v2-customer-model";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Quote",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
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
    revision: number;
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

type PublicQuoteLoadResult =
  | { kind: "legacy"; quote: PublicQuoteResponse["quote"] }
  | { kind: "v2"; envelope: QuoteV2PublicEnvelope };

interface QuoteSlot {
  startAt: string;
  endAt: string;
  label: string;
}

interface AvailabilityResponse {
  ok: true;
  suggestions: QuoteSlot[];
  days: Array<{ date: string; slots: QuoteSlot[] }>;
  durationMinutes?: number;
  timezone?: string;
}

type AvailabilityLoadResult =
  | { kind: "available"; availability: AvailabilityResponse }
  | { kind: "confirmed-empty"; availability: AvailabilityResponse }
  | { kind: "unavailable" };

const PUBLIC_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;

function quoteApiUrl(token: string, segment = ""): URL {
  const suffix = segment ? `/${segment}` : "";
  return new URL(
    `/api/public/quotes/${encodeURIComponent(token)}${suffix}`,
    API_BASE_URL.replace(/\/$/u, ""),
  );
}

async function quoteApiHeaders(
  method: "GET" | "POST",
  target: URL,
  initial?: HeadersInit,
): Promise<Headers> {
  const incoming = await requestHeaders();
  const result = new Headers(initial);
  for (const [name, value] of Object.entries(
    quotePublicProxyNetworkHeaders({ headers: incoming, method }, target),
  )) {
    result.set(name, value);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPublicQuoteMutationSuccess(
  value: unknown,
  expectedQuoteId: string,
  expectedStatus?: "accepted" | "declined",
): value is {
  ok: true;
  quoteId: string;
  status?: "accepted" | "declined";
  refreshRequestedAt?: string;
} {
  if (!isRecord(value)) return false;
  const candidate = value;
  if (candidate["ok"] !== true || candidate["quoteId"] !== expectedQuoteId) {
    return false;
  }
  if (expectedStatus && candidate["status"] !== expectedStatus) return false;
  return true;
}

async function postPublicQuoteAction(input: {
  token: string;
  expectedQuoteId: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  expectedStatus?: "accepted" | "declined";
  requireRefreshTimestamp?: boolean;
}): Promise<boolean> {
  try {
    const target = quoteApiUrl(input.token);
    const response = await fetch(target, {
      method: "POST",
      headers: await quoteApiHeaders("POST", target, {
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
        "x-correlation-id": randomUUID(),
      }),
      body: JSON.stringify(input.body),
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (
      !response.ok ||
      !isPublicQuoteMutationSuccess(
        payload,
        input.expectedQuoteId,
        input.expectedStatus,
      )
    ) {
      return false;
    }
    if (
      input.requireRefreshTimestamp &&
      typeof payload.refreshRequestedAt !== "string"
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchQuote(
  token: string,
  preview: boolean,
): Promise<PublicQuoteLoadResult | null> {
  const url = quoteApiUrl(token);
  if (preview) url.searchParams.set("preview", "1");
  const response = await fetch(url, {
    cache: "no-store",
    headers: await quoteApiHeaders("GET", url),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as unknown;
  const v2Envelope = normalizeQuoteV2PublicPayload(data);
  if (v2Envelope) return { kind: "v2", envelope: v2Envelope };
  if (
    !data ||
    typeof data !== "object" ||
    !("quote" in data) ||
    typeof (data as { quote: unknown }).quote !== "object"
  ) {
    return null;
  }

  return { kind: "legacy", quote: (data as PublicQuoteResponse).quote };
}

function isQuoteSlot(value: unknown): value is QuoteSlot {
  return (
    isRecord(value) &&
    typeof value["startAt"] === "string" &&
    typeof value["endAt"] === "string" &&
    typeof value["label"] === "string"
  );
}

function parseAvailability(value: unknown): AvailabilityResponse | null {
  if (!isRecord(value) || value["ok"] !== true) return null;
  const rawDays = value["days"];
  const rawSuggestions = value["suggestions"];
  if (!Array.isArray(rawDays) || !Array.isArray(rawSuggestions)) return null;
  if (!rawSuggestions.every(isQuoteSlot)) return null;

  const days: AvailabilityResponse["days"] = [];
  for (const rawDay of rawDays) {
    if (
      !isRecord(rawDay) ||
      typeof rawDay["date"] !== "string" ||
      !Array.isArray(rawDay["slots"]) ||
      !rawDay["slots"].every(isQuoteSlot)
    ) {
      return null;
    }
    days.push({ date: rawDay["date"], slots: rawDay["slots"] });
  }

  return {
    ok: true,
    suggestions: rawSuggestions,
    days,
    durationMinutes:
      typeof value["durationMinutes"] === "number"
        ? value["durationMinutes"]
        : undefined,
    timezone:
      typeof value["timezone"] === "string" ? value["timezone"] : undefined,
  };
}

async function fetchAvailability(
  token: string,
): Promise<AvailabilityLoadResult> {
  try {
    const target = quoteApiUrl(token, "availability");
    const response = await fetch(target, {
      cache: "no-store",
      headers: await quoteApiHeaders("GET", target),
    });
    if (!response.ok) return { kind: "unavailable" };
    const availability = parseAvailability(
      await response.json().catch(() => null),
    );
    if (!availability) return { kind: "unavailable" };
    return availability.days.some((day) => day.slots.length > 0)
      ? { kind: "available", availability }
      : { kind: "confirmed-empty", availability };
  } catch {
    return { kind: "unavailable" };
  }
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
  const quoteId = formData.get("quoteId");
  const expectedRevisionRaw = formData.get("expectedRevision");
  const idempotencyKey = formData.get("idempotencyKey");
  const notes = formData.get("customerNote");
  if (
    typeof token !== "string" ||
    token.trim().length === 0 ||
    typeof quoteId !== "string" ||
    quoteId.trim().length === 0 ||
    typeof expectedRevisionRaw !== "string" ||
    typeof idempotencyKey !== "string" ||
    !PUBLIC_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    return;
  }
  const expectedRevision = Number(expectedRevisionRaw);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return;

  const succeeded = await postPublicQuoteAction({
    token,
    expectedQuoteId: quoteId,
    idempotencyKey,
    expectedStatus: "accepted",
    body: {
      quoteId: quoteId.trim(),
      expectedRevision,
      decision: "accepted",
      notes:
        typeof notes === "string" && notes.trim().length > 0
          ? notes.trim()
          : undefined,
    },
  });
  if (!succeeded) redirect(`/quote/${token}?approval=failed`);

  revalidatePath(`/quote/${token}`);
  redirect(`/quote/${token}?approval=received`);
}

export async function declineQuoteAction(formData: FormData) {
  "use server";

  const token = formData.get("token");
  const quoteId = formData.get("quoteId");
  const expectedRevisionRaw = formData.get("expectedRevision");
  const idempotencyKey = formData.get("idempotencyKey");
  const reason = formData.get("reason");
  const notes = formData.get("notes");
  if (
    typeof token !== "string" ||
    token.trim().length === 0 ||
    typeof quoteId !== "string" ||
    quoteId.trim().length === 0 ||
    typeof expectedRevisionRaw !== "string" ||
    typeof idempotencyKey !== "string" ||
    !PUBLIC_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    return;
  }
  const expectedRevision = Number(expectedRevisionRaw);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return;

  const succeeded = await postPublicQuoteAction({
    token,
    expectedQuoteId: quoteId,
    idempotencyKey,
    expectedStatus: "declined",
    body: {
      quoteId: quoteId.trim(),
      expectedRevision,
      decision: "declined",
      reason:
        typeof reason === "string" && reason.trim().length > 0
          ? reason.trim()
          : undefined,
      notes:
        typeof notes === "string" && notes.trim().length > 0
          ? notes.trim()
          : undefined,
    },
  });
  if (!succeeded) redirect(`/quote/${token}?decision=failed`);

  revalidatePath(`/quote/${token}`);
  redirect(`/quote/${token}?decision=received`);
}

export async function refreshQuoteAction(formData: FormData) {
  "use server";

  const token = formData.get("token");
  const quoteId = formData.get("quoteId");
  const idempotencyKey = formData.get("idempotencyKey");
  if (
    typeof token !== "string" ||
    token.trim().length === 0 ||
    typeof quoteId !== "string" ||
    quoteId.trim().length === 0 ||
    typeof idempotencyKey !== "string" ||
    !PUBLIC_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    return;
  }

  const succeeded = await postPublicQuoteAction({
    token,
    expectedQuoteId: quoteId,
    idempotencyKey,
    body: { action: "refresh" },
    requireRefreshTimestamp: true,
  });
  if (!succeeded) redirect(`/quote/${token}?refresh=failed`);

  revalidatePath(`/quote/${token}`);
  redirect(`/quote/${token}`);
}

export async function requestQuoteChangesAction(
  formData: FormData,
): Promise<QuoteChangeRequestActionState> {
  "use server";

  const token = formData.get("token");
  const quoteId = formData.get("quoteId");
  const expectedRevisionRaw = formData.get("expectedRevision");
  const idempotencyKey = formData.get("idempotencyKey");
  const reason = formData.get("reason");
  const message = formData.get("message");
  const reasonValue = typeof reason === "string" ? reason.trim() : "";
  const messageValue = typeof message === "string" ? message.trim() : "";
  const allowedReasons = new Set([
    "Scope changed",
    "Price question",
    "Timing issue",
    "Address issue",
    "Need to add/remove items",
    "Other",
  ]);
  if (
    typeof token !== "string" ||
    token.trim().length === 0 ||
    typeof quoteId !== "string" ||
    quoteId.trim().length === 0 ||
    typeof expectedRevisionRaw !== "string" ||
    typeof idempotencyKey !== "string" ||
    !PUBLIC_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    return {
      ok: false,
      message:
        "We could not validate this request. Refresh the quote and try again.",
    };
  }
  const expectedRevision = Number(expectedRevisionRaw);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return {
      ok: false,
      message:
        "This quote version is no longer valid. Refresh before requesting changes.",
    };
  }
  if (!allowedReasons.has(reasonValue)) {
    return { ok: false, message: "Choose a valid reason for the change." };
  }
  if (messageValue.length > 1500) {
    return {
      ok: false,
      message: "Change-request details must be 1,500 characters or fewer.",
    };
  }

  let response: Response;
  try {
    const target = quoteApiUrl(token, "changes");
    response = await fetch(target, {
      method: "POST",
      headers: await quoteApiHeaders("POST", target, {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "x-correlation-id": randomUUID(),
      }),
      body: JSON.stringify({
        quoteId: quoteId.trim(),
        expectedRevision,
        reason: reasonValue,
        message: messageValue || undefined,
      }),
    });
  } catch {
    return {
      ok: false,
      message:
        "We could not send your change request. Your text is still here; try again or contact Stonegate.",
    };
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (
    !response.ok ||
    !isRecord(payload) ||
    payload["ok"] !== true ||
    payload["quoteId"] !== quoteId.trim() ||
    payload["revision"] !== expectedRevision ||
    typeof payload["changeRequestId"] !== "string"
  ) {
    return {
      ok: false,
      message:
        "We could not confirm your change request. Your text is still here; try again or contact Stonegate.",
    };
  }
  revalidatePath(`/quote/${token}`);
  return {
    ok: true,
    message: "Change request received. Stonegate will review it and follow up.",
  };
}

export async function bookQuoteAction(formData: FormData) {
  "use server";

  const token = formData.get("token");
  const quoteId = formData.get("quoteId");
  const expectedRevisionRaw = formData.get("expectedRevision");
  const idempotencyKey = formData.get("idempotencyKey");
  const startAt = formData.get("startAt");
  const customerNote = formData.get("customerNote");
  if (
    typeof token !== "string" ||
    token.trim().length === 0 ||
    typeof quoteId !== "string" ||
    quoteId.trim().length === 0 ||
    typeof expectedRevisionRaw !== "string" ||
    typeof idempotencyKey !== "string" ||
    !PUBLIC_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey) ||
    typeof startAt !== "string" ||
    startAt.trim().length === 0
  ) {
    return;
  }
  const expectedRevision = Number(expectedRevisionRaw);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return;

  let holdResponse: Response;
  try {
    const target = quoteApiUrl(token, "hold");
    holdResponse = await fetch(target, {
      method: "POST",
      headers: await quoteApiHeaders("POST", target, {
        "Content-Type": "application/json",
        "Idempotency-Key": `${idempotencyKey}:hold`,
      }),
      body: JSON.stringify({
        quoteId,
        expectedRevision,
        startAt,
      }),
    });
  } catch {
    redirect(`/quote/${token}?booking=failed#quote-actions`);
  }
  const hold = (await holdResponse.json().catch(() => null)) as unknown;
  if (
    !holdResponse.ok ||
    !isRecord(hold) ||
    hold["ok"] !== true ||
    hold["quoteId"] !== quoteId ||
    hold["version"] !== expectedRevision ||
    typeof hold["holdId"] !== "string" ||
    typeof hold["expiresAt"] !== "string" ||
    typeof hold["auditEventId"] !== "string"
  ) {
    redirect(`/quote/${token}?booking=failed#quote-actions`);
  }

  let bookResponse: Response;
  try {
    const target = quoteApiUrl(token, "book");
    bookResponse = await fetch(target, {
      method: "POST",
      headers: await quoteApiHeaders("POST", target, {
        "Content-Type": "application/json",
        "Idempotency-Key": `${idempotencyKey}:book`,
      }),
      body: JSON.stringify({
        quoteId,
        expectedRevision,
        startAt,
        holdId: hold["holdId"],
        customerNote:
          typeof customerNote === "string" && customerNote.trim().length > 0
            ? customerNote.trim()
            : undefined,
      }),
    });
  } catch {
    redirect(`/quote/${token}?booking=failed#quote-actions`);
  }
  const booking = (await bookResponse.json().catch(() => null)) as unknown;
  if (
    !bookResponse.ok ||
    !isRecord(booking) ||
    booking["ok"] !== true ||
    booking["quoteId"] !== quoteId ||
    booking["quoteStatus"] !== "accepted" ||
    booking["pipelineStage"] !== "won" ||
    booking["quoteRevision"] !== expectedRevision + 1 ||
    typeof booking["appointmentId"] !== "string" ||
    typeof booking["startAt"] !== "string" ||
    typeof booking["auditEventId"] !== "string"
  ) {
    redirect(`/quote/${token}?booking=failed#quote-actions`);
  }

  revalidatePath(`/quote/${token}`);
  redirect(`/quote/${token}?booking=confirmed`);
}

function AvailabilityLoadingState() {
  return (
    <div
      className="mt-5 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900"
      role="status"
      aria-live="polite"
      data-availability-state="loading"
    >
      <p className="font-semibold">Checking appointment availability…</p>
      <p className="mt-1 leading-6">
        We are loading current service windows before showing booking options.
      </p>
    </div>
  );
}

async function QuoteDecisionControls({
  token,
  quote,
  preview,
  company,
}: {
  token: string;
  quote: PublicQuoteResponse["quote"];
  preview: boolean;
  company: ReturnType<typeof getPublicCompanyProfile>;
}) {
  if (preview) {
    return (
      <div className="mt-5 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-900">
        Read-only staff preview. Approval, booking, decline, refresh, and
        change-request controls are disabled here.
      </div>
    );
  }

  const showRefreshForm =
    quote.expired || quote.displayStatus === "refresh_requested";
  if (showRefreshForm) {
    return (
      <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
        {quote.refreshRequestedAt ? (
          <p role="status">
            Refresh requested. Stonegate will follow up with updated pricing or
            availability.
          </p>
        ) : (
          <form action={refreshQuoteAction} className="space-y-3">
            <p>
              This quote has expired. Request a refreshed quote and Stonegate
              will follow up.
            </p>
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="quoteId" value={quote.id} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <PublicQuoteSubmitButton
              className="min-h-11 w-full rounded-xl border border-rose-300 bg-white px-4 py-3 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-wait disabled:opacity-70"
              pendingLabel="Requesting refresh…"
            >
              Request refresh
            </PublicQuoteSubmitButton>
          </form>
        )}
      </div>
    );
  }

  if (quote.acceptedAppointmentId) {
    return (
      <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
        This quote is booked. Stonegate will see it on the calendar and follow
        up as needed.
      </div>
    );
  }

  const canSchedule =
    (quote.status === "sent" || quote.status === "accepted") && !quote.expired;
  if (!canSchedule) {
    return (
      <div className="mt-5 rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-600">
        This quote is no longer open for online approval.
      </div>
    );
  }

  const availabilityResult = await fetchAvailability(token);
  if (availabilityResult.kind === "unavailable") {
    return (
      <div
        className="mt-5 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
        role="status"
        aria-live="polite"
        data-availability-state="unavailable"
      >
        <p className="font-semibold">Scheduling is temporarily unavailable.</p>
        <p className="mt-2 leading-6">
          We could not check the calendar, which does not mean appointment
          windows are full. Retry or contact Stonegate for help scheduling.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href={`/quote/${encodeURIComponent(token)}?availabilityRetry=1#quote-actions`}
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-amber-400 bg-white px-4 py-2 font-semibold text-amber-950 hover:bg-amber-100"
          >
            Retry availability
          </a>
          <a
            href={`tel:${company.phoneE164}`}
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-amber-400 bg-white px-4 py-2 font-semibold text-amber-950 hover:bg-amber-100"
          >
            Call {company.phoneDisplay}
          </a>
        </div>
      </div>
    );
  }

  const { availability } = availabilityResult;
  if (availabilityResult.kind === "available") {
    const timezoneLabel = availability.timezone
      ? availability.timezone.replaceAll("_", " ")
      : "Stonegate’s service timezone";
    return (
      <div className="mt-5 space-y-5" data-availability-state="available">
        <p className="sr-only" role="status" aria-live="polite">
          Current appointment windows loaded.
        </p>
        <form action={bookQuoteAction} className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="quoteId" value={quote.id} />
          <input
            type="hidden"
            name="expectedRevision"
            value={String(quote.revision)}
          />
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label
            htmlFor={`quote-scheduling-note-${quote.id}`}
            className="block text-sm font-semibold text-neutral-700"
          >
            Optional note for scheduling
          </label>
          <textarea
            id={`quote-scheduling-note-${quote.id}`}
            name="customerNote"
            rows={3}
            maxLength={1000}
            className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900 focus-visible:border-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-200"
            placeholder="Gate code, access notes, timing preference, or anything we should know."
          />
          <p className="text-xs text-neutral-500">
            Times shown in {timezoneLabel}.
          </p>
          {availability.days.map((day) =>
            day.slots.length ? (
              <fieldset key={day.date}>
                <legend className="text-sm font-semibold text-neutral-700">
                  {formatDay(day.date)}
                </legend>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {day.slots.slice(0, 4).map((slot) => (
                    <PublicQuoteSubmitButton
                      key={slot.startAt}
                      name="startAt"
                      value={slot.startAt}
                      trackSelection
                      pendingLabel="Booking…"
                      className="min-h-11 rounded-xl border border-primary-200 bg-primary-50 px-3 py-3 text-sm font-semibold text-primary-900 hover:bg-primary-100 disabled:cursor-wait disabled:opacity-60"
                    >
                      {quote.status === "sent" ? "Approve and book" : "Book"}{" "}
                      {slot.label}
                    </PublicQuoteSubmitButton>
                  ))}
                </div>
              </fieldset>
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
      </div>
    );
  }

  if (quote.status === "accepted") {
    return (
      <div
        className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900"
        role="status"
        data-availability-state="confirmed-empty"
      >
        We checked current online availability and no windows are open. Your
        quote is already approved, so Stonegate will contact you to schedule.
      </div>
    );
  }

  return (
    <form
      action={acceptQuoteAction}
      className="mt-5 space-y-3"
      data-availability-state="confirmed-empty"
    >
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="quoteId" value={quote.id} />
      <input
        type="hidden"
        name="expectedRevision"
        value={String(quote.revision)}
      />
      <input type="hidden" name="idempotencyKey" value={randomUUID()} />
      <label
        htmlFor={`quote-approval-note-${quote.id}`}
        className="block text-sm font-semibold text-neutral-700"
      >
        Optional note for scheduling
      </label>
      <textarea
        id={`quote-approval-note-${quote.id}`}
        name="customerNote"
        rows={3}
        maxLength={1000}
        className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900 focus-visible:border-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-200"
        placeholder="Gate code, access notes, timing preference, or anything we should know."
      />
      <p
        className="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-600"
        role="status"
      >
        We checked current online availability and no windows are open. You can
        still approve the quote and Stonegate will schedule with you directly.
      </p>
      <PublicQuoteSubmitButton
        className="min-h-11 w-full rounded-xl bg-primary-900 px-4 py-3 text-sm font-semibold text-white hover:bg-primary-800 disabled:cursor-wait disabled:opacity-70"
        pendingLabel="Approving quote…"
      >
        Approve quote and have Stonegate schedule me
      </PublicQuoteSubmitButton>
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
  );
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
  const decisionFlag =
    typeof query["decision"] === "string" ? query["decision"] : null;
  const refreshFlag =
    typeof query["refresh"] === "string" ? query["refresh"] : null;
  const changesFlag =
    typeof query["changes"] === "string" ? query["changes"] : null;
  const loadedQuote = await fetchQuote(token, preview);
  if (!loadedQuote) notFound();

  if (loadedQuote.kind === "v2") {
    return (
      <QuoteV2CustomerProposal
        token={token}
        envelope={loadedQuote.envelope}
        pdfHref={`/quote/${encodeURIComponent(token)}/pdf`}
        acceptedResponseId={loadedQuote.envelope.acceptedResponseId}
      />
    );
  }

  const quote = loadedQuote.quote;

  const company = getPublicCompanyProfile();
  const smsHref = `sms:${company.phoneE164}`;
  const mailHref = `mailto:${company.email}?subject=${encodeURIComponent(`Question about quote ${quote.quoteNumber}`)}`;
  const declineIdempotencyKey = randomUUID();
  const changesIdempotencyKey = randomUUID();

  return (
    <main className="min-h-screen bg-[#f6f4ef] text-neutral-950">
      <section className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
          <header className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary-700">
                {company.name} | Licensed and insured | Make-It-Right Guarantee
              </p>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-primary-900 sm:text-5xl">
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
                  className={`mt-1 text-lg font-semibold ${quote.expired ? "text-rose-700" : "text-primary-900"}`}
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
          {bookingFlag === "confirmed" && quote.acceptedAppointmentId ? (
            <section
              className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm font-medium text-emerald-900"
              role="status"
              aria-live="polite"
            >
              Your service window is booked. Stonegate will send a confirmation
              and follow up if anything needs clarification.
            </section>
          ) : null}
          {bookingFlag === "failed" ? (
            <section
              className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-sm font-medium text-rose-800"
              role="alert"
            >
              We could not complete online booking, and no appointment was
              confirmed. Refresh availability and try again, or contact
              Stonegate for help.
            </section>
          ) : null}
          {approvalFlag === "received" && quote.status === "accepted" ? (
            <section
              className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm font-medium text-emerald-900"
              role="status"
              aria-live="polite"
            >
              Quote approved. Stonegate will follow up to schedule the job.
            </section>
          ) : null}
          {approvalFlag === "failed" ? (
            <section
              className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-sm font-medium text-rose-800"
              role="alert"
            >
              We could not confirm your approval. Your quote was not shown as
              approved. Refresh the page and try again, or contact Stonegate.
            </section>
          ) : null}
          {decisionFlag === "received" &&
          (quote.status === "accepted" || quote.status === "declined") ? (
            <section
              className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm font-medium text-emerald-900"
              role="status"
              aria-live="polite"
            >
              Your quote decision was recorded.
            </section>
          ) : null}
          {decisionFlag === "failed" ? (
            <section
              className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-sm font-medium text-rose-800"
              role="alert"
            >
              We could not confirm your decision. Refresh the page before trying
              again, or contact Stonegate.
            </section>
          ) : null}
          {refreshFlag === "failed" ? (
            <section
              className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-sm font-medium text-rose-800"
              role="alert"
            >
              We could not confirm the refresh request. Refresh the page and try
              again, or contact Stonegate.
            </section>
          ) : null}
          {changesFlag === "sent" ? (
            <section
              className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm font-medium text-amber-900"
              role="status"
              aria-live="polite"
            >
              Change request received. Your quote is still available to approve
              while Stonegate reviews your request.
            </section>
          ) : null}
          {changesFlag === "failed" ? (
            <section
              className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-sm font-medium text-rose-800"
              role="alert"
            >
              We could not confirm the change request. Keep your note, refresh
              the page, and try again or contact Stonegate directly.
            </section>
          ) : null}

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
                  Proposal total
                </p>
                <div className="mt-2 text-5xl font-semibold tracking-tight text-primary-900">
                  {formatCurrency(quote.total)}
                </div>
                <p className="mt-2 text-sm text-neutral-600">
                  {paymentTerms(quote)}
                </p>
              </div>
              <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700 sm:min-w-64">
                <div className="font-semibold text-primary-900">
                  Service property
                </div>
                <div className="mt-2">
                  {[quote.addressLine1, quote.serviceArea]
                    .filter(Boolean)
                    .join(", ")}
                </div>
                <div className="mt-4 font-semibold text-primary-900">
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
                <h2 className="mt-1 text-2xl font-semibold text-primary-900">
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
            <h2 className="mt-1 text-2xl font-semibold text-primary-900">
              Line-item quote
            </h2>
            <div className="mt-5 overflow-hidden rounded-2xl border border-neutral-200">
              <table className="min-w-full divide-y divide-neutral-200">
                <caption className="sr-only">
                  Quoted services and prices
                </caption>
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Service</th>
                    <th scope="col">Price</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200 text-sm text-neutral-700">
                  {quote.lineItems.map((item) => (
                    <tr key={item.id}>
                      <th scope="row" className="px-4 py-4 text-left">
                        <div className="font-semibold text-primary-900">
                          {item.label}
                        </div>
                        {item.category ? (
                          <div className="text-xs uppercase tracking-[0.12em] text-neutral-500">
                            {item.category}
                          </div>
                        ) : null}
                      </th>
                      <td className="whitespace-nowrap px-4 py-4 text-right font-semibold">
                        {formatCurrency(item.amount)}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-neutral-50">
                    <th
                      scope="row"
                      className="px-4 py-4 text-left font-semibold text-primary-900"
                    >
                      Subtotal
                    </th>
                    <td className="px-4 py-4 text-right font-semibold text-primary-900">
                      {formatCurrency(quote.subtotal)}
                    </td>
                  </tr>
                  <tr className="bg-primary-900 text-white">
                    <th
                      scope="row"
                      className="px-4 py-4 text-left text-base font-semibold"
                    >
                      Total
                    </th>
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
            <h2 className="mt-1 text-2xl font-semibold text-primary-900">
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
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-900 text-sm font-semibold text-white">
                    {index + 1}
                  </div>
                  <div className="mt-3 font-semibold text-primary-900">
                    {step}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {!preview ? (
            <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8">
              <details>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-lg font-semibold text-primary-900">
                  <span>Request changes to this quote</span>
                  <span aria-hidden="true">⌄</span>
                </summary>
                <p className="mt-2 text-sm text-neutral-600">
                  Send a structured request to Stonegate. The quote stays
                  available to approve while the team reviews it.
                </p>
                <QuoteChangeRequestForm
                  action={requestQuoteChangesAction}
                  token={token}
                  quoteId={quote.id}
                  expectedRevision={quote.revision}
                  idempotencyKey={changesIdempotencyKey}
                />
              </details>
            </section>
          ) : null}

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 text-sm text-neutral-700 shadow-sm sm:p-8">
            <h2 className="text-lg font-semibold text-primary-900">
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
          <section
            id="quote-actions"
            className="scroll-mt-6 rounded-3xl border border-primary-200 bg-white p-6 shadow-lg shadow-neutral-200/70"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
              Approve and schedule
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-primary-900">
              Ready to move forward?
            </h2>
            <Suspense fallback={<AvailabilityLoadingState />}>
              <QuoteDecisionControls
                token={token}
                quote={quote}
                preview={preview}
                company={company}
              />
            </Suspense>
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-primary-900">
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

          {!preview &&
          quote.status === "sent" &&
          !quote.expired &&
          !quote.acceptedAppointmentId ? (
            <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
              <details>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-neutral-700">
                  <span>Decline quote</span>
                  <span aria-hidden="true">⌄</span>
                </summary>
                <form action={declineQuoteAction} className="mt-4 space-y-3">
                  <input type="hidden" name="token" value={token} />
                  <input type="hidden" name="quoteId" value={quote.id} />
                  <input
                    type="hidden"
                    name="expectedRevision"
                    value={String(quote.revision)}
                  />
                  <input
                    type="hidden"
                    name="idempotencyKey"
                    value={declineIdempotencyKey}
                  />
                  <label
                    htmlFor={`quote-decline-reason-${quote.id}`}
                    className="block text-sm font-semibold text-neutral-700"
                  >
                    Reason for declining
                  </label>
                  <select
                    id={`quote-decline-reason-${quote.id}`}
                    name="reason"
                    className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900 focus-visible:border-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-200"
                  >
                    <option value="">Prefer not to say</option>
                    <option value="Price">Price</option>
                    <option value="Timing">Timing</option>
                    <option value="Scope changed">Scope changed</option>
                    <option value="Chose another provider">
                      Chose another provider
                    </option>
                  </select>
                  <label
                    htmlFor={`quote-decline-notes-${quote.id}`}
                    className="block text-sm font-semibold text-neutral-700"
                  >
                    Optional note
                  </label>
                  <textarea
                    id={`quote-decline-notes-${quote.id}`}
                    name="notes"
                    rows={3}
                    maxLength={1000}
                    className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900 focus-visible:border-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-200"
                    placeholder="Optional note"
                  />
                  <PublicQuoteSubmitButton
                    className="min-h-11 w-full rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 hover:bg-rose-100 disabled:cursor-wait disabled:opacity-70"
                    pendingLabel="Sending decision…"
                  >
                    Send rejection
                  </PublicQuoteSubmitButton>
                </form>
              </details>
            </section>
          ) : null}
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

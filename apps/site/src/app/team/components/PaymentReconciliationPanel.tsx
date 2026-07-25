import { SubmitButton } from "@/components/SubmitButton";
import { paymentReconciliationAction } from "../actions";
import { TEAM_CARD_PADDED, teamButtonClass } from "./team-ui";

export type PaymentReconciliationPayload = {
  generatedAt: string;
  attempts: Array<{
    id: string;
    appointmentId: string;
    status: string;
    requestedJobAmountCents: number;
    providerOrderId: string | null;
    providerPaymentId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  }>;
  unmatchedPayments: Array<{
    id: string;
    provider: string;
    appointmentId: string | null;
    providerPaymentId: string | null;
    providerOrderId: string | null;
    status: string;
    amount: number;
    jobAmountCents: number | null;
    tipCents: number;
    totalAmountCents: number | null;
    refundedAmountCents: number;
    currency: string;
    canonicalStatus: string | null;
    providerStatus: string | null;
    receiptUrl: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }>;
  events: Array<{
    id: string;
    providerEventId: string;
    providerObjectId: string | null;
    eventType: string;
    processingStatus: string;
    paymentId: string | null;
    paymentAttemptId: string | null;
    error: string | null;
    receivedAt: string;
    processedAt: string | null;
  }>;
  refunds: Array<{
    id: string;
    paymentId: string;
    providerRefundId: string | null;
    amountCents: number;
    jobAmountCents: number;
    tipCents: number;
    canonicalStatus: string;
    providerStatus: string | null;
    reason: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }>;
};

export type PaymentReconciliationAppointment = {
  id: string;
  status: string;
  startAt: string | null;
  contact: { name: string };
  property: {
    addressLine1: string;
    city: string;
    state: string;
  };
};

function money(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function when(value: string | null): string {
  if (!value) return "Unknown time";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function shortId(value: string | null): string {
  if (!value) return "Not available";
  return value.length > 22 ? `${value.slice(0, 22)}…` : value;
}

function statusClass(status: string): string {
  if (["failed", "needs_review", "expired"].includes(status)) {
    return "bg-rose-100 text-rose-800";
  }
  if (["processing", "received", "pending_verification"].includes(status)) {
    return "bg-amber-100 text-amber-800";
  }
  return "bg-slate-100 text-slate-700";
}

function metadataReason(
  metadata: Record<string, unknown> | null,
): string | null {
  if (!metadata) return null;
  for (const key of [
    "reconciliation",
    "reviewReason",
    "commissionReviewReason",
  ]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function appointmentLabel(
  appointment: PaymentReconciliationAppointment,
): string {
  const address = [
    appointment.property.addressLine1,
    appointment.property.city,
    appointment.property.state,
  ]
    .filter(Boolean)
    .join(", ");
  return `${appointment.contact.name} · ${address || appointment.id} · ${appointment.status}`;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">
      {children}
    </div>
  );
}

export function PaymentReconciliationPanel({
  data,
  error,
  appointments,
}: {
  data: PaymentReconciliationPayload | null;
  error: string | null;
  appointments: PaymentReconciliationAppointment[];
}) {
  if (error || !data) {
    return (
      <section className={TEAM_CARD_PADDED}>
        <h3 className="text-lg font-semibold text-slate-900">
          Payment reconciliation
        </h3>
        <p className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {error ?? "Payment reconciliation is unavailable."}
        </p>
      </section>
    );
  }

  const totalItems =
    data.attempts.length +
    data.unmatchedPayments.length +
    data.events.length +
    data.refunds.length;

  return (
    <div className="space-y-4">
      <section className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">
              Payment reconciliation
            </h3>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">
              Compare these records with Square or Stripe before resolving them.
              Retrying only re-checks provider data; dismissing, acknowledging,
              and resolving Stripe records require an owner reason and are
              written to the audit log.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Refreshed {when(data.generatedAt)} · {totalItems} open{" "}
              {totalItems === 1 ? "item" : "items"}
            </p>
          </div>
          <form action={paymentReconciliationAction}>
            <input type="hidden" name="operation" value="sweep" />
            <SubmitButton
              className={teamButtonClass("primary", "sm")}
              pendingLabel="Checking Square..."
            >
              Run Square sweep
            </SubmitButton>
          </form>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Attempts", data.attempts.length],
            ["Payments", data.unmatchedPayments.length],
            ["Provider events", data.events.length],
            ["Refunds", data.refunds.length],
          ].map(([label, count]) => (
            <div
              key={String(label)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
            >
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {label}
              </div>
              <div className="mt-1 text-2xl font-semibold text-slate-900">
                {count}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={`${TEAM_CARD_PADDED} space-y-3`}>
        <div>
          <h4 className="font-semibold text-slate-900">Square attempts</h4>
          <p className="text-sm text-slate-600">
            Retry provider verification first. Dismiss only after confirming in
            Square that no customer charge exists.
          </p>
        </div>
        {data.attempts.length === 0 ? (
          <EmptyState>No Square attempts need attention.</EmptyState>
        ) : (
          data.attempts.map((attempt) => (
            <article
              key={attempt.id}
              className="rounded-2xl border border-slate-200 bg-white p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">
                      {money(attempt.requestedJobAmountCents)}
                    </span>
                    <span
                      className={`rounded-full px-2 py-1 text-[11px] font-semibold ${statusClass(attempt.status)}`}
                    >
                      {attempt.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    Appointment {shortId(attempt.appointmentId)} · Attempt{" "}
                    {shortId(attempt.id)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    Expires {when(attempt.expiresAt)}
                  </div>
                </div>
                <form action={paymentReconciliationAction}>
                  <input type="hidden" name="operation" value="attempt_retry" />
                  <input type="hidden" name="attemptId" value={attempt.id} />
                  <SubmitButton
                    className={teamButtonClass("secondary", "sm")}
                    pendingLabel="Checking..."
                  >
                    Retry verification
                  </SubmitButton>
                </form>
              </div>

              {attempt.errorCode || attempt.errorMessage ? (
                <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                  <div className="font-semibold">
                    {attempt.errorCode?.replace(/_/g, " ") ??
                      "Provider verification issue"}
                  </div>
                  {attempt.errorMessage &&
                  attempt.errorMessage !== attempt.errorCode ? (
                    <div className="mt-1">{attempt.errorMessage}</div>
                  ) : null}
                </div>
              ) : null}

              {["failed", "expired", "needs_review"].includes(
                attempt.status,
              ) ? (
                <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <summary className="cursor-pointer text-sm font-semibold text-slate-800">
                    Dismiss after provider review
                  </summary>
                  <form
                    action={paymentReconciliationAction}
                    className="mt-3 space-y-2"
                  >
                    <input
                      type="hidden"
                      name="operation"
                      value="attempt_dismiss"
                    />
                    <input type="hidden" name="attemptId" value={attempt.id} />
                    <textarea
                      name="reviewNote"
                      required
                      minLength={3}
                      maxLength={500}
                      placeholder="What you checked in Square and why it is safe to dismiss"
                      className="min-h-20 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                    <SubmitButton
                      className={teamButtonClass("danger", "sm")}
                      pendingLabel="Dismissing..."
                    >
                      Confirm no charge and dismiss
                    </SubmitButton>
                  </form>
                </details>
              ) : null}
            </article>
          ))
        )}
      </section>

      <section className={`${TEAM_CARD_PADDED} space-y-3`}>
        <div>
          <h4 className="font-semibold text-slate-900">
            Unmatched or review payments
          </h4>
          <p className="text-sm text-slate-600">
            Square records are verified from the provider. Historical Stripe
            records require an explicit appointment and job/tip allocation.
          </p>
        </div>
        <datalist id="reconciliation-appointments">
          {appointments.map((appointment) => (
            <option
              key={appointment.id}
              value={appointment.id}
              label={appointmentLabel(appointment)}
            />
          ))}
        </datalist>
        {data.unmatchedPayments.length === 0 ? (
          <EmptyState>No provider payments need owner review.</EmptyState>
        ) : (
          data.unmatchedPayments.map((payment) => {
            const totalAmountCents = payment.totalAmountCents ?? payment.amount;
            const jobAmountCents =
              payment.jobAmountCents ??
              Math.max(totalAmountCents - payment.tipCents, 0);
            const reason = metadataReason(payment.metadata);
            return (
              <article
                key={payment.id}
                className="rounded-2xl border border-slate-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">
                        {money(totalAmountCents, payment.currency)}
                      </span>
                      <span
                        className={`rounded-full px-2 py-1 text-[11px] font-semibold ${statusClass(payment.canonicalStatus ?? payment.status)}`}
                      >
                        {payment.provider} ·{" "}
                        {(payment.canonicalStatus ?? payment.status).replace(
                          /_/g,
                          " ",
                        )}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      Provider ID {shortId(payment.providerPaymentId)} · Local{" "}
                      {shortId(payment.id)}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      Provider status {payment.providerStatus ?? payment.status}
                      {payment.appointmentId
                        ? ` · Appointment ${shortId(payment.appointmentId)}`
                        : " · No appointment"}
                    </div>
                    {reason ? (
                      <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        Reason: {reason.replace(/_/g, " ")}
                      </div>
                    ) : null}
                  </div>
                  {payment.receiptUrl ? (
                    <a
                      href={payment.receiptUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-semibold text-primary-700 underline"
                    >
                      Provider receipt
                    </a>
                  ) : null}
                </div>

                {payment.provider === "square" && payment.providerPaymentId ? (
                  <form action={paymentReconciliationAction} className="mt-3">
                    <input
                      type="hidden"
                      name="operation"
                      value="square_payment_retry"
                    />
                    <input
                      type="hidden"
                      name="providerPaymentId"
                      value={payment.providerPaymentId}
                    />
                    <SubmitButton
                      className={teamButtonClass("secondary", "sm")}
                      pendingLabel="Checking..."
                    >
                      Retry Square payment
                    </SubmitButton>
                  </form>
                ) : null}
                {payment.provider === "square" && !payment.providerPaymentId ? (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    This local record has no Square payment ID. It cannot be
                    retried automatically and must remain in owner review.
                  </div>
                ) : null}

                {payment.provider === "stripe" ? (
                  <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-slate-800">
                      Attach and resolve historical Stripe payment
                    </summary>
                    <form
                      action={paymentReconciliationAction}
                      className="mt-3 grid gap-3 md:grid-cols-2"
                    >
                      <input
                        type="hidden"
                        name="operation"
                        value="stripe_resolve"
                      />
                      <input
                        type="hidden"
                        name="paymentId"
                        value={payment.id}
                      />
                      <label className="space-y-1 text-xs font-semibold text-slate-700 md:col-span-2">
                        Appointment
                        <input
                          name="appointmentId"
                          list="reconciliation-appointments"
                          required
                          defaultValue={payment.appointmentId ?? ""}
                          placeholder="Choose or paste an appointment ID"
                          className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-normal"
                        />
                      </label>
                      <label className="space-y-1 text-xs font-semibold text-slate-700">
                        Job amount
                        <input
                          name="jobAmount"
                          inputMode="decimal"
                          required
                          defaultValue={(jobAmountCents / 100).toFixed(2)}
                          className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-normal"
                        />
                      </label>
                      <label className="space-y-1 text-xs font-semibold text-slate-700">
                        Tip
                        <input
                          name="tipAmount"
                          inputMode="decimal"
                          required
                          defaultValue={(payment.tipCents / 100).toFixed(2)}
                          className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-normal"
                        />
                      </label>
                      <label className="space-y-1 text-xs font-semibold text-slate-700 md:col-span-2">
                        Owner review reason
                        <textarea
                          name="reviewNote"
                          required
                          minLength={3}
                          maxLength={500}
                          placeholder="What provider record and job details you compared"
                          className="mt-1 min-h-20 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-normal"
                        />
                      </label>
                      <div className="md:col-span-2">
                        <SubmitButton
                          className={teamButtonClass("primary", "sm")}
                          pendingLabel="Resolving..."
                        >
                          Confirm allocation and resolve
                        </SubmitButton>
                      </div>
                    </form>
                  </details>
                ) : null}
              </article>
            );
          })
        )}
      </section>

      <section className={`${TEAM_CARD_PADDED} space-y-3`}>
        <div>
          <h4 className="font-semibold text-slate-900">
            Square webhook events
          </h4>
          <p className="text-sm text-slate-600">
            Failed, review, or stale event leases can be claimed and retried
            once. Fresh processing leases cannot be interrupted.
          </p>
        </div>
        {data.events.length === 0 ? (
          <EmptyState>No Square provider events need attention.</EmptyState>
        ) : (
          data.events.map((event) => {
            const retrySupported = [
              "payment.created",
              "payment.updated",
              "refund.created",
              "refund.updated",
            ].includes(event.eventType);
            return (
              <article
                key={event.id}
                className="rounded-2xl border border-slate-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">
                        {event.eventType}
                      </span>
                      <span
                        className={`rounded-full px-2 py-1 text-[11px] font-semibold ${statusClass(event.processingStatus)}`}
                      >
                        {event.processingStatus.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      Event {shortId(event.providerEventId)} · Object{" "}
                      {shortId(event.providerObjectId)}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      Received {when(event.receivedAt)}
                    </div>
                    {event.error ? (
                      <div className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                        {event.error}
                      </div>
                    ) : null}
                    {!event.providerObjectId ? (
                      <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        This saved event has no provider object ID, so it cannot
                        be retried automatically. Compare it in Square and keep
                        it in owner review.
                      </div>
                    ) : null}
                    {!retrySupported ? (
                      <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        This event type is retained for review but has no
                        automatic reconciliation handler.
                      </div>
                    ) : null}
                  </div>
                  <form action={paymentReconciliationAction}>
                    <input type="hidden" name="operation" value="event_retry" />
                    <input type="hidden" name="eventId" value={event.id} />
                    <SubmitButton
                      className={teamButtonClass("secondary", "sm")}
                      pendingLabel="Retrying..."
                      disabled={!event.providerObjectId || !retrySupported}
                    >
                      Retry event
                    </SubmitButton>
                  </form>
                </div>
              </article>
            );
          })
        )}
      </section>

      <section className={`${TEAM_CARD_PADDED} space-y-3`}>
        <div>
          <h4 className="font-semibold text-slate-900">
            Refund and commission review
          </h4>
          <p className="text-sm text-slate-600">
            Retry Square first. Acknowledgement records that the owner reviewed
            the completed-job, commission, and locked-payout impact; it does not
            rewrite those records.
          </p>
        </div>
        {data.refunds.length === 0 ? (
          <EmptyState>No refunds need owner review.</EmptyState>
        ) : (
          data.refunds.map((refund) => {
            const requiresAcknowledgement =
              refund.metadata?.["commissionReviewRequired"] === true &&
              !refund.metadata?.["commissionReviewAcknowledgedAt"];
            const reason = refund.reason ?? metadataReason(refund.metadata);
            return (
              <article
                key={refund.id}
                className="rounded-2xl border border-slate-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">
                        {money(refund.amountCents)}
                      </span>
                      <span
                        className={`rounded-full px-2 py-1 text-[11px] font-semibold ${statusClass(refund.canonicalStatus)}`}
                      >
                        {refund.canonicalStatus.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      Refund {shortId(refund.providerRefundId)} · Payment{" "}
                      {shortId(refund.paymentId)}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      Job {money(refund.jobAmountCents)} · Tip{" "}
                      {money(refund.tipCents)} · Provider{" "}
                      {refund.providerStatus ?? "unknown"}
                    </div>
                    {reason ? (
                      <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        Reason: {reason}
                      </div>
                    ) : null}
                  </div>
                  {refund.providerRefundId ? (
                    <form action={paymentReconciliationAction}>
                      <input
                        type="hidden"
                        name="operation"
                        value="square_refund_retry"
                      />
                      <input
                        type="hidden"
                        name="providerRefundId"
                        value={refund.providerRefundId}
                      />
                      <SubmitButton
                        className={teamButtonClass("secondary", "sm")}
                        pendingLabel="Checking..."
                      >
                        Retry Square refund
                      </SubmitButton>
                    </form>
                  ) : null}
                </div>

                {requiresAcknowledgement ? (
                  <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-slate-800">
                      Acknowledge commission impact
                    </summary>
                    <form
                      action={paymentReconciliationAction}
                      className="mt-3 space-y-2"
                    >
                      <input
                        type="hidden"
                        name="operation"
                        value="refund_acknowledge"
                      />
                      <input type="hidden" name="refundId" value={refund.id} />
                      <textarea
                        name="reviewNote"
                        required
                        minLength={3}
                        maxLength={500}
                        placeholder="What you reviewed and any commission or payout follow-up required"
                        className="min-h-20 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                      />
                      <SubmitButton
                        className={teamButtonClass("primary", "sm")}
                        pendingLabel="Acknowledging..."
                      >
                        Record owner acknowledgement
                      </SubmitButton>
                    </form>
                  </details>
                ) : null}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Payment verification | Stonegate",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function QuotePaymentReturnPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12 text-slate-950 dark:bg-slate-950 dark:text-slate-50">
      <section
        className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-950/5 dark:border-slate-800 dark:bg-slate-900 sm:p-8"
        aria-labelledby="payment-return-title"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
          Secure checkout complete
        </p>
        <h1
          id="payment-return-title"
          className="mt-2 text-3xl font-semibold tracking-tight"
        >
          We’re verifying your deposit
        </h1>
        <p className="mt-4 text-base leading-7 text-slate-600 dark:text-slate-300">
          Your proposal updates only after Stonegate verifies the payment with
          Square. Return to the original proposal page to see the confirmed
          payment and scheduling status. This checkout return by itself does not
          confirm an appointment.
        </p>
        <div
          className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
          role="status"
        >
          Keep the original proposal link private. If its status has not updated
          after a few minutes, contact the Stonegate team and keep your Square
          receipt available.
        </div>
      </section>
    </main>
  );
}

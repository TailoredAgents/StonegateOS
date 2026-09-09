"use client";

import { PartnerAccessHelp } from "@/app/partners/components/PartnerAccessHelp";

export default function PartnerPublicError({ reset }: { reset: () => void }) {
  return (
    <section className="mx-auto max-w-xl space-y-6">
      <div role="alert" className="space-y-3">
        <h1 className="font-display text-3xl font-semibold text-primary-900">
          We couldn’t open this page
        </h1>
        <p className="text-base leading-7 text-slate-600">
          Nothing was submitted. Try again or contact Sales for help.
        </p>
        <button
          type="button"
          onClick={reset}
          className="inline-flex min-h-11 items-center rounded-xl bg-primary-900 px-5 font-semibold text-white"
        >
          Try again
        </button>
      </div>
      <PartnerAccessHelp />
      <a
        href="/partners/login"
        className="inline-flex min-h-11 items-center font-semibold text-primary-900 underline"
      >
        Back to sign in
      </a>
    </section>
  );
}

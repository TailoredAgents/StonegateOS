import Link from "next/link";

const reasons: Record<string, string> = {
  app_missing: "The Square Point of Sale app did not open.",
  disabled: "Square Point of Sale is not ready to accept app handoff payments.",
  illegal_location_id:
    "Square Point of Sale is signed in to a different Stonegate location.",
  no_employee_logged_in:
    "No employee is signed in inside Square Point of Sale.",
  not_logged_in: "Square Point of Sale is not signed in.",
  user_id_mismatch:
    "Square Point of Sale is signed in to a different Stonegate location.",
  user_not_activated:
    "This Square account is not activated for card payments.",
  user_not_active:
    "This Square account is not activated for card payments.",
  user_not_logged_in: "Square Point of Sale is not signed in.",
};

export default async function SquareSetupPage({
  searchParams,
}: {
  searchParams?: Promise<{ reason?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const reason =
    typeof params.reason === "string"
      ? reasons[params.reason.trim().toLowerCase()]
      : null;

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-white">
      <div className="mx-auto max-w-xl space-y-4">
        <header className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-200">
            Square setup
          </p>
          <h1 className="mt-2 text-2xl font-semibold">
            Get Tap to Pay ready
          </h1>
          <p className="mt-2 text-sm leading-6 text-amber-100">
            {reason ??
              "Complete these checks before accepting a Stonegate payment."}
            {" "}No appointment has been marked paid.
          </p>
        </header>

        <ol className="space-y-3 text-sm leading-6">
          <li className="rounded-xl border border-white/10 bg-slate-900 p-4">
            <strong className="block text-cyan-100">
              1. Install or update Square Point of Sale
            </strong>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <a
                href="https://apps.apple.com/us/app/square-point-of-sale-pos/id335393788"
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-cyan-300/30 px-3 py-2 text-center font-semibold text-cyan-100"
              >
                iPhone
              </a>
              <a
                href="https://play.google.com/store/apps/details?id=com.squareup"
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-cyan-300/30 px-3 py-2 text-center font-semibold text-cyan-100"
              >
                Android
              </a>
            </div>
          </li>
          <li className="rounded-xl border border-white/10 bg-slate-900 p-4">
            <strong className="block text-cyan-100">
              2. Sign in with your own Square team access
            </strong>
            Open Square and select the Stonegate location your owner assigned.
            Do not use a device code for Tap to Pay on iPhone.
          </li>
          <li className="rounded-xl border border-white/10 bg-slate-900 p-4">
            <strong className="block text-cyan-100">
              3. Enable Tap to Pay and customer tipping
            </strong>
            Finish Square&apos;s Tap to Pay setup, turn on NFC on Android, and
            confirm tipping and digital receipts are enabled for this location.
          </li>
          <li className="rounded-xl border border-white/10 bg-slate-900 p-4">
            <strong className="block text-cyan-100">
              4. Return to the appointment and retry
            </strong>
            Keep both apps online. StonegateOS will verify the Square payment
            before it shows Paid.
          </li>
        </ol>

        <div className="grid grid-cols-2 gap-2">
          <Link
            href="/mobile?screen=myday"
            className="rounded-md bg-cyan-300 px-3 py-3 text-center text-sm font-semibold text-slate-950"
          >
            Return to Today
          </Link>
          <a
            href="https://squareup.com/help/us/en/article/7786-get-started-with-tap-to-pay-on-iphone"
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-white/15 bg-slate-900 px-3 py-3 text-center text-sm font-semibold text-slate-200"
          >
            Square help
          </a>
        </div>
      </div>
    </main>
  );
}

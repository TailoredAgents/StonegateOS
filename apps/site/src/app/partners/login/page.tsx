import { cookies } from "next/headers";
import Link from "next/link";
import { PARTNER_SESSION_COOKIE } from "@/lib/partner-session";
import { requestPartnerMagicLinkAction, partnerPasswordLoginAction } from "../actions";

export default async function PartnerLoginPage({
  searchParams
}: {
  searchParams?: Promise<{ sent?: string; error?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const jar = await cookies();
  const hasSession = Boolean(jar.get(PARTNER_SESSION_COOKIE)?.value);
  if (hasSession) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">You're already signed in.</h1>
        <p className="mt-2 text-sm text-slate-600">
          Go to the <Link className="text-primary-700 underline" href="/partners">Partner Portal</Link>.
        </p>
      </div>
    );
  }

  const sent = params.sent === "1";
  const error = typeof params.error === "string" && params.error.trim().length ? params.error.trim() : null;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">Sign in</h1>
        <p className="mt-1 text-sm text-slate-600">Get a secure login link by text or email.</p>
        {sent ? (
          <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            If you're invited, we'll text and/or email you a secure link.
          </div>
        ) : null}
        {error ? (
          <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {error}
          </div>
        ) : null}

        <form action={requestPartnerMagicLinkAction} className="mt-4 space-y-3">
          <label className="block">
            <div className="text-xs font-semibold text-slate-700">Email or phone</div>
            <input
              name="identifier"
              type="text"
              required
              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              placeholder="you@company.com or (404) 555-1234"
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-2xl bg-primary-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-primary-200/50 hover:bg-primary-700"
          >
            Send me a login link
          </button>
        </form>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h2 className="text-lg font-semibold text-slate-900">Password sign-in</h2>
        <p className="mt-1 text-sm text-slate-600">If you've set a password, you can sign in here.</p>
        <form action={partnerPasswordLoginAction} className="mt-4 space-y-3">
          <label className="block">
            <div className="text-xs font-semibold text-slate-700">Email</div>
            <input
              name="email"
              type="email"
              required
              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              placeholder="you@company.com"
            />
          </label>
          <label className="block">
            <div className="text-xs font-semibold text-slate-700">Password</div>
            <input
              name="password"
              type="password"
              required
              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm hover:border-primary-300 hover:text-primary-700"
          >
            Sign in with password
          </button>
        </form>
      </section>
    </div>
  );
}


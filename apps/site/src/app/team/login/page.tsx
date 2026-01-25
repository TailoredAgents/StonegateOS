import { cookies } from "next/headers";
import Link from "next/link";
import { TEAM_SESSION_COOKIE } from "@/lib/team-session";
import { requestTeamMagicLinkAction, teamPasswordLoginAction } from "./actions";
import { AdminLoginForm } from "../../admin/login/LoginForm";
import { CrewLoginForm } from "../../crew/login/LoginForm";

export default async function TeamLoginPage({
  searchParams
}: {
  searchParams?: Promise<{ sent?: string; error?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const jar = await cookies();
  const hasSession = Boolean(jar.get(TEAM_SESSION_COOKIE)?.value);
  if (hasSession) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">You're already signed in.</h1>
        <p className="mt-2 text-sm text-slate-600">
          Go to the <Link className="text-primary-700 underline" href="/team">Team Console</Link>.
        </p>
      </div>
    );
  }

  const sent = params.sent === "1";
  const error = typeof params.error === "string" && params.error.trim().length ? params.error.trim() : null;

  return (
    <div className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-2xl font-semibold text-slate-900">Stonegate Team Console</h1>
        <p className="mt-1 text-sm text-slate-600">Sign in with your work email (magic link) or password.</p>
        {sent ? (
          <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            If your email is on the team, you&apos;ll receive a secure login link shortly.
          </div>
        ) : null}
        {error ? (
          <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>
        ) : null}
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
          <h2 className="text-lg font-semibold text-slate-900">Magic link</h2>
          <p className="mt-1 text-sm text-slate-600">We&apos;ll email a secure link that signs you in.</p>
          <form action={requestTeamMagicLinkAction} className="mt-4 space-y-3">
            <label className="block">
              <div className="text-xs font-semibold text-slate-700">Work email</div>
              <input
                name="email"
                type="email"
                required
                className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                placeholder="you@stonegatejunkremoval.com"
              />
            </label>
            <button
              type="submit"
              className="w-full rounded-2xl bg-primary-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-primary-200/50 hover:bg-primary-700"
            >
              Send login link
            </button>
          </form>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
          <h2 className="text-lg font-semibold text-slate-900">Password sign-in</h2>
          <p className="mt-1 text-sm text-slate-600">If you&apos;ve set a password, sign in here.</p>
          <form action={teamPasswordLoginAction} className="mt-4 space-y-3">
            <label className="block">
              <div className="text-xs font-semibold text-slate-700">Email</div>
              <input
                name="email"
                type="email"
                required
                className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                placeholder="you@stonegatejunkremoval.com"
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

      <details className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">Emergency access</summary>
        <p className="mt-2 text-sm text-slate-600">
          Use these only if you can&apos;t access email or password sign-in. This uses the legacy owner/crew access keys.
        </p>
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <section className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
            <h3 className="text-sm font-semibold text-slate-900">Owner key</h3>
            <AdminLoginForm redirectTo="/team" />
          </section>
          <section className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
            <h3 className="text-sm font-semibold text-slate-900">Crew key</h3>
            <CrewLoginForm redirectTo="/team" />
          </section>
        </div>
      </details>
    </div>
  );
}

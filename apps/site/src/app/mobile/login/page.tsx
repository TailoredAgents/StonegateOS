import { redirect } from "next/navigation";
import { requestMobileMagicLinkAction, mobilePasswordLoginAction } from "./actions";
import { resolveMobileSessionFromCookies } from "../lib/session";

export default async function MobileLoginPage({
  searchParams
}: {
  searchParams?: Promise<{ sent?: string; error?: string }>;
}) {
  const session = await resolveMobileSessionFromCookies();
  if (session) {
    redirect("/mobile");
  }

  const params = (await searchParams) ?? {};
  const sent = params.sent === "1";
  const error = typeof params.error === "string" && params.error.trim().length ? params.error.trim() : null;

  return (
    <main className="min-h-dvh bg-slate-950 px-4 py-6 text-white">
      <div className="mx-auto flex min-h-[calc(100dvh-3rem)] w-full max-w-md flex-col justify-center">
        <div className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">StonegateOS Mobile</p>
          <h1 className="mt-3 text-3xl font-semibold leading-tight">Sign in to your phone workspace</h1>
          <p className="mt-2 text-sm leading-6 text-slate-300">Use your team account. Emergency owner and crew keys are not available in mobile.</p>
        </div>

        {sent ? (
          <div className="mb-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
            If your account exists, a secure mobile login link is on the way.
          </div>
        ) : null}
        {error ? (
          <div className="mb-4 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">{error}</div>
        ) : null}

        <section className="rounded-lg border border-white/10 bg-white/[0.08] p-4 shadow-2xl shadow-black/30">
          <h2 className="text-base font-semibold">Password</h2>
          <form action={mobilePasswordLoginAction} className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs font-semibold text-slate-300">Email</span>
              <input
                name="email"
                type="email"
                required
                className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                placeholder="you@stonegatejunkremoval.com"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-slate-300">Password</span>
              <input
                name="password"
                type="password"
                required
                className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
              />
            </label>
            <button type="submit" className="w-full rounded-md bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950">
              Sign in
            </button>
          </form>
        </section>

        <section className="mt-4 rounded-lg border border-white/10 bg-slate-900 p-4">
          <h2 className="text-base font-semibold">Magic link</h2>
          <form action={requestMobileMagicLinkAction} className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs font-semibold text-slate-300">Email or phone</span>
              <input
                name="identifier"
                type="text"
                required
                className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-3 text-base text-white outline-none focus:border-cyan-300"
                placeholder="Email or phone"
              />
            </label>
            <button type="submit" className="w-full rounded-md border border-white/10 px-4 py-3 text-sm font-semibold text-white">
              Send mobile link
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

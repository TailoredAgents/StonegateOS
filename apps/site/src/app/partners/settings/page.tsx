import Link from "next/link";
import { callPartnerApi } from "../lib/api";
import { partnerSetPasswordAction } from "../actions";

type MePayload = {
  ok: boolean;
  partnerUser?: { email: string; name: string; passwordSet?: boolean };
};

export default async function PartnerSettingsPage({
  searchParams
}: {
  searchParams?: Promise<{ saved?: string; error?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const saved = params.saved === "1";
  const error = typeof params.error === "string" && params.error.trim().length ? params.error.trim() : null;

  const res = await callPartnerApi("/api/portal/me");
  if (!res.ok) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">Settings</h1>
        <p className="mt-2 text-sm text-slate-600">
          Please <Link className="text-primary-700 underline" href="/partners/login">sign in</Link>.
        </p>
      </div>
    );
  }

  const payload = (await res.json().catch(() => null)) as MePayload | null;
  const passwordSet = Boolean(payload?.partnerUser?.passwordSet);

  return (
    <div className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-600">Optional: set a password for faster sign-in next time.</p>
        {saved ? (
          <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Password saved.
          </div>
        ) : null}
        {error ? (
          <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {error}
          </div>
        ) : null}
      </header>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Password</h2>
            <p className="mt-1 text-xs text-slate-500">{passwordSet ? "Password is set." : "No password set yet."}</p>
          </div>
        </div>
        <form action={partnerSetPasswordAction} className="mt-4 space-y-3">
          <label className="block">
            <div className="text-xs font-semibold text-slate-700">New password (min 10 chars)</div>
            <input
              name="password"
              type="password"
              required
              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
          </label>
          <button type="submit" className="rounded-2xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700">
            Save password
          </button>
        </form>
      </section>
    </div>
  );
}


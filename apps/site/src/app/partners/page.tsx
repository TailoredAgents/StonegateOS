import Link from "next/link";
import { callPartnerApi } from "./lib/api";

type MePayload = {
  ok: boolean;
  partnerUser?: { email: string; name: string; passwordSet?: boolean };
  org?: { company?: string | null; firstName?: string; lastName?: string; partnerStatus?: string | null } | null;
  error?: string;
};

export default async function PartnersHomePage({ searchParams }: { searchParams?: Promise<{ setup?: string }> }) {
  const params = (await searchParams) ?? {};
  const setup = params.setup === "1";

  const res = await callPartnerApi("/api/portal/me");
  if (!res.ok) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">Partner Portal</h1>
        <p className="mt-2 text-sm text-slate-600">Please sign in to continue.</p>
        <Link
          className="mt-4 inline-flex rounded-2xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700"
          href="/partners/login"
        >
          Sign in
        </Link>
      </div>
    );
  }

  const payload = (await res.json().catch(() => null)) as MePayload | null;
  const user = payload?.partnerUser;
  const orgLabel =
    payload?.org?.company?.trim() ||
    `${payload?.org?.firstName ?? ""} ${payload?.org?.lastName ?? ""}`.trim() ||
    "Partner";

  return (
    <div className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">{orgLabel}</h1>
        <p className="mt-1 text-sm text-slate-600">Signed in as {user?.name ?? user?.email ?? "partner"}.</p>
        {setup ? (
          <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Optional: set a password for faster sign-in next time.
            <Link className="ml-2 font-semibold underline" href="/partners/settings">
              Set password
            </Link>
          </div>
        ) : null}
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <Link
          href="/partners/book"
          className="rounded-3xl border border-slate-200 bg-white p-5 text-sm font-semibold text-slate-900 shadow-xl shadow-slate-200/50 hover:border-primary-300"
        >
          Book service
          <div className="mt-1 text-xs font-normal text-slate-600">Schedule a new job for a property.</div>
        </Link>
        <Link
          href="/partners/properties"
          className="rounded-3xl border border-slate-200 bg-white p-5 text-sm font-semibold text-slate-900 shadow-xl shadow-slate-200/50 hover:border-primary-300"
        >
          Manage properties
          <div className="mt-1 text-xs font-normal text-slate-600">Add and edit service addresses.</div>
        </Link>
        <Link
          href="/partners/bookings"
          className="rounded-3xl border border-slate-200 bg-white p-5 text-sm font-semibold text-slate-900 shadow-xl shadow-slate-200/50 hover:border-primary-300"
        >
          View bookings
          <div className="mt-1 text-xs font-normal text-slate-600">See upcoming scheduled service.</div>
        </Link>
      </div>
    </div>
  );
}


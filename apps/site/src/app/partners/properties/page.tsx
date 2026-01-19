import Link from "next/link";
import { callPartnerApi } from "../lib/api";
import { partnerCreatePropertyAction } from "../actions";

type PropertyRow = {
  id: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  gated: boolean;
};

export default async function PartnerPropertiesPage({
  searchParams
}: {
  searchParams?: Promise<{ created?: string; error?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const created = params.created === "1";
  const error = typeof params.error === "string" && params.error.trim().length ? params.error.trim() : null;

  const res = await callPartnerApi("/api/portal/properties");
  if (!res.ok) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">Properties</h1>
        <p className="mt-2 text-sm text-slate-600">
          Please <Link className="text-primary-700 underline" href="/partners/login">sign in</Link> to view properties.
        </p>
      </div>
    );
  }

  const payload = (await res.json().catch(() => null)) as { properties?: PropertyRow[] } | null;
  const properties = payload?.properties ?? [];

  return (
    <div className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">Properties</h1>
        <p className="mt-1 text-sm text-slate-600">Add and manage addresses you request service for.</p>
        {created ? (
          <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Property added.
          </div>
        ) : null}
        {error ? (
          <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {error}
          </div>
        ) : null}
      </header>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h2 className="text-base font-semibold text-slate-900">Add property</h2>
        <form action={partnerCreatePropertyAction} className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="md:col-span-2">
            <div className="text-xs font-semibold text-slate-700">Address line 1</div>
            <input name="addressLine1" required className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" />
          </label>
          <label className="md:col-span-2">
            <div className="text-xs font-semibold text-slate-700">Address line 2 (optional)</div>
            <input name="addressLine2" className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" />
          </label>
          <label>
            <div className="text-xs font-semibold text-slate-700">City</div>
            <input name="city" required className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" />
          </label>
          <label>
            <div className="text-xs font-semibold text-slate-700">State</div>
            <input name="state" required maxLength={2} className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm uppercase" />
          </label>
          <label>
            <div className="text-xs font-semibold text-slate-700">ZIP</div>
            <input name="postalCode" required className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" />
          </label>
          <label className="flex items-center gap-2 pt-6 text-sm text-slate-700">
            <input type="checkbox" name="gated" className="h-4 w-4 rounded border-slate-300" />
            Gated / access notes
          </label>
          <button type="submit" className="md:col-span-2 rounded-2xl bg-primary-600 px-4 py-3 text-sm font-semibold text-white hover:bg-primary-700">
            Add property
          </button>
        </form>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h2 className="text-base font-semibold text-slate-900">Your properties</h2>
        {properties.length === 0 ? (
          <div className="mt-3 text-sm text-slate-600">No properties yet.</div>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {properties.map((property) => (
              <li key={property.id} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="text-sm font-semibold text-slate-900">{property.addressLine1}</div>
                <div className="mt-1 text-xs text-slate-600">
                  {property.city}, {property.state} {property.postalCode}
                </div>
                <div className="mt-3">
                  <Link className="text-xs font-semibold text-primary-700 underline" href={`/partners/book?propertyId=${encodeURIComponent(property.id)}`}>
                    Book service for this property
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}


import Link from "next/link";
import { callPartnerApi } from "../lib/api";

type BookingRow = {
  id: string;
  appointmentId: string;
  serviceKey: string | null;
  tierKey: string | null;
  amountCents: number | null;
  createdAt: string;
  appointment: { startAt: string | null; durationMinutes: number; status: string };
  property: { addressLine1: string; city: string; state: string; postalCode: string } | null;
};

export default async function PartnerBookingsPage({
  searchParams
}: {
  searchParams?: Promise<{ created?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const created = params.created === "1";

  const res = await callPartnerApi("/api/portal/bookings");
  if (!res.ok) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">Bookings</h1>
        <p className="mt-2 text-sm text-slate-600">
          Please <Link className="text-primary-700 underline" href="/partners/login">sign in</Link> to view bookings.
        </p>
      </div>
    );
  }

  const payload = (await res.json().catch(() => null)) as { bookings?: BookingRow[] } | null;
  const bookings = payload?.bookings ?? [];

  return (
    <div className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">Bookings</h1>
        <p className="mt-1 text-sm text-slate-600">Your upcoming scheduled service.</p>
        {created ? (
          <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Booking created.
          </div>
        ) : null}
      </header>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        {bookings.length === 0 ? (
          <div className="text-sm text-slate-600">
            No bookings yet.{" "}
            <Link className="font-semibold text-primary-700 underline" href="/partners/book">
              Book service
            </Link>
            .
          </div>
        ) : (
          <ul className="space-y-3">
            {bookings.map((b) => (
              <li key={b.id} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-slate-900">
                    {b.property ? `${b.property.addressLine1}, ${b.property.city}, ${b.property.state} ${b.property.postalCode}` : "Booking"}
                  </div>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                    {b.appointment.status}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-600">
                  {b.appointment.startAt ? new Date(b.appointment.startAt).toLocaleString() : "TBD"} - {b.serviceKey ?? "service"}
                  {b.tierKey ? ` (${b.tierKey})` : ""}
                  {typeof b.amountCents === "number" ? ` - $${(b.amountCents / 100).toFixed(2)}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

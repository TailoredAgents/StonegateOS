import Link from "next/link";
import { availabilityWindows, serviceRates, weeklyAvailability } from "@myst-os/pricing";
import { callPartnerApi } from "../lib/api";
import { partnerCreateBookingAction } from "../actions";

const PARTNER_PORTAL_TIME_ZONE = "America/New_York";
const SERVICE_DAYS = new Set(weeklyAvailability.serviceDays.map((d) => d.toLowerCase()));

function ymdPartsInTimeZone(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PARTNER_PORTAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = Number(parts.find((p) => p.type === "year")?.value ?? "");
  const month = Number(parts.find((p) => p.type === "month")?.value ?? "");
  const day = Number(parts.find((p) => p.type === "day")?.value ?? "");

  return { year, month, day };
}

function formatYmdInTimeZone(date: Date): string {
  const { year, month, day } = ymdPartsInTimeZone(date);
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function weekdayKeyInTimeZone(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: PARTNER_PORTAL_TIME_ZONE, weekday: "long" })
    .format(date)
    .toLowerCase();
}

function computeNextServiceDayYmd(): string {
  const now = new Date();
  const { year, month, day } = ymdPartsInTimeZone(now);
  const utcNoonLocalDay = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  const dayMs = 24 * 60 * 60 * 1000;
  for (let offset = 1; offset <= 14; offset += 1) {
    const candidate = new Date(utcNoonLocalDay.getTime() + offset * dayMs);
    const weekdayKey = weekdayKeyInTimeZone(candidate);
    if (SERVICE_DAYS.has(weekdayKey)) {
      return formatYmdInTimeZone(candidate);
    }
  }

  const tomorrow = new Date(utcNoonLocalDay.getTime() + dayMs);
  return formatYmdInTimeZone(tomorrow);
}

type PropertyRow = {
  id: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
};

type RateItemRow = {
  id: string;
  serviceKey: string;
  tierKey: string;
  label: string | null;
  amountCents: number;
  sortOrder: number;
};

export default async function PartnerBookPage({
  searchParams
}: {
  searchParams?: Promise<{ propertyId?: string; serviceKey?: string; rescheduleFrom?: string; error?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const propertyId = typeof params.propertyId === "string" ? params.propertyId.trim() : "";
  const serviceKeyParam = typeof params.serviceKey === "string" ? params.serviceKey.trim().toLowerCase() : "";
  const rescheduleFrom = typeof params.rescheduleFrom === "string" ? params.rescheduleFrom.trim() : "";
  const error = typeof params.error === "string" && params.error.trim().length ? params.error.trim() : null;

  const [propertiesRes, ratesRes] = await Promise.all([
    callPartnerApi("/api/portal/properties"),
    callPartnerApi("/api/portal/rates")
  ]);

  if (!propertiesRes.ok) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">Book service</h1>
        <p className="mt-2 text-sm text-slate-600">
          Please <Link className="text-primary-700 underline" href="/partners/login">sign in</Link> to book.
        </p>
      </div>
    );
  }

  const propertiesPayload = (await propertiesRes.json().catch(() => null)) as { properties?: PropertyRow[] } | null;
  const properties = propertiesPayload?.properties ?? [];

  const ratesPayload = ratesRes.ok
    ? ((await ratesRes.json().catch(() => null)) as { currency?: string; items?: RateItemRow[] } | null)
    : null;
  const rateItems = ratesPayload?.items ?? [];

  const validWindows = availabilityWindows.filter(
    (w) => w.startHour >= weeklyAvailability.startHour && w.endHour <= weeklyAvailability.endHour
  );
  const tomorrow = computeNextServiceDayYmd();

  const services = serviceRates
    .map((r) => ({ service: r.service.toLowerCase(), label: r.label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const serviceKey =
    serviceKeyParam.length > 0
      ? serviceKeyParam
      : services.some((s) => s.service === "junk-removal")
        ? "junk-removal"
        : "";

  const selectedProperty = properties.find((p) => p.id === propertyId) ?? null;
  const selectedService = services.find((s) => s.service === serviceKey) ?? null;

  const tiersForService = selectedService
    ? rateItems
        .filter((i) => i.serviceKey.toLowerCase() === selectedService.service)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    : [];

  return (
    <div className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
        <h1 className="text-xl font-semibold text-slate-900">Book service</h1>
        <p className="mt-1 text-sm text-slate-600">Bookings start next service day. Same-day requires calling.</p>
        {rescheduleFrom ? (
          <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Rescheduling: once you confirm, we'll cancel your previous booking.
          </div>
        ) : null}
        {error ? (
          <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {error}
          </div>
        ) : null}
      </header>

      {properties.length === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
          <h2 className="text-base font-semibold text-slate-900">Add a property first</h2>
          <p className="mt-1 text-sm text-slate-600">You'll need at least one address to request service for.</p>
          <Link className="mt-4 inline-flex rounded-2xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700" href="/partners/properties">
            Add property
          </Link>
        </div>
      ) : (
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
          <h2 className="text-base font-semibold text-slate-900">Step 1 - Select property + service</h2>
          <form method="get" action="/partners/book" className="mt-4 grid gap-3 md:grid-cols-2">
            <label>
              <div className="text-xs font-semibold text-slate-700">Property</div>
              <select name="propertyId" defaultValue={selectedProperty?.id ?? ""} className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
                <option value="">Choose...</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.addressLine1} - {p.city}, {p.state}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <div className="text-xs font-semibold text-slate-700">Service</div>
              <select name="serviceKey" defaultValue={selectedService?.service ?? ""} className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
                <option value="">Choose...</option>
                {services.map((s) => (
                  <option key={s.service} value={s.service}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="md:col-span-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700">
              Continue
            </button>
          </form>

          {selectedProperty && selectedService ? (
            <div className="mt-6 border-t border-slate-100 pt-6">
              <h2 className="text-base font-semibold text-slate-900">Step 2 - Choose time</h2>
              <form action={partnerCreateBookingAction} className="mt-4 grid gap-3 md:grid-cols-2">
                <input type="hidden" name="propertyId" value={selectedProperty.id} />
                <input type="hidden" name="serviceKey" value={selectedService.service} />
                {rescheduleFrom ? <input type="hidden" name="rescheduleFromAppointmentId" value={rescheduleFrom} /> : null}

                <label>
                  <div className="text-xs font-semibold text-slate-700">Rate tier (optional)</div>
                  <select name="tierKey" defaultValue="" className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
                    <option value="">Call for pricing / use standard rate</option>
                    {tiersForService.map((tier) => (
                      <option key={tier.id} value={tier.tierKey}>
                        {tier.label ? `${tier.label} - $${(tier.amountCents / 100).toFixed(2)}` : `${tier.tierKey} - $${(tier.amountCents / 100).toFixed(2)}`}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <div className="text-xs font-semibold text-slate-700">Date</div>
                  <input name="preferredDate" type="date" min={tomorrow} required className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" />
                </label>

                <label className="md:col-span-2">
                  <div className="text-xs font-semibold text-slate-700">Time window</div>
                  <select name="timeWindowId" required className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
                    {validWindows.map((w) => (
                      <option key={w.id} value={w.id}>
                        {typeof (w as unknown as { label?: unknown }).label === "string" ? String((w as unknown as { label?: unknown }).label) : w.id} ({w.startHour}:00-{w.endHour}:00)
                      </option>
                    ))}
                  </select>
                </label>

                <label className="md:col-span-2">
                  <div className="text-xs font-semibold text-slate-700">Notes (optional)</div>
                  <textarea name="notes" className="mt-1 min-h-[120px] w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" placeholder="Any access notes, item list, parking instructions, etc." />
                </label>

                <button type="submit" className="md:col-span-2 rounded-2xl bg-primary-600 px-4 py-3 text-sm font-semibold text-white hover:bg-primary-700">
                  Confirm booking
                </button>
              </form>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";
const ADMIN_API_KEY = process.env["ADMIN_API_KEY"];

type AppointmentStatus = "requested" | "confirmed" | "completed" | "no_show" | "canceled";

interface AppointmentResponse {
  id: string;
  status: AppointmentStatus;
  startAt: string | null;
  durationMinutes: number | null;
  services: string[];
  rescheduleToken: string;
  contact: {
    id: string | null;
    name: string;
    email: string | null;
    phone: string | null;
    phoneE164: string | null;
  };
  property: {
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
  };
  notes: Array<{
    id: string;
    body: string;
    createdAt: string;
  }>;
}

interface AppointmentListPayload {
  appointments: AppointmentResponse[];
}

interface PaymentsSummaryPayload {
  payments: Array<unknown>;
  summary?: {
    total: number;
    matched: number;
    unmatched: number;
  };
}

async function callAdminApi(path: string, init?: RequestInit): Promise<Response> {
  if (!ADMIN_API_KEY) {
    throw new Error("ADMIN_API_KEY must be set to use the Owner Hub.");
  }

  const base = API_BASE_URL.replace(/\/$/, "");
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ADMIN_API_KEY,
      ...(init?.headers ?? {})
    },
    cache: "no-store"
  });
}

function formatDateTime(iso: string | null) {
  if (!iso) {
    return "TBD";
  }
  const date = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatShortTime(iso: string | null) {
  if (!iso) {
    return "TBD";
  }
  const date = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function servicesLabel(services: string[]) {
  if (!services.length) {
    return "Exterior cleaning";
  }
  if (services.length === 1) {
    return services[0];
  }
  return `${services[0]} +${services.length - 1}`;
}

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
  completed: "Completed",
  no_show: "No-show",
  canceled: "Canceled"
};

const STATUS_COLORS: Record<AppointmentStatus, string> = {
  requested: "bg-amber-100 text-amber-700 border-amber-200",
  confirmed: "bg-emerald-100 text-emerald-700 border-emerald-200",
  completed: "bg-blue-100 text-blue-700 border-blue-200",
  no_show: "bg-rose-100 text-rose-700 border-rose-200",
  canceled: "bg-neutral-200 text-neutral-600 border-neutral-300"
};

const NEXT_STATUS_OPTIONS: Partial<Record<AppointmentStatus, AppointmentStatus[]>> = {
  requested: ["confirmed", "canceled"],
  confirmed: ["completed", "no_show", "canceled"],
  no_show: ["confirmed", "canceled"],
  completed: [],
  canceled: []
};

export async function updateStatusAction(formData: FormData) {
  "use server";

  const appointmentId = formData.get("appointmentId");
  const status = formData.get("status");

  if (typeof appointmentId !== "string" || typeof status !== "string") {
    return;
  }

  const response = await callAdminApi(`/api/appointments/${appointmentId}/status`, {
    method: "POST",
    body: JSON.stringify({ status })
  });

  if (!response.ok) {
    console.warn("[owner-hub] status.update_failed", {
      appointmentId,
      status,
      statusCode: response.status
    });
  }

  revalidatePath("/");
}

function summarizeByStatus(appointments: AppointmentResponse[]): Record<AppointmentStatus, number> {
  const initial: Record<AppointmentStatus, number> = {
    requested: 0,
    confirmed: 0,
    completed: 0,
    no_show: 0,
    canceled: 0
  };

  return appointments.reduce((acc, appointment) => {
    acc[appointment.status] += 1;
    return acc;
  }, initial);
}

function isToday(iso: string | null) {
  if (!iso) {
    return false;
  }
  const date = new Date(iso);
  const today = new Date();
  return (
    date.getUTCFullYear() === today.getUTCFullYear() &&
    date.getUTCMonth() === today.getUTCMonth() &&
    date.getUTCDate() === today.getUTCDate()
  );
}

function groupByStatus(appointments: AppointmentResponse[]) {
  const groups: Record<AppointmentStatus, AppointmentResponse[]> = {
    requested: [],
    confirmed: [],
    completed: [],
    no_show: [],
    canceled: []
  };

  for (const appointment of appointments) {
    groups[appointment.status].push(appointment);
  }

  return groups;
}

function buildRescheduleLink(id: string, token: string) {
  const url = new URL("/schedule", process.env["NEXT_PUBLIC_SITE_URL"] ?? "http://localhost:3000");
  url.searchParams.set("appointmentId", id);
  url.searchParams.set("token", token);
  return url.toString();
}

export default async function OwnerHubPage() {
  if (!ADMIN_API_KEY) {
    notFound();
  }

  const [appointmentsResponse, paymentsResponse] = await Promise.all([
    callAdminApi("/api/appointments?status=all"),
    callAdminApi("/api/payments?status=all")
  ]);

  if (!appointmentsResponse.ok) {
    throw new Error("Unable to load appointments");
  }
  if (!paymentsResponse.ok) {
    throw new Error("Unable to load payments summary");
  }

  const appointmentsPayload = (await appointmentsResponse.json()) as AppointmentListPayload;
  const paymentsPayload = (await paymentsResponse.json()) as PaymentsSummaryPayload;

  const appointments = appointmentsPayload.appointments ?? [];
  const summaryCounts = summarizeByStatus(appointments);
  const grouped = groupByStatus(appointments);
  const todaysAppointments = appointments.filter((appointment) => isToday(appointment.startAt));

  const unmatchedPayments = paymentsPayload.summary?.unmatched ?? 0;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-primary-900">Owner Hub</h1>
          <p className="text-sm text-neutral-600">
            Daily schedule, crew readiness, and quick actions for Stonegate Junk Removal.
          </p>
        </div>
        <div className="flex items-center gap-4 rounded-lg border border-neutral-200 bg-white px-4 py-2 shadow-sm">
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Unmatched payments</span>
          <span
            className={`rounded-full px-3 py-1 text-sm font-semibold ${
              unmatchedPayments > 0 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
            }`}
          >
            {unmatchedPayments}
          </span>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {(Object.keys(summaryCounts) as AppointmentStatus[]).map((status) => (
          <div key={status} className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">
              {STATUS_LABEL[status]}
            </p>
            <p className="mt-2 text-3xl font-semibold text-primary-900">{summaryCounts[status]}</p>
          </div>
        ))}
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-xl font-semibold text-primary-900">Today&apos;s schedule</h2>
          <p className="text-sm text-neutral-500">
            {todaysAppointments.length
              ? `${todaysAppointments.length} onsite visit${todaysAppointments.length === 1 ? "" : "s"} scheduled today.`
              : "No confirmed estimates today yet. Pending requests are listed below."}
          </p>
        </div>
        <div className="mt-4 space-y-3">
          {todaysAppointments.length ? (
            todaysAppointments.map((appointment) => (
              <article
                key={appointment.id}
                className="flex flex-col gap-3 rounded-lg border border-neutral-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm text-neutral-500">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[appointment.status]}`}
                    >
                      {STATUS_LABEL[appointment.status]}
                    </span>
                    <span>{formatShortTime(appointment.startAt)}</span>
                    <span>•</span>
                    <span>{servicesLabel(appointment.services)}</span>
                  </div>
                  <h3 className="text-lg font-semibold text-primary-900">{appointment.contact.name}</h3>
                  <p className="text-sm text-neutral-600">
                    {appointment.property.addressLine1}, {appointment.property.city}, {appointment.property.state}{" "}
                    {appointment.property.postalCode}
                  </p>
                  {appointment.contact.phoneE164 ? (
                    <p className="text-xs text-neutral-500">Phone: {appointment.contact.phoneE164}</p>
                  ) : null}
                  {appointment.notes.length ? (
                    <div className="rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
                      <p className="font-medium text-neutral-700">Internal notes</p>
                      <ul className="mt-1 space-y-1">
                        {appointment.notes.slice(0, 2).map((note) => (
                          <li key={note.id} className="line-clamp-2">
                            {note.body}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {NEXT_STATUS_OPTIONS[appointment.status]?.map((nextStatus) => (
                    <form key={nextStatus} action={updateStatusAction}>
                      <input type="hidden" name="appointmentId" value={appointment.id} />
                      <input type="hidden" name="status" value={nextStatus} />
                      <button className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100">
                        Mark {STATUS_LABEL[nextStatus]}
                      </button>
                    </form>
                  ))}
                  <a
                    href={buildRescheduleLink(appointment.id, appointment.rescheduleToken)}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-accent-400 bg-accent-50 px-3 py-1 text-xs font-medium text-accent-700 hover:bg-accent-100"
                  >
                    Reschedule link
                  </a>
                </div>
              </article>
            ))
          ) : (
            <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-500">
              No confirmed visits on the books today. Review pending requests below to fill the schedule.
            </p>
          )}
        </div>
      </section>

      <section className="space-y-6">
        {(Object.keys(grouped) as AppointmentStatus[]).map((status) => (
          <div key={status} className="rounded-lg border border-neutral-200 bg-white shadow-sm">
            <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
              <div>
                <h3 className="text-lg font-semibold text-primary-900">{STATUS_LABEL[status]}</h3>
                <p className="text-xs text-neutral-500">
                  {grouped[status].length} appointment{grouped[status].length === 1 ? "" : "s"}.
                </p>
              </div>
            </header>
            {grouped[status].length ? (
              <ul className="divide-y divide-neutral-200">
                {grouped[status].map((appointment) => (
                  <li key={appointment.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <p className="text-sm text-neutral-500">{formatDateTime(appointment.startAt)}</p>
                      <p className="text-base font-semibold text-primary-900">{appointment.contact.name}</p>
                      <p className="text-sm text-neutral-600">
                        {appointment.property.addressLine1}, {appointment.property.city}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {NEXT_STATUS_OPTIONS[appointment.status]?.map((nextStatus) => (
                        <form key={nextStatus} action={updateStatusAction}>
                          <input type="hidden" name="appointmentId" value={appointment.id} />
                          <input type="hidden" name="status" value={nextStatus} />
                          <button className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100">
                            Mark {STATUS_LABEL[nextStatus]}
                          </button>
                        </form>
                      ))}
                      <a
                        href={buildRescheduleLink(appointment.id, appointment.rescheduleToken)}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-md border border-accent-400 bg-accent-50 px-3 py-1 text-xs font-medium text-accent-700 hover:bg-accent-100"
                      >
                        Reschedule
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-6 text-sm text-neutral-500">Nothing in this lane right now.</p>
            )}
          </div>
        ))}
      </section>
    </main>
  );
}


import { RescheduleForm } from "./RescheduleForm";
import { CalendarDays } from "lucide-react";

export const metadata = {
  title: "Reschedule your visit",
  robots: { index: false, follow: false },
};

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{
    appointmentId?: string;
    token?: string;
    next?: string;
  }>;
}) {
  const params = await searchParams;
  const appointmentId = params?.appointmentId ?? "";
  const token = params?.token ?? "";
  const next = params?.next;

  const missing = !appointmentId || !token;

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 px-4 py-16">
      <div className="space-y-2 text-center">
        <div className="public-schedule-icon">
          <CalendarDays size={30} strokeWidth={1.5} aria-hidden="true" />
        </div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">
          Stonegate Scheduling
        </p>
        <h1 className="font-display text-4xl text-primary-900">
          Reschedule your visit
        </h1>
        <p className="text-sm text-neutral-600">
          Pick a new date and time window that works for you.
        </p>
      </div>

      {missing ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-rose-800">
          Missing appointment details. Please use the link we sent you.
        </div>
      ) : (
        <RescheduleForm
          appointmentId={appointmentId}
          token={token}
          next={next}
        />
      )}
    </main>
  );
}

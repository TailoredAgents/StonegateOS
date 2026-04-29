type CalendarEventToneInput = {
  source: "db" | "google";
  appointmentType?: string | null;
  status?: string | null;
};

type CalendarEventTone = "confirmed" | "quote" | "canceled" | "external" | "default";

export function getCalendarEventTone(event: CalendarEventToneInput): CalendarEventTone {
  const status = normalize(event.status);
  if (status === "canceled" || status === "cancelled") return "canceled";
  if (event.source !== "db") return "external";
  if (normalize(event.appointmentType) === "in_person_quote") return "quote";
  if (status === "confirmed") return "confirmed";
  return "default";
}

export function getCalendarEventSurfaceClass(event: CalendarEventToneInput): string {
  switch (getCalendarEventTone(event)) {
    case "confirmed":
      return "border-emerald-300 bg-emerald-50/85 hover:border-emerald-400 hover:bg-emerald-100/70";
    case "quote":
      return "border-sky-300 bg-sky-50/85 hover:border-sky-400 hover:bg-sky-100/70";
    case "canceled":
      return "border-rose-300 bg-rose-50/85 hover:border-rose-400 hover:bg-rose-100/70";
    case "external":
      return "border-slate-200 bg-slate-50 hover:border-slate-300";
    default:
      return "border-slate-200 bg-white hover:bg-slate-50";
  }
}

export function getCalendarEventDotClass(event: CalendarEventToneInput): string {
  switch (getCalendarEventTone(event)) {
    case "confirmed":
      return "bg-emerald-500";
    case "quote":
      return "bg-sky-500";
    case "canceled":
      return "bg-rose-500";
    case "external":
      return "bg-slate-400";
    default:
      return "bg-slate-500";
  }
}

export function getCalendarEventBadgeClass(event: CalendarEventToneInput): string {
  switch (getCalendarEventTone(event)) {
    case "confirmed":
      return "bg-emerald-100 text-emerald-800";
    case "quote":
      return "bg-sky-100 text-sky-800";
    case "canceled":
      return "bg-rose-100 text-rose-800";
    case "external":
      return "bg-slate-100 text-slate-700";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

export function getCalendarEventSelectedRingClass(event: CalendarEventToneInput): string {
  switch (getCalendarEventTone(event)) {
    case "confirmed":
      return "ring-2 ring-emerald-300";
    case "quote":
      return "ring-2 ring-sky-300";
    case "canceled":
      return "ring-2 ring-rose-300";
    default:
      return "ring-2 ring-primary-200";
  }
}

function normalize(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

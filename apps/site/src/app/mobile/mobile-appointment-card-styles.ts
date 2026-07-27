export type AppointmentCardStatusTone =
  | "default"
  | "requested"
  | "confirmed"
  | "completed"
  | "quote"
  | "canceled";

export function appointmentCardStatusClassName(
  tone: AppointmentCardStatusTone,
): string {
  if (tone === "canceled") {
    return "bg-rose-300/10 text-rose-100 ring-1 ring-inset ring-rose-300/30";
  }
  if (tone === "completed") {
    return "bg-emerald-300/10 text-emerald-100 ring-1 ring-inset ring-emerald-300/30";
  }
  if (tone === "confirmed") {
    return "bg-emerald-300/10 text-emerald-100 ring-1 ring-inset ring-emerald-300/30";
  }
  if (tone === "requested") {
    return "bg-amber-300/10 text-amber-100 ring-1 ring-inset ring-amber-300/30";
  }
  if (tone === "quote") {
    return "bg-sky-300/10 text-sky-100 ring-1 ring-inset ring-sky-300/30";
  }
  return "bg-slate-800 text-slate-200 ring-1 ring-inset ring-white/10";
}

export function appointmentCardSurfaceClassName(
  tone: AppointmentCardStatusTone,
): string {
  if (tone === "canceled") {
    return "border-rose-300/30 bg-rose-300/10";
  }
  if (tone === "quote") {
    return "border-sky-300/30 bg-sky-300/10";
  }
  if (tone === "confirmed" || tone === "completed") {
    return "border-emerald-300/30 bg-emerald-300/10";
  }
  if (tone === "requested") {
    return "border-amber-300/30 bg-amber-300/10";
  }
  return "border-white/10 bg-slate-900/90";
}

export function appointmentCardTimeClassName(
  tone: AppointmentCardStatusTone,
): string {
  if (tone === "canceled") return "text-rose-100";
  if (tone === "quote") return "text-sky-100";
  if (tone === "confirmed" || tone === "completed") return "text-emerald-100";
  if (tone === "requested") return "text-amber-100";
  return "text-cyan-200";
}

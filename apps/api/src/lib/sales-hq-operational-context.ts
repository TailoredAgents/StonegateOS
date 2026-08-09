export type SalesHqSlaContext = {
  state: "overdue" | "due_soon" | "on_track" | "unscheduled";
  label: string;
};

export function buildSalesHqSlaContext(item: {
  dueAt: string | null;
  overdue: boolean;
  minutesUntilDue: number | null;
}): SalesHqSlaContext {
  if (!item.dueAt || item.minutesUntilDue === null) {
    return { state: "unscheduled", label: "No SLA deadline" };
  }
  const absoluteMinutes = Math.abs(item.minutesUntilDue);
  const duration =
    absoluteMinutes < 1
      ? "less than a minute"
      : `${absoluteMinutes} minute${absoluteMinutes === 1 ? "" : "s"}`;
  if (item.overdue) {
    return { state: "overdue", label: `Overdue by ${duration}` };
  }
  if (item.minutesUntilDue <= 15) {
    return { state: "due_soon", label: `Due in ${duration}` };
  }
  return { state: "on_track", label: `Due in ${duration}` };
}

export function salesHqAutomationModeLabel(
  mode: "off" | "partial" | "full",
): "Off" | "Assist" | "Automatic" {
  if (mode === "full") return "Automatic";
  if (mode === "partial") return "Assist";
  return "Off";
}

export function salesHqDraftAgeMinutes(
  createdAt: Date | null,
  now: Date,
): number | null {
  if (!createdAt) return null;
  return Math.max(
    0,
    Math.floor((now.getTime() - createdAt.getTime()) / 60_000),
  );
}

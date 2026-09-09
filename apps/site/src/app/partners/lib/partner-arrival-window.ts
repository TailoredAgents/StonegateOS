export function formatPartnerArrivalWindow(
  window:
    | {
        startAt: string;
        endAt: string;
        timezone: string;
      }
    | null
    | undefined,
): string {
  if (!window) return "Time to be confirmed";
  const start = new Date(window.startAt);
  const end = new Date(window.endAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()))
    return "Time to be confirmed";
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timezone,
    dateStyle: "medium",
  });
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timezone,
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date.format(start)}, ${time.format(start)}–${time.format(end)}`;
}

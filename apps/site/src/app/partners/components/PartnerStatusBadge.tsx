function normalizeStatus(status: string): string {
  return status
    .trim()
    .replace(/[_-]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function PartnerStatusBadge({ status }: { status: string }) {
  const normalized = status.trim().toLowerCase();
  const tone = [
    "completed",
    "confirmed",
    "paid",
    "accepted",
    "approved",
  ].includes(normalized)
    ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
    : [
          "canceled",
          "cancelled",
          "declined",
          "failed",
          "overdue",
          "void",
        ].includes(normalized)
      ? "bg-rose-50 text-rose-800 ring-rose-200"
      : [
            "approval_needed",
            "needs_information",
            "requested",
            "requested_review",
            "review",
            "under_review",
          ].includes(normalized)
        ? "bg-amber-50 text-amber-900 ring-amber-200"
        : [
              "en_route",
              "in_progress",
              "issued",
              "partially_paid",
              "pending",
              "scheduled",
            ].includes(normalized)
          ? "bg-sky-50 text-sky-800 ring-sky-200"
          : "bg-slate-100 text-slate-700 ring-slate-200";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${tone}`}
    >
      {normalizeStatus(status || "Unknown")}
    </span>
  );
}

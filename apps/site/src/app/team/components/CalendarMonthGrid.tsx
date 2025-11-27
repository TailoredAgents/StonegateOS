import React from "react";

type CalendarEvent = {
  id: string;
  title: string;
  source: "db" | "google";
  start: string;
  end: string;
  contactName?: string | null;
  address?: string | null;
  status?: string | null;
};

type Props = {
  events: CalendarEvent[];
  conflicts: Array<{ a: string; b: string }>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function CalendarMonthGrid({ events, conflicts }: Props): React.ReactElement {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();

  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay(); // 0 Sunday
  const startDate = new Date(firstOfMonth);
  startDate.setDate(firstOfMonth.getDate() - startOffset);
  const cells = Array.from({ length: 42 }).map((_, i) => new Date(startDate.getTime() + i * DAY_MS));

  const buckets = new Map<string, CalendarEvent[]>();
  for (const cell of cells) {
    buckets.set(cell.toISOString().slice(0, 10), []);
  }
  for (const evt of events) {
    const key = new Date(evt.start).toISOString().slice(0, 10);
    if (buckets.has(key)) {
      buckets.get(key)!.push(evt);
    }
  }

  const isConflict = (id: string) => conflicts.some((c) => c.a === id || c.b === id);

  return (
    <div className="grid grid-cols-7 gap-2 text-sm">
      {cells.map((day, idx) => {
        const key = day.toISOString().slice(0, 10);
        const inMonth = day.getMonth() === month;
        const bucket = buckets.get(key) ?? [];
        return (
          <div
            key={key + idx}
            className={`min-h-[120px] rounded-xl border p-2 ${inMonth ? "border-slate-200 bg-white/90" : "border-slate-100 bg-slate-50"}`}
          >
            <div className="mb-1 text-[11px] font-semibold uppercase text-slate-500">
              {day.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
            </div>
            <div className="space-y-1">
              {bucket.length === 0 ? (
                <p className="text-[11px] text-slate-400">-</p>
              ) : (
                bucket
                  .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
                  .map((evt) => (
                    <div
                      key={evt.id}
                      className={`rounded border px-1 py-0.5 text-[11px] ${
                        evt.source === "db" ? "border-primary-200 bg-primary-50/70" : "border-slate-200 bg-slate-100"
                      } ${isConflict(evt.id) ? "ring-2 ring-rose-300" : ""}`}
                    >
                      <span className="font-semibold text-slate-800">{formatTime(evt.start)}</span>{" "}
                      <span className="text-slate-700">{evt.title}</span>
                      {evt.status ? <span className="ml-1 rounded bg-white px-1 text-[10px] uppercase text-primary-700">{evt.status}</span> : null}
                    </div>
                  ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

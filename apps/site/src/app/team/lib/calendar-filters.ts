export type CalendarFilterEvent = {
  id: string;
  source: "db" | "google";
  status?: string | null;
  crewMemberIds?: string[];
};

export type CalendarFilters = {
  status: string | null;
  crewMemberId: string | null;
  source: "db" | "google" | null;
  conflictsOnly: boolean;
};

const SAFE_FILTER_VALUE = /^[A-Za-z0-9_-]{1,80}$/u;

function safeValue(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return SAFE_FILTER_VALUE.test(normalized) ? normalized : null;
}

export function parseCalendarFilters(input: {
  status?: string | null;
  crew?: string | null;
  source?: string | null;
  conflict?: string | null;
}): CalendarFilters {
  const sourceValue = safeValue(input.source);
  return {
    status: safeValue(input.status),
    crewMemberId: safeValue(input.crew),
    source:
      sourceValue === "db" || sourceValue === "google" ? sourceValue : null,
    conflictsOnly: input.conflict === "only",
  };
}

export function countActiveCalendarFilters(filters: CalendarFilters): number {
  return [
    filters.status,
    filters.crewMemberId,
    filters.source,
    filters.conflictsOnly ? "only" : null,
  ].filter(Boolean).length;
}

export function filterCalendarEvents<T extends CalendarFilterEvent>(
  events: T[],
  conflictIds: ReadonlySet<string>,
  filters: CalendarFilters,
): T[] {
  return events.filter((event) => {
    const status = event.status?.trim().toLowerCase() ?? "";
    if (filters.status && status !== filters.status.toLowerCase()) return false;
    if (filters.source && event.source !== filters.source) return false;
    if (
      filters.crewMemberId &&
      !event.crewMemberIds?.includes(filters.crewMemberId)
    ) {
      return false;
    }
    if (filters.conflictsOnly && !conflictIds.has(event.id)) return false;
    return true;
  });
}

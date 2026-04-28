import { formatDayKey, TEAM_TIME_ZONE } from "../../team/lib/timezone";
import { callAdminApi } from "../../team/lib/api";

type CalendarEvent = {
  id: string;
  title: string;
  source: "db" | "google";
  start: string;
  appointmentId?: string;
  appointmentType?: string | null;
  contactName?: string | null;
  address?: string | null;
  status?: string | null;
  quotedTotalCents?: number | null;
  finalTotalCents?: number | null;
};

type CalendarFeedResponse = {
  appointments?: CalendarEvent[];
  externalEvents?: CalendarEvent[];
};

type RevenueForecastResponse = {
  ok?: boolean;
  totalCents?: number;
  count?: number;
  currency?: string | null;
};

type TasksResponse = {
  tasks?: Array<{
    id: string;
    title: string;
    dueAt: string | null;
    status: string;
  }>;
};

type ThreadsResponse = {
  threads?: Array<{
    id: string;
    subject: string | null;
    lastMessagePreview: string | null;
    lastMessageAt: string | null;
    contact: { name: string; phone: string | null; email: string | null } | null;
  }>;
};

type SystemHealthResponse = {
  ok?: boolean;
  blockers?: Array<{ id: string; title: string; detail: string }>;
  warnings?: Array<{ id: string; title: string; detail: string }>;
  providers?: Array<{
    provider: string;
    status: "healthy" | "degraded" | "unknown";
    lastFailureDetail: string | null;
  }>;
};

export type MobileOwnerSummary = {
  generatedAt: string;
  todayKey: string;
  collectedTodayCents: number;
  collectedTodayCount: number;
  projectedTodayCents: number;
  bookedJobsToday: number;
  openInboxLeads: number;
  openFollowUps: number;
  health: {
    blockers: number;
    warnings: number;
    providers: Array<{
      provider: string;
      status: "healthy" | "degraded" | "unknown";
      detail: string | null;
    }>;
  };
  nextAppointments: Array<{
    id: string;
    title: string;
    time: string;
    contactName: string | null;
    address: string | null;
    status: string | null;
    projectedCents: number;
  }>;
  inboxLeads: Array<{
    id: string;
    contactName: string;
    preview: string;
    lastMessageAt: string | null;
  }>;
  followUps: Array<{
    id: string;
    title: string;
    dueAt: string | null;
  }>;
};

async function readJson<T>(path: string): Promise<T | null> {
  const response = await callAdminApi(path, { method: "GET" });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as T | null;
}

function parseDayKey(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date();
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0));
}

function normalizeCents(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeCentsOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function projectedEventCents(event: CalendarEvent): number {
  if (event.source !== "db") return 0;
  const status = (event.status ?? "").trim().toLowerCase();
  if (status === "canceled" || status === "cancelled" || status === "no_show") return 0;
  const type = (event.appointmentType ?? "").trim().toLowerCase();
  if (type === "in_person_quote" || type === "in_person_estimate") return 0;
  return normalizeCentsOrNull(event.finalTotalCents) ?? normalizeCentsOrNull(event.quotedTotalCents) ?? 0;
}

function isDueTodayOrEarlier(value: string | null, todayKey: string): boolean {
  if (!value) return true;
  return formatDayKey(new Date(value)) <= todayKey;
}

export async function loadMobileOwnerSummary(): Promise<MobileOwnerSummary> {
  const todayKey = formatDayKey(new Date());
  const start = parseDayKey(todayKey);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 2);

  const [forecast, calendar, tasks, inbox, health] = await Promise.all([
    readJson<RevenueForecastResponse>("/api/admin/revenue/forecast?range=today"),
    readJson<CalendarFeedResponse>(
      `/api/admin/calendar/feed?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`
    ),
    readJson<TasksResponse>("/api/admin/crm/tasks?status=open"),
    readJson<ThreadsResponse>("/api/admin/inbox/threads?status=open&limit=10"),
    readJson<SystemHealthResponse>("/api/admin/system/health")
  ]);

  const todayEvents = [...(calendar?.appointments ?? []), ...(calendar?.externalEvents ?? [])]
    .filter((event) => formatDayKey(new Date(event.start)) === todayKey)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const bookedEvents = todayEvents.filter((event) => {
    if (event.source !== "db") return false;
    const status = (event.status ?? "").trim().toLowerCase();
    return status !== "canceled" && status !== "cancelled" && status !== "no_show";
  });
  const projectedTodayCents = bookedEvents.reduce((sum, event) => sum + projectedEventCents(event), 0);
  const openTasks = (tasks?.tasks ?? []).filter((task) => task.status === "open");
  const dueTasks = openTasks
    .filter((task) => isDueTodayOrEarlier(task.dueAt, todayKey))
    .sort((a, b) => {
      const aDue = a.dueAt ? Date.parse(a.dueAt) : Number.MAX_SAFE_INTEGER;
      const bDue = b.dueAt ? Date.parse(b.dueAt) : Number.MAX_SAFE_INTEGER;
      return aDue - bDue;
    });

  return {
    generatedAt: new Date().toISOString(),
    todayKey,
    collectedTodayCents: normalizeCents(forecast?.totalCents),
    collectedTodayCount: typeof forecast?.count === "number" ? forecast.count : 0,
    projectedTodayCents,
    bookedJobsToday: bookedEvents.length,
    openInboxLeads: inbox?.threads?.length ?? 0,
    openFollowUps: dueTasks.length,
    health: {
      blockers: health?.blockers?.length ?? 0,
      warnings: health?.warnings?.length ?? 0,
      providers: (health?.providers ?? []).map((provider) => ({
        provider: provider.provider,
        status: provider.status,
        detail: provider.lastFailureDetail ?? null
      }))
    },
    nextAppointments: bookedEvents.slice(0, 5).map((event) => ({
      id: event.appointmentId ?? event.id,
      title: event.title,
      time: new Intl.DateTimeFormat("en-US", {
        timeZone: TEAM_TIME_ZONE,
        hour: "numeric",
        minute: "2-digit"
      }).format(new Date(event.start)),
      contactName: event.contactName ?? null,
      address: event.address ?? null,
      status: event.status ?? null,
      projectedCents: projectedEventCents(event)
    })),
    inboxLeads: (inbox?.threads ?? []).slice(0, 4).map((thread) => ({
      id: thread.id,
      contactName: thread.contact?.name ?? "Unknown lead",
      preview: thread.lastMessagePreview ?? thread.subject ?? "No preview",
      lastMessageAt: thread.lastMessageAt ?? null
    })),
    followUps: dueTasks.slice(0, 4).map((task) => ({
      id: task.id,
      title: task.title,
      dueAt: task.dueAt
    }))
  };
}

type CalendarBadgeTone = "ok" | "warn" | "alert" | "idle";

interface CalendarStatusApiResponse {
  ok: boolean;
  config: {
    calendarId: string | null;
    webhookConfigured: boolean;
  };
  status: {
    calendarId: string;
    syncTokenPresent: boolean;
    channelId: string | null;
    resourceId: string | null;
    channelExpiresAt: string | null;
    lastSyncedAt: string | null;
    lastNotificationAt: string | null;
    updatedAt: string | null;
  } | null;
  error?: string;
}

interface CalendarSyncBadge {
  tone: CalendarBadgeTone;
  headline: string;
  detail?: string;
}

const defaultCalendarBadge: CalendarSyncBadge = {
  tone: "idle",
  headline: "Status unavailable"
};

export function evaluateCalendarHealth(payload: CalendarStatusApiResponse): CalendarSyncBadge {
  if (!payload.ok) {
    return {
      tone: "alert",
      headline: "Status unavailable",
      detail: payload.error
    };
  }

  if (!payload.config.calendarId) {
    return {
      tone: "idle",
      headline: "Calendar not configured",
      detail: "Set GOOGLE_CALENDAR_ID"
    };
  }

  if (!payload.config.webhookConfigured) {
    return {
      tone: "warn",
      headline: "Webhook missing",
      detail: "Set GOOGLE_CALENDAR_WEBHOOK_URL"
    };
  }

  const status = payload.status;
  if (!status) {
    return {
      tone: "warn",
      headline: "Awaiting first sync",
      detail: "No sync record yet"
    };
  }

  const lastSyncedAt = status.lastSyncedAt ? new Date(status.lastSyncedAt) : null;
  const lastNotificationAt = status.lastNotificationAt ? new Date(status.lastNotificationAt) : null;
  const channelExpiresAt = status.channelExpiresAt ? new Date(status.channelExpiresAt) : null;
  const now = Date.now();

  const missingChannel = !status.channelId;
  const missingToken = !status.syncTokenPresent;
  const staleSync = !lastSyncedAt || now - lastSyncedAt.getTime() > 3 * 60 * 60 * 1000;
  const staleNotification = !lastNotificationAt || now - lastNotificationAt.getTime() > 2 * 60 * 60 * 1000;
  const expiringSoon = !channelExpiresAt || channelExpiresAt.getTime() - now < 45 * 60 * 1000;

  const detailParts = [
    `Last sync ${formatAgo(lastSyncedAt)}`,
    `Watch renews ${formatFuture(channelExpiresAt)}`
  ];

  if (lastNotificationAt) {
    detailParts.push(`Last ping ${formatAgo(lastNotificationAt)}`);
  }

  if (missingChannel || missingToken) {
    return {
      tone: "alert",
      headline: missingChannel ? "Watch not registered" : "Sync token missing",
      detail: detailParts.join(" | ")
    };
  }

  if (staleSync) {
    return {
      tone: "warn",
      headline: "Sync lagging",
      detail: detailParts.join(" | ")
    };
  }

  if (staleNotification) {
    return {
      tone: "warn",
      headline: "No recent webhook",
      detail: detailParts.join(" | ")
    };
  }

  if (expiringSoon) {
    return {
      tone: "warn",
      headline: "Watch renews soon",
      detail: detailParts.join(" | ")
    };
  }

  return {
    tone: "ok",
    headline: "Healthy",
    detail: detailParts.join(" | ")
  };
}

function formatAgo(value: Date | null): string {
  if (!value) return "never";
  const diff = Date.now() - value.getTime();
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatFuture(value: Date | null): string {
  if (!value) return "not scheduled";
  const diff = value.getTime() - Date.now();
  if (diff <= 0) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

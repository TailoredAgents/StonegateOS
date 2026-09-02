"use client";

import * as React from "react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCheck, LoaderCircle } from "lucide-react";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import { PartnerNotice, partnerSecondaryButtonClass } from "./PartnerPortalUi";

export type PartnerDashboardNotification = {
  id: string;
  title: string;
  body: string;
  actionPath: string | null;
  createdAt: string;
};

export function PartnerNotificationList({
  initialNotifications,
}: {
  initialNotifications: PartnerDashboardNotification[];
}) {
  const router = useRouter();
  const [notifications, setNotifications] =
    React.useState(initialNotifications);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [markingAll, setMarkingAll] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const markRead = async (
    notification: PartnerDashboardNotification,
  ): Promise<boolean> => {
    if (pendingId || markingAll) return false;
    setPendingId(notification.id);
    setError(null);
    const result = await partnerPortalFetch<{
      ok: true;
      notification: { id: string; readAt: string };
    }>(`notifications/${encodeURIComponent(notification.id)}/read`, {
      method: "POST",
      headers: {
        "Idempotency-Key": createPortalOperationKey("notification-read"),
      },
      body: JSON.stringify({}),
    }).catch(() => null);
    setPendingId(null);
    if (!result?.ok) {
      setError(
        result?.error.message ??
          "That update could not be marked as read. Nothing else changed.",
      );
      return false;
    }
    setNotifications((current) =>
      current.filter((item) => item.id !== notification.id),
    );
    router.refresh();
    return true;
  };

  const markAllRead = async (): Promise<void> => {
    if (pendingId || markingAll) return;
    setMarkingAll(true);
    setError(null);
    const result = await partnerPortalFetch<{
      ok: true;
      markedRead: number;
      readAt: string;
    }>("notifications/read-all", {
      method: "POST",
      headers: {
        "Idempotency-Key": createPortalOperationKey("notifications-read-all"),
      },
      body: JSON.stringify({}),
    }).catch(() => null);
    setMarkingAll(false);
    if (!result?.ok) {
      setError(
        result?.error.message ??
          "Updates could not be marked as read. Try again shortly.",
      );
      return;
    }
    setNotifications([]);
    router.refresh();
  };

  if (!notifications.length) {
    return (
      <div role="status" className="text-sm text-slate-600">
        All visible updates are marked as read.
      </div>
    );
  }

  return (
    <div>
      {error ? (
        <PartnerNotice tone="error" className="mb-3">
          {error}
        </PartnerNotice>
      ) : null}
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={markingAll || Boolean(pendingId)}
          className={partnerSecondaryButtonClass}
        >
          {markingAll ? (
            <LoaderCircle
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <CheckCheck className="h-4 w-4" aria-hidden="true" />
          )}
          {markingAll ? "Marking updates…" : "Mark all read"}
        </button>
      </div>
      <ul className="space-y-2">
        {notifications.map((notification) => {
          const href = (notification.actionPath ?? "/partners/overview") as Route;
          const pending = pendingId === notification.id;
          return (
            <li
              key={notification.id}
              className="rounded-xl border border-slate-200 px-4 py-3"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-950">
                    {notification.title}
                  </span>
                  <span className="mt-0.5 block text-sm leading-5 text-slate-600">
                    {notification.body}
                  </span>
                </div>
                <Link
                  href={href}
                  onClick={(event) => {
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    ) {
                      return;
                    }
                    event.preventDefault();
                    void markRead(notification).then((marked) => {
                      if (marked) router.push(href);
                    });
                  }}
                  aria-disabled={pending}
                  className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-primary-800 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                  {pending ? (
                    <LoaderCircle
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  )}
                  {pending ? "Opening…" : "Open"}
                </Link>
              </div>
              <button
                type="button"
                onClick={() => void markRead(notification)}
                disabled={pending || markingAll || Boolean(pendingId)}
                className="mt-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:opacity-60"
              >
                <CheckCheck className="h-4 w-4" aria-hidden="true" />
                Mark read
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

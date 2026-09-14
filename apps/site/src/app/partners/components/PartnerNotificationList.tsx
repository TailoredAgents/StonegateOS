"use client";

import * as React from "react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCheck, LoaderCircle } from "lucide-react";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  portalSupportReferenceFromResponse,
  withPortalSupportReference,
} from "../lib/portal-v2";
import { parsePortalNotifications } from "../lib/portal-read-models";
import { PartnerNotice, partnerSecondaryButtonClass } from "./PartnerPortalUi";

export type PartnerDashboardNotification = {
  id: string;
  title: string;
  body: string;
  actionPath: string | null;
  createdAt: string;
  readAt?: string | null;
};

export function PartnerNotificationList({
  initialNotifications,
  initialNextCursor = null,
  state = "unread",
  pageLimit = 5,
}: {
  initialNotifications: PartnerDashboardNotification[];
  initialNextCursor?: string | null;
  state?: "all" | "unread";
  pageLimit?: number;
}) {
  const router = useRouter();
  const [notifications, setNotifications] =
    React.useState(initialNotifications);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [markingAll, setMarkingAll] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [nextCursor, setNextCursor] = React.useState(initialNextCursor);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const loadedOlder = React.useRef(false);
  React.useEffect(() => {
    setNotifications((current) =>
      loadedOlder.current
        ? [
            ...new Map(
              [...current, ...initialNotifications].map((item) => [
                item.id,
                item,
              ]),
            ).values(),
          ].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : initialNotifications,
    );
    if (!loadedOlder.current) setNextCursor(initialNextCursor);
  }, [initialNotifications, initialNextCursor]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const result = await partnerPortalFetch<{
      notifications: PartnerDashboardNotification[];
      page: { nextCursor: string | null };
    }>(
      `notifications?state=${state}&limit=${pageLimit}&cursor=${encodeURIComponent(nextCursor)}`,
      { signal: AbortSignal.timeout(8_000) },
    ).catch(() => null);
    setLoadingMore(false);
    const parsed = result?.ok ? parsePortalNotifications(result.data) : null;
    if (!result?.ok || !parsed) {
      setError(
        withPortalSupportReference(
          "Older updates could not be loaded. Try again.",
          portalSupportReferenceFromResponse(result?.response),
        ),
      );
      return;
    }
    setError((current) =>
      current?.startsWith("Older updates could not be loaded. Try again.")
        ? null
        : current,
    );
    loadedOlder.current = true;
    setNotifications((current) => [
      ...new Map(
        [...current, ...parsed.items].map((item) => [item.id, item]),
      ).values(),
    ]);
    setNextCursor(parsed.nextCursor);
  };

  const markRead = async (
    notification: PartnerDashboardNotification,
  ): Promise<boolean> => {
    if (pendingId || markingAll || notification.readAt) return false;
    setPendingId(notification.id);
    setError(null);
    const result = await partnerPortalFetch<{
      ok: true;
      notification: { id: string; readAt: string };
    }>(`notifications/${encodeURIComponent(notification.id)}/read`, {
      method: "POST",
      signal: AbortSignal.timeout(8_000),
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
      state === "unread"
        ? current.filter((item) => item.id !== notification.id)
        : current.map((item) =>
            item.id === notification.id
              ? { ...item, readAt: new Date().toISOString() }
              : item,
          ),
    );
    router.refresh();
    return true;
  };

  const markAllRead = async (): Promise<void> => {
    if (pendingId || markingAll) return;
    setMarkingAll(true);
    setError(null);
    // Keep a long history from producing hundreds of concurrent mutations.
    const unread = notifications.filter((item) => !item.readAt);
    const results: Array<{ id: string; ok: boolean }> = [];
    for (let index = 0; index < unread.length; index += 5) {
      const batch = await Promise.all(
        unread.slice(index, index + 5).map(async (notification) => ({
          id: notification.id,
          ok:
            (
              await partnerPortalFetch(
                `notifications/${encodeURIComponent(notification.id)}/read`,
                {
                  method: "POST",
                  signal: AbortSignal.timeout(8_000),
                  headers: {
                    "Idempotency-Key":
                      createPortalOperationKey("notification-read"),
                  },
                  body: JSON.stringify({}),
                },
              ).catch(() => null)
            )?.ok === true,
        })),
      );
      results.push(...batch);
    }
    setMarkingAll(false);
    const completed = new Set(
      results.filter((item) => item.ok).map((item) => item.id),
    );
    setNotifications((current) =>
      state === "unread"
        ? current.filter((item) => !completed.has(item.id))
        : current.map((item) =>
            completed.has(item.id)
              ? { ...item, readAt: new Date().toISOString() }
              : item,
          ),
    );
    if (completed.size !== results.length) {
      setError("Some updates could not be marked as read. Try again shortly.");
      return;
    }
    router.refresh();
  };

  if (!notifications.length && !nextCursor) {
    return (
      <div role="status" className="text-sm text-slate-600">
        {state === "all"
          ? "No updates yet."
          : "All visible updates are marked as read."}
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
          disabled={
            markingAll ||
            Boolean(pendingId) ||
            notifications.every((item) => item.readAt)
          }
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
          {markingAll ? "Marking updates…" : "Mark these read"}
        </button>
      </div>
      <ul className="space-y-2">
        {notifications.map((notification) => {
          const href = (notification.actionPath ??
            "/partners/overview") as Route;
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
                    // Navigation is independent from best-effort read tracking.
                    void markRead(notification);
                  }}
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
                disabled={
                  Boolean(notification.readAt) ||
                  pending ||
                  markingAll ||
                  Boolean(pendingId)
                }
                className="mt-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:opacity-60"
              >
                <CheckCheck className="h-4 w-4" aria-hidden="true" />
                {notification.readAt ? "Read" : "Mark read"}
              </button>
            </li>
          );
        })}
      </ul>
      {nextCursor ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className={`${partnerSecondaryButtonClass} mt-3`}
        >
          {loadingMore ? "Loading…" : "Older updates"}
        </button>
      ) : null}
    </div>
  );
}

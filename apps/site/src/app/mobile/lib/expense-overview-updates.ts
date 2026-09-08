export const EXPENSE_OVERVIEW_REFRESH_MS = 10_000;
const REQUEST_TIMEOUT_MS = 8_000;

export class ExpenseOverviewRefreshError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

/** Refresh visible totals without overlapping requests or replacing form state. */
export function startExpenseOverviewUpdates<T>(callbacks: {
  load: (signal: AbortSignal) => Promise<T>;
  onValue: (value: T) => void;
  onError: (error: unknown) => void;
  onRefreshing: (refreshing: boolean) => void;
  onOnline: (online: boolean) => void;
}): { refresh: () => void; stop: () => void } {
  let stopped = false;
  let accessDenied = false;
  let failures = 0;
  let pending = false;
  let active: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryAt = 0;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const canRefresh = () =>
    !stopped &&
    !accessDenied &&
    navigator.onLine &&
    document.visibilityState === "visible";

  const schedule = (delay: number) => {
    clearTimer();
    if (canRefresh()) timer = setTimeout(refresh, delay);
  };

  const refresh = () => {
    if (!canRefresh()) return;
    if (Date.now() < retryAt) {
      schedule(retryAt - Date.now());
      return;
    }
    if (active) {
      pending = true;
      return;
    }
    clearTimer();
    const controller = new AbortController();
    active = controller;
    callbacks.onRefreshing(true);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    void callbacks
      .load(controller.signal)
      .then((value) => {
        if (stopped || controller.signal.aborted) return;
        failures = 0;
        retryAt = 0;
        callbacks.onValue(value);
      })
      .catch((error: unknown) => {
        if (stopped) return;
        failures += 1;
        accessDenied =
          error instanceof ExpenseOverviewRefreshError &&
          (error.status === 401 || error.status === 403);
        if (
          error instanceof ExpenseOverviewRefreshError &&
          error.status === 429
        ) {
          retryAt =
            Date.now() +
            Math.max(EXPENSE_OVERVIEW_REFRESH_MS, error.retryAfterMs);
        }
        callbacks.onError(error);
      })
      .finally(() => {
        clearTimeout(timeout);
        active = null;
        if (stopped) return;
        callbacks.onRefreshing(false);
        const delay = Math.max(
          retryAt - Date.now(),
          failures
            ? Math.min(
                60_000,
                EXPENSE_OVERVIEW_REFRESH_MS * 2 ** (failures - 1),
              )
            : pending
              ? 0
              : EXPENSE_OVERVIEW_REFRESH_MS,
        );
        pending = false;
        schedule(delay);
      });
  };

  const onResume = () => refresh();
  const onVisibility = () => {
    if (document.visibilityState === "visible") refresh();
    else clearTimer();
  };
  const onConnection = () => {
    callbacks.onOnline(navigator.onLine);
    if (navigator.onLine) refresh();
    else clearTimer();
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onResume);
  window.addEventListener("pageshow", onResume);
  window.addEventListener("online", onConnection);
  window.addEventListener("offline", onConnection);
  callbacks.onOnline(navigator.onLine);
  refresh();

  return {
    refresh,
    stop: () => {
      stopped = true;
      clearTimer();
      active?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("online", onConnection);
      window.removeEventListener("offline", onConnection);
    },
  };
}

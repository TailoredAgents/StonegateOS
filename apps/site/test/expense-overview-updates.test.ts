import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import {
  EXPENSE_OVERVIEW_REFRESH_MS,
  ExpenseOverviewRefreshError,
  startExpenseOverviewUpdates,
} from "../src/app/mobile/lib/expense-overview-updates";

const cleanups = new WeakMap<TestContext, Array<() => void>>();

function browser(t: TestContext, initiallyOnline = true) {
  const cleanup: Array<() => void> = [];
  cleanups.set(t, cleanup);
  t.after(() => cleanup.forEach((run) => run()));
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  const navigator = { onLine: initiallyOnline };
  for (const [key, value] of Object.entries({ window, document, navigator })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    cleanup.push(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  return {
    window,
    visibility: (value: "visible" | "hidden") => {
      document.visibilityState = value;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    online: (value: boolean) => {
      navigator.onLine = value;
      window.dispatchEvent(new Event(value ? "online" : "offline"));
    },
  };
}

function start(t: TestContext, load: (signal: AbortSignal) => Promise<number>) {
  const values: number[] = [];
  const errors: unknown[] = [];
  const refreshing: boolean[] = [];
  const online: boolean[] = [];
  const updates = startExpenseOverviewUpdates({
    load,
    onValue: (value) => values.push(value),
    onError: (error) => errors.push(error),
    onRefreshing: (value) => refreshing.push(value),
    onOnline: (value) => online.push(value),
  });
  cleanups.get(t)?.unshift(updates.stop);
  return { ...updates, values, errors, refreshing, online };
}

function deferred() {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

void test("open totals pick up completed-job labor on the next ten-second check", async (t) => {
  browser(t);
  let serverLabor = 107_670;
  const updates = start(t, () => Promise.resolve(serverLabor));
  await setImmediate();
  assert.deepEqual(updates.values, [107_670]);

  serverLabor = 123_395;
  t.mock.timers.tick(EXPENSE_OVERVIEW_REFRESH_MS - 1);
  await setImmediate();
  assert.deepEqual(updates.values, [107_670]);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(updates.values, [107_670, 123_395]);
  assert.deepEqual(updates.refreshing, [true, false, true, false]);

  serverLabor = 130_000;
  updates.refresh();
  await setImmediate();
  assert.equal(updates.values.at(-1), 130_000, "manual refresh is immediate");
});

void test("hidden and offline screens pause polling; returning and reconnecting refresh immediately", async (t) => {
  const env = browser(t);
  let requests = 0;
  const updates = start(t, () => Promise.resolve(++requests));
  await setImmediate();
  env.visibility("hidden");
  t.mock.timers.tick(60_000);
  env.window.dispatchEvent(new Event("focus"));
  await setImmediate();
  assert.equal(requests, 1);

  env.visibility("visible");
  await setImmediate();
  assert.equal(requests, 2);
  env.online(false);
  t.mock.timers.tick(60_000);
  updates.refresh();
  await setImmediate();
  assert.equal(requests, 2);
  env.online(true);
  await setImmediate();
  assert.equal(requests, 3);
  env.window.dispatchEvent(new Event("pageshow"));
  await setImmediate();
  env.window.dispatchEvent(new Event("focus"));
  await setImmediate();
  assert.equal(requests, 5);
  assert.deepEqual(updates.online, [true, false, true]);
});

void test("opening while offline waits for a connection without issuing a doomed read", async (t) => {
  const env = browser(t, false);
  const updates = start(t, () => Promise.resolve(100));
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.deepEqual(updates.values, []);
  assert.deepEqual(updates.refreshing, []);
  assert.deepEqual(updates.online, [false]);
  env.online(true);
  await setImmediate();
  assert.deepEqual(updates.values, [100]);
});

void test("resume and manual events coalesce without concurrent requests", async (t) => {
  const env = browser(t);
  const first = deferred();
  const second = deferred();
  let requests = 0;
  const updates = start(t, () =>
    ++requests === 1 ? first.promise : second.promise,
  );
  updates.refresh();
  updates.refresh();
  env.window.dispatchEvent(new Event("focus"));
  assert.equal(requests, 1);
  first.resolve(100);
  await setImmediate();
  t.mock.timers.tick(0);
  assert.equal(requests, 2);
  second.resolve(200);
  await setImmediate();
  assert.deepEqual(updates.values, [100, 200]);
  t.mock.timers.tick(EXPENSE_OVERVIEW_REFRESH_MS - 1);
  assert.equal(requests, 2);
});

void test("leaving the overview or switching weeks aborts the old request and ignores late results", async (t) => {
  const env = browser(t);
  const gate = deferred();
  let signal: AbortSignal | undefined;
  const updates = start(t, (incoming) => {
    signal = incoming;
    return gate.promise;
  });
  updates.stop();
  assert.equal(signal?.aborted, true);
  gate.resolve(999);
  await setImmediate();
  env.window.dispatchEvent(new Event("focus"));
  env.online(true);
  env.visibility("visible");
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.deepEqual(updates.values, []);
  assert.deepEqual(updates.errors, []);
  assert.deepEqual(updates.refreshing, [true], "no updates after unmount");
});

void test("temporary server failures keep the last totals, back off, then recover", async (t) => {
  browser(t);
  let requests = 0;
  const updates = start(t, () => {
    requests += 1;
    if (requests === 2 || requests === 3)
      return Promise.reject(new Error("Temporary outage"));
    return Promise.resolve(requests === 1 ? 100 : 200);
  });
  await setImmediate();
  t.mock.timers.tick(EXPENSE_OVERVIEW_REFRESH_MS);
  await setImmediate();
  assert.deepEqual(updates.values, [100]);
  assert.equal(updates.errors.length, 1);
  t.mock.timers.tick(EXPENSE_OVERVIEW_REFRESH_MS);
  await setImmediate();
  assert.equal(updates.errors.length, 2);
  t.mock.timers.tick(19_999);
  await setImmediate();
  assert.equal(requests, 3);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(updates.values, [100, 200]);
  t.mock.timers.tick(EXPENSE_OVERVIEW_REFRESH_MS);
  await setImmediate();
  assert.equal(requests, 5, "success restores the normal polling interval");
});

void test("a stalled read times out and automatically retries", async (t) => {
  browser(t);
  let requests = 0;
  let firstSignal: AbortSignal | undefined;
  const updates = start(t, (signal) => {
    requests += 1;
    if (requests > 1) return Promise.resolve(123_395);
    firstSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Timed out", "AbortError")),
        {
          once: true,
        },
      );
    });
  });
  t.mock.timers.tick(8_000);
  await setImmediate();
  assert.equal(firstSignal?.aborted, true);
  assert.equal(updates.errors.length, 1);
  assert.equal(updates.refreshing.at(-1), false);
  t.mock.timers.tick(EXPENSE_OVERVIEW_REFRESH_MS);
  await setImmediate();
  assert.deepEqual(updates.values, [123_395]);
});

for (const status of [401, 403]) {
  void test(`HTTP ${status} stops polling instead of repeatedly probing financial access`, async (t) => {
    const env = browser(t);
    let requests = 0;
    const updates = start(t, () => {
      requests += 1;
      return Promise.reject(
        new ExpenseOverviewRefreshError("Access denied", status),
      );
    });
    await setImmediate();
    t.mock.timers.tick(120_000);
    updates.refresh();
    env.window.dispatchEvent(new Event("focus"));
    env.online(true);
    await setImmediate();
    assert.equal(requests, 1);
    assert.equal(updates.errors.length, 1);
    assert.deepEqual(updates.values, []);
  });
}

void test("rate limits honor Retry-After even when focus and manual refresh fire", async (t) => {
  const env = browser(t);
  let requests = 0;
  const updates = start(t, () => {
    if (++requests === 1)
      return Promise.reject(
        new ExpenseOverviewRefreshError("Slow down", 429, 45_000),
      );
    return Promise.resolve(100);
  });
  await setImmediate();
  t.mock.timers.tick(44_999);
  updates.refresh();
  env.window.dispatchEvent(new Event("focus"));
  await setImmediate();
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(updates.values, [100]);
});

void test("a read finishing after the app is hidden does not restart background polling", async (t) => {
  const env = browser(t);
  const gate = deferred();
  let requests = 0;
  const updates = start(t, () => {
    requests += 1;
    return gate.promise;
  });
  env.visibility("hidden");
  gate.resolve(100);
  await setImmediate();
  t.mock.timers.tick(120_000);
  await setImmediate();
  assert.equal(requests, 1);
  assert.deepEqual(updates.values, [100]);
});

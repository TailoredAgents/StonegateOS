import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  clearMobileJobDraft,
  clearMobileJobDrafts,
  readMobileJobDraft,
  writeMobileJobDraft,
  type MobileJobDraftScope,
} from "../src/app/mobile/lib/mobile-job-drafts";

const scope: MobileJobDraftScope = {
  employeeId: "employee-a",
  appointmentId: "job-a",
  appointmentVersion: "2026-09-12T12:00:00Z",
  kind: "completion",
};

class MemoryStorage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  clearMobileJobDrafts();
});
afterEach(() => {
  clearMobileJobDrafts();
  Reflect.deleteProperty(globalThis, "window");
});

test("drafts isolate employee, appointment and form and report changed booking versions", () => {
  const values = { total: "0", crew: ["Alex"], requestKey: "saved-request" };
  assert.equal(writeMobileJobDraft(scope, values).persisted, true);
  assert.deepEqual(readMobileJobDraft(scope)?.values, values);
  assert.equal(readMobileJobDraft(scope)?.matchesVersion, true);
  assert.equal(
    readMobileJobDraft({ ...scope, employeeId: "employee-b" }),
    null,
  );
  assert.equal(readMobileJobDraft({ ...scope, appointmentId: "job-b" }), null);
  assert.equal(readMobileJobDraft({ ...scope, kind: "note" }), null);
  const changed = readMobileJobDraft({
    ...scope,
    appointmentVersion: "new-version",
  });
  assert.equal(changed?.matchesVersion, false);
  assert.deepEqual(changed?.values, values);
  assert.equal(changed?.appointmentVersion, scope.appointmentVersion);
  assert.equal(
    readMobileJobDraft(scope)?.matchesVersion,
    true,
    "reading a new version never rebases the saved draft",
  );
});

test("denied browser storage keeps a session draft without claiming persistence", () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      get localStorage() {
        throw new Error("disabled");
      },
    },
  });
  assert.equal(
    writeMobileJobDraft(scope, { note: "Gate code in office" }).persisted,
    false,
  );
  assert.deepEqual(readMobileJobDraft(scope)?.values, {
    note: "Gate code in office",
  });
  clearMobileJobDraft(scope);
  assert.equal(readMobileJobDraft(scope), null);
});

test("logout clears only the requested employee's drafts", () => {
  writeMobileJobDraft(scope, { note: "A" });
  const other = { ...scope, employeeId: "employee-b" };
  writeMobileJobDraft(other, { note: "B" });
  clearMobileJobDrafts(scope.employeeId);
  assert.equal(readMobileJobDraft(scope), null);
  assert.deepEqual(readMobileJobDraft(other)?.values, { note: "B" });
  clearMobileJobDrafts();
  assert.equal(storage.length, 0);
});

test("expired and corrupt stored drafts are ignored and retained records are bounded", () => {
  writeMobileJobDraft(scope, { note: "expired" });
  const key = storage.key(0)!;
  const expired = {
    ...JSON.parse(storage.getItem(key)!),
    updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
  };
  clearMobileJobDraft(scope);
  storage.setItem(key, JSON.stringify(expired));
  assert.equal(readMobileJobDraft(scope), null);
  storage.setItem(key, "invalid-json");
  assert.equal(readMobileJobDraft(scope), null);
  for (let index = 0; index < 105; index++) {
    writeMobileJobDraft(
      { ...scope, appointmentId: `bounded-${index}` },
      { note: "Draft" },
    );
  }
  assert.ok(storage.length <= 100);
  assert.equal(
    readMobileJobDraft({ ...scope, appointmentId: "bounded-104" })
      ?.matchesVersion,
    true,
  );
});

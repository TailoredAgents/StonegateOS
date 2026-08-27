const DATABASE_NAME = "stonegate-mobile";
const DATABASE_VERSION = 4;
const SNAPSHOT_STORE = "appointment-snapshots";
const MEDIA_STORE = "appointment-media";
const MEDIA_QUEUE_STORE = "media-upload-queue";
const METADATA_STORE = "app-metadata";
const EXPENSE_QUEUE_STORE = "expense-capture-queue";
const DEVICE_ID_KEY = "mobileDeviceId";
const MUTATION_STATE_PREFIX = "expense-mutation:v1:";
const IDEMPOTENCY_KEY_PREFIX = "expense-v1-";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ExpenseMutationAttempt = Readonly<{
  idempotencyKey: string;
  stateKey: string;
  generation: number;
  fingerprintHash: string;
}>;

export type ExpenseMutationGenerationStore = {
  getOrCreateDeviceId(): Promise<string>;
  getOrCreateGeneration(stateKey: string): Promise<number>;
  advanceGeneration(
    stateKey: string,
    expectedGeneration: number,
  ): Promise<void>;
};

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
  inArray: boolean,
): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Expense mutation payload numbers must be finite.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "undefined") return inArray ? null : undefined;
  if (typeof value !== "object") {
    throw new Error("Expense mutation payload contains an unsupported value.");
  }
  if (ancestors.has(value)) {
    throw new Error("Expense mutation payload cannot contain a cycle.");
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    !Array.isArray(value)
  ) {
    throw new Error("Expense mutation payload must use plain objects.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalize(entry, ancestors, true) ?? null);
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = canonicalize(
        (value as Record<string, unknown>)[key],
        ancestors,
        false,
      );
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalExpenseMutationPayload(value: unknown): string {
  const normalized = canonicalize(value, new Set(), false);
  if (normalized === undefined) {
    throw new Error("Expense mutation payload is required.");
  }
  return JSON.stringify(normalized);
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Secure expense retry storage is unavailable.");
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("expense_mutation_aborted")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("expense_mutation_failed")),
      { once: true },
    );
  });
}

function ensureDatabaseStores(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
    const store = database.createObjectStore(SNAPSHOT_STORE, {
      keyPath: "key",
    });
    store.createIndex("employeeId", "employeeId", { unique: false });
    store.createIndex("expiresAt", "expiresAt", { unique: false });
  }
  if (!database.objectStoreNames.contains(MEDIA_STORE)) {
    const store = database.createObjectStore(MEDIA_STORE, { keyPath: "key" });
    store.createIndex("employeeId", "employeeId", { unique: false });
    store.createIndex("appointmentId", "appointmentId", { unique: false });
  }
  if (!database.objectStoreNames.contains(MEDIA_QUEUE_STORE)) {
    const store = database.createObjectStore(MEDIA_QUEUE_STORE, {
      keyPath: "clientId",
    });
    store.createIndex("employeeId", "employeeId", { unique: false });
    store.createIndex("appointmentId", "appointmentId", { unique: false });
  }
  if (!database.objectStoreNames.contains(METADATA_STORE)) {
    database.createObjectStore(METADATA_STORE, { keyPath: "key" });
  }
  if (!database.objectStoreNames.contains(EXPENSE_QUEUE_STORE)) {
    const store = database.createObjectStore(EXPENSE_QUEUE_STORE, {
      keyPath: "clientCaptureId",
    });
    store.createIndex("employeeId", "employeeId", { unique: false });
    store.createIndex("status", "status", { unique: false });
    store.createIndex("updatedAt", "updatedAt", { unique: false });
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error("Secure expense retry storage is unavailable."),
    );
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => ensureDatabaseStores(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error("expense_mutation_storage_unavailable"),
      );
  });
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

const indexedDbGenerationStore: ExpenseMutationGenerationStore = {
  async getOrCreateDeviceId() {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(METADATA_STORE, "readwrite");
      const completion = transactionDone(transaction);
      const store = transaction.objectStore(METADATA_STORE);
      const value = new Promise<string>((resolve, reject) => {
        const request = store.get(DEVICE_ID_KEY);
        request.onerror = () =>
          reject(
            request.error ?? new Error("expense_mutation_device_read_failed"),
          );
        request.onsuccess = () => {
          const existing = request.result as { value?: unknown } | undefined;
          const deviceId =
            typeof existing?.value === "string" &&
            UUID_PATTERN.test(existing.value)
              ? existing.value
              : crypto.randomUUID();
          if (deviceId !== existing?.value) {
            store.put({
              key: DEVICE_ID_KEY,
              value: deviceId,
              updatedAt: Date.now(),
            });
          }
          resolve(deviceId);
        };
      });
      const [deviceId] = await Promise.all([value, completion]);
      return deviceId;
    } finally {
      database.close();
    }
  },

  async getOrCreateGeneration(stateKey) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(METADATA_STORE, "readwrite");
      const completion = transactionDone(transaction);
      const store = transaction.objectStore(METADATA_STORE);
      const value = new Promise<number>((resolve, reject) => {
        const request = store.get(stateKey);
        request.onerror = () =>
          reject(
            request.error ?? new Error("expense_mutation_state_read_failed"),
          );
        request.onsuccess = () => {
          const existing = request.result as { value?: unknown } | undefined;
          const current = validGeneration(existing?.value) ? existing.value : 0;
          if (current !== existing?.value) {
            store.put({ key: stateKey, value: current, updatedAt: Date.now() });
          }
          resolve(current);
        };
      });
      const [generation] = await Promise.all([value, completion]);
      return generation;
    } finally {
      database.close();
    }
  },

  async advanceGeneration(stateKey, expectedGeneration) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(METADATA_STORE, "readwrite");
      const completion = transactionDone(transaction);
      const store = transaction.objectStore(METADATA_STORE);
      const advanced = new Promise<void>((resolve, reject) => {
        const request = store.get(stateKey);
        request.onerror = () =>
          reject(
            request.error ?? new Error("expense_mutation_state_read_failed"),
          );
        request.onsuccess = () => {
          const existing = request.result as { value?: unknown } | undefined;
          const current = validGeneration(existing?.value) ? existing.value : 0;
          if (current === expectedGeneration) {
            store.put({
              key: stateKey,
              value: current + 1,
              updatedAt: Date.now(),
            });
          }
          resolve();
        };
      });
      await Promise.all([advanced, completion]);
    } finally {
      database.close();
    }
  },
};

export async function getExpenseMutationAttempt(
  input: {
    employeeId: string;
    operation: string;
    payload: unknown;
  },
  store: ExpenseMutationGenerationStore = indexedDbGenerationStore,
): Promise<ExpenseMutationAttempt> {
  const employeeId = input.employeeId.trim();
  const operation = input.operation.trim();
  if (!employeeId || !operation) {
    throw new Error("Expense mutation identity is unavailable.");
  }
  const deviceId = await store.getOrCreateDeviceId();
  if (deviceId.trim().length < 16) {
    throw new Error("Secure expense retry storage is unavailable.");
  }
  const fingerprintHash = await sha256(
    canonicalExpenseMutationPayload({
      deviceId,
      employeeId,
      operation,
      payload: input.payload,
      version: 1,
    }),
  );
  const stateKey = `${MUTATION_STATE_PREFIX}${fingerprintHash}`;
  const generation = await store.getOrCreateGeneration(stateKey);
  if (!validGeneration(generation)) {
    throw new Error("Secure expense retry storage is unavailable.");
  }
  const keyHash = await sha256(`${fingerprintHash}:${generation}`);
  return {
    idempotencyKey: `${IDEMPOTENCY_KEY_PREFIX}${keyHash}`,
    stateKey,
    generation,
    fingerprintHash,
  };
}

export async function acknowledgeExpenseMutationAttempt(
  attempt: ExpenseMutationAttempt,
  store: ExpenseMutationGenerationStore = indexedDbGenerationStore,
): Promise<void> {
  await store.advanceGeneration(attempt.stateKey, attempt.generation);
}

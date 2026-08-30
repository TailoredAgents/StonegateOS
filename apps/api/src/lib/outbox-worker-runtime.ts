export type OutboxWorkerBatchStats = {
  total: number;
  processed: number;
  skipped: number;
  errors: number;
};

export type OutboxWorkerConfiguration = {
  batchSize: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
};

export type OutboxWorkerHeartbeat = {
  stop: () => Promise<void>;
};

const DEFAULT_BATCH_SIZE = 10;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 0;
const MIN_CONTINUOUS_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const MIN_HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_ERROR_DETAIL_LENGTH = 500;

export class OutboxWorkerConfigurationError extends Error {
  constructor(variableName: string, requirement: string) {
    super(`${variableName} ${requirement}`);
    this.name = "OutboxWorkerConfigurationError";
  }
}

function parseIntegerSetting(input: {
  environment: Readonly<Record<string, string | undefined>>;
  variableName: string;
  fallback: number;
  minimum: number;
  maximum: number;
  allowZero?: boolean;
}): number {
  const rawValue = input.environment[input.variableName];
  if (rawValue === undefined) return input.fallback;

  const normalized = rawValue.trim();
  if (!/^(0|[1-9]\d*)$/u.test(normalized)) {
    throw new OutboxWorkerConfigurationError(
      input.variableName,
      `must be a whole number between ${input.minimum} and ${input.maximum}`,
    );
  }

  const value = Number(normalized);
  if (!Number.isSafeInteger(value)) {
    throw new OutboxWorkerConfigurationError(
      input.variableName,
      `must be a safe whole number between ${input.minimum} and ${input.maximum}`,
    );
  }
  if (input.allowZero && value === 0) return value;
  if (value < input.minimum || value > input.maximum) {
    throw new OutboxWorkerConfigurationError(
      input.variableName,
      `must be between ${input.minimum} and ${input.maximum}`,
    );
  }
  return value;
}

/**
 * Parse the settings that control queue pressure and readiness frequency.
 * Invalid explicit values fail the process instead of silently disabling the
 * worker, creating a tight loop, or dispatching an unbounded batch.
 */
export function parseOutboxWorkerConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OutboxWorkerConfiguration {
  return {
    batchSize: parseIntegerSetting({
      environment,
      variableName: "OUTBOX_BATCH_SIZE",
      fallback: DEFAULT_BATCH_SIZE,
      minimum: MIN_BATCH_SIZE,
      maximum: MAX_BATCH_SIZE,
    }),
    pollIntervalMs: parseIntegerSetting({
      environment,
      variableName: "OUTBOX_POLL_INTERVAL_MS",
      fallback: DEFAULT_POLL_INTERVAL_MS,
      minimum: MIN_CONTINUOUS_POLL_INTERVAL_MS,
      maximum: MAX_POLL_INTERVAL_MS,
      allowZero: true,
    }),
    heartbeatIntervalMs: parseIntegerSetting({
      environment,
      variableName: "OUTBOX_HEARTBEAT_INTERVAL_MS",
      fallback: DEFAULT_HEARTBEAT_INTERVAL_MS,
      minimum: MIN_HEARTBEAT_INTERVAL_MS,
      maximum: MAX_HEARTBEAT_INTERVAL_MS,
    }),
  };
}

export function shouldLogOutboxBatch(stats: OutboxWorkerBatchStats): boolean {
  return (
    stats.total > 0 ||
    stats.processed > 0 ||
    stats.skipped > 0 ||
    stats.errors > 0
  );
}

export function formatOutboxWorkerLog(
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
  now = new Date(),
): string {
  return JSON.stringify({
    ...fields,
    event,
    at: now.toISOString(),
  });
}

export function outboxWorkerErrorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.slice(0, MAX_ERROR_DETAIL_LENGTH);
}

/**
 * Keep readiness current while a batch or a scheduled provider operation is
 * awaiting I/O. Heartbeat writes never overlap, and stopping waits for the
 * active write so a later fatal heartbeat cannot be overwritten by a race.
 */
export function startOutboxWorkerHeartbeat(input: {
  intervalMs: number;
  record: () => Promise<void>;
  onError: (error: unknown) => void;
}): OutboxWorkerHeartbeat {
  let stopped = false;
  let activeWrite: Promise<void> | null = null;

  const record = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (activeWrite) return activeWrite;

    const write = Promise.resolve()
      .then(input.record)
      .catch((error: unknown) => {
        try {
          input.onError(error);
        } catch {
          // A logging failure must not turn the timer callback into an
          // unhandled rejection.
        }
      })
      .finally(() => {
        if (activeWrite === write) activeWrite = null;
      });
    activeWrite = write;
    return write;
  };

  const interval = setInterval(() => {
    void record();
  }, input.intervalMs);
  void record();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(interval);
      const pendingWrite = activeWrite;
      if (pendingWrite) await pendingWrite;
    },
  };
}

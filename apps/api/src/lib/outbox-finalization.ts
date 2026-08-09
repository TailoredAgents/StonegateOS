const OUTBOX_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

export type OutboxFinalizationOutcome = {
  status: "processed" | "skipped" | "retry";
  error?: string | null;
  nextAttemptAt?: Date | null;
};

export const OUTBOX_FINALIZATION_RECONCILIATION_REASON =
  "provider_effect_finalization_uncertain";

export function getOutboxRetryDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) {
    return OUTBOX_RETRY_DELAYS_MS[0] ?? 60_000;
  }
  const index = Math.min(attempt - 1, OUTBOX_RETRY_DELAYS_MS.length - 1);
  return (
    OUTBOX_RETRY_DELAYS_MS[index] ?? OUTBOX_RETRY_DELAYS_MS[0] ?? 60_000
  );
}

export function planOutboxOutcomeFinalization(
  event: { attempts: number | null | undefined },
  outcome: OutboxFinalizationOutcome,
  now = new Date(),
): {
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  processedAt?: Date;
} {
  const attempts = (event.attempts ?? 0) + 1;
  if (outcome.status === "retry") {
    return {
      attempts,
      nextAttemptAt:
        outcome.nextAttemptAt ??
        new Date(now.getTime() + getOutboxRetryDelayMs(attempts)),
      lastError: outcome.error ?? null,
    };
  }
  return {
    attempts,
    processedAt: now,
    nextAttemptAt: null,
    lastError: outcome.error ?? null,
  };
}

/**
 * A provider effect may already have happened when final persistence fails.
 * Contact-scoped work must therefore become terminal and operator-reviewed;
 * scheduling another attempt could duplicate a message, call, or other effect.
 */
export function planContactScopedOutboxReconciliation(
  event: { attempts: number | null | undefined },
  contactId: string,
  now = new Date(),
): {
  attempts: number;
  nextAttemptAt: null;
  lastError: string;
  quarantinedAt: Date;
  quarantinedBy: null;
  quarantineReason: typeof OUTBOX_FINALIZATION_RECONCILIATION_REASON;
  quarantinedContactId: string;
} {
  return {
    attempts: (event.attempts ?? 0) + 1,
    nextAttemptAt: null,
    lastError: "outbox_finalization_failed:reconciliation_required",
    quarantinedAt: now,
    quarantinedBy: null,
    quarantineReason: OUTBOX_FINALIZATION_RECONCILIATION_REASON,
    quarantinedContactId: contactId,
  };
}

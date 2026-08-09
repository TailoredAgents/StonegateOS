/**
 * Operator-visible policy for the primary audit ledger.
 *
 * The current database deliberately has no deletion path: an approved archive
 * and legal-hold workflow must exist before a future finite retention window
 * can safely remove online records. Until then, "indefinite" is the only
 * truthful disposition.
 */
export const AUDIT_RETENTION_POLICY = {
  onlineDisposition: "indefinite" as const,
  mutationProtection: "append_only_database_trigger" as const,
  archiveWorkflow: "not_configured" as const,
  legalHoldWorkflow: "not_configured" as const,
};

export type AuditRetentionPolicy = typeof AUDIT_RETENTION_POLICY;

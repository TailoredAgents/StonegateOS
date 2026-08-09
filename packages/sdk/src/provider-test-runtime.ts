export type ProviderTestEnvironment = Readonly<
  Record<string, string | undefined>
>;

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

/**
 * Identify an explicitly controlled provider-test runtime.
 *
 * Production artifacts require two independent sentinels so an accidentally
 * inherited E2E run id or audit-mode flag cannot enable loopback providers by
 * itself. Nonproduction keeps the existing test/development behavior where
 * either explicit sentinel activates the fail-closed loopback requirement.
 */
export function isControlledProviderTestRuntime(
  environment: ProviderTestEnvironment,
): boolean {
  const hasRunIdentity = Boolean(environment["E2E_RUN_ID"]?.trim());
  const rawAuditMode = environment["TEAM_CRM_AUDIT_MODE"]?.trim() ?? "";
  const auditMode = isTruthy(rawAuditMode);
  const production =
    environment["NODE_ENV"]?.trim().toLowerCase() === "production";

  if (production) {
    const auditModeDisabled =
      !rawAuditMode ||
      ["0", "false", "no", "off"].includes(rawAuditMode.toLowerCase());
    if (!hasRunIdentity && auditModeDisabled) return false;
    if (hasRunIdentity && rawAuditMode === "1") return true;
    throw new Error(
      "Production provider-test runtime requires both a nonempty E2E_RUN_ID and TEAM_CRM_AUDIT_MODE=1.",
    );
  }
  return hasRunIdentity || auditMode;
}

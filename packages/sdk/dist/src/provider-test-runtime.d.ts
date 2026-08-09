export type ProviderTestEnvironment = Readonly<Record<string, string | undefined>>;
/**
 * Identify an explicitly controlled provider-test runtime.
 *
 * Production artifacts require two independent sentinels so an accidentally
 * inherited E2E run id or audit-mode flag cannot enable loopback providers by
 * itself. Nonproduction keeps the existing test/development behavior where
 * either explicit sentinel activates the fail-closed loopback requirement.
 */
export declare function isControlledProviderTestRuntime(environment: ProviderTestEnvironment): boolean;
//# sourceMappingURL=provider-test-runtime.d.ts.map
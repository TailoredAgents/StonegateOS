export const PARTNER_LOCAL_REHEARSAL_DATABASES = [
  "portal_access_browser",
  "portal_eight_services_final_test_20260921",
] as const;

export function localPartnerRehearsalDatabaseUrl(): string {
  const name =
    process.env["PARTNER_ACCESS_DATABASE_NAME"] ?? "portal_access_browser";
  if (!(PARTNER_LOCAL_REHEARSAL_DATABASES as readonly string[]).includes(name))
    throw new Error(
      "Choose an explicitly allowlisted disposable partner rehearsal database.",
    );
  return `postgresql://portal_test:portal_local_only@127.0.0.1:55443/${name}`;
}

export function isLocalPartnerRehearsalDatabase(endpoint: URL): boolean {
  return (
    endpoint.protocol === "postgresql:" &&
    ["127.0.0.1", "localhost"].includes(endpoint.hostname) &&
    endpoint.port === "55443" &&
    (PARTNER_LOCAL_REHEARSAL_DATABASES as readonly string[]).includes(
      endpoint.pathname.slice(1),
    )
  );
}

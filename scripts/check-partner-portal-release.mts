/** Read-only deployed release check. Pass credentials through the environment, never argv. */
const origin = process.env["PARTNER_PORTAL_CHECK_API_URL"];
if (!origin)
  throw Error("Set PARTNER_PORTAL_CHECK_API_URL to the deployed API origin.");
const base = new URL(origin);
if (
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  (base.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(base.hostname))
)
  throw Error("Use a trusted HTTPS API origin or a local rehearsal server.");
const readinessOnly = process.argv.includes("--readiness-only");
const session = process.env["PARTNER_PORTAL_CHECK_SESSION"];
if (!readinessOnly && !session)
  throw Error(
    "A normal signed-in Partner session is required for the account checks; use --readiness-only for infrastructure checks.",
  );
async function read(path: string, authenticated = false) {
  const response = await fetch(new URL(path, base), {
    headers: authenticated
      ? { Authorization: `Bearer ${session}`, Accept: "application/json" }
      : { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok)
    throw Error(
      `${path.split("?")[0]} failed (${response.status}); inspect the correlated server log.`,
    );
  return payload;
}
const readiness = await read("/api/readyz");
if (
  readiness.checks?.partnerPortal?.state !== "ok" ||
  readiness.checks?.migrations?.state !== "ok"
)
  throw Error(
    "The deployed API lacks a passing portal or migration readiness check.",
  );
console.log(
  "Portal configuration, database migrations and server readiness passed.",
);
if (!readinessOnly) {
  const me = await read("/api/portal/v2/me", true);
  if (!me.availability?.reads || !me.availability?.writes)
    throw Error(
      "This company is not ready for normal portal reads and writes.",
    );
  const expected = process.env["PARTNER_PORTAL_CHECK_ACCOUNT_ID"];
  if (!expected || me.account?.id !== expected)
    throw Error(
      "Set the expected account ID; the signed-in company must match it.",
    );
  const capabilities = new Set(me.membership?.capabilities ?? []);
  const routes: Array<[string, string | null]> = [
    ["overview", null],
    ["jobs?limit=5", "jobs.read"],
    ["locations?limit=5", "properties.read"],
    ["service-catalog", "bookings.create"],
    ["cancellation-policy", "bookings.create"],
    ["approval-requests?limit=5", "approvals.read"],
    ["invoices?limit=5", "invoices.read"],
    ["notifications?state=all&limit=5", null],
    ["personal-profile", null],
    ["account-profile", "account.read"],
  ];
  for (const [path, permission] of routes) {
    if (permission && !capabilities.has(permission)) continue;
    await read(`/api/portal/v2/${path}`, true);
    console.log(`${path.split("?")[0]} passed.`);
  }
  console.log("Signed-in company read checks passed. No records were changed.");
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

void test("staff invoice histories are independently paginated, never silently treated as fully loaded", () => {
  const api = readFileSync(new URL("../../../../../api/app/api/admin/partner-management/v1/accounts/[accountId]/billing/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(api, /\.limit\(500\)/u);
  assert.match(api, /historyLoaded: false/u);
  const shell = readFileSync(new URL("../../team/components/PartnerBillingAdministrationClient.tsx", import.meta.url), "utf8");
  assert.match(shell, /PartnerBillingHistory/u);
  assert.match(shell, /documents:\$\{data.account.id\}:\$\{selected.id\}:\$\{selected.version\}/u);
  assert.match(shell, /refunds:\$\{data.account.id\}:\$\{selected.id\}:\$\{selected.version\}/u);
});

void test("child histories keep clear empty/loading/error/retry/end states and pass only validated staff account context", () => {
  const component = readFileSync(new URL("../../team/components/PartnerBillingHistory.tsx", import.meta.url), "utf8");
  assert.match(component, /loaded && items.length === 0/u);
  assert.match(component, /Load older records/u);
  assert.match(component, /Retry older records/u);
  assert.match(component, /Refresh history/u);
  assert.match(component, /role="alert"/u);
  assert.match(component, /aria-live="polite"/u);
  assert.match(component, /inFlight.current/u);
  assert.match(component, /End of history/u);
  const action = readFileSync(new URL("../../team/actions/partner-billing.ts", import.meta.url), "utf8");
  assert.match(action, /hasTeamPermission\(principal, "partners.commercial.read"\)/u);
  assert.match(action, /payload.accountId !== accountId/u);
  assert.match(action, /payload.invoiceId !== invoiceId/u);
  assert.match(action, /payload.kind !== kind/u);
});

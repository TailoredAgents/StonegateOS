import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(process.cwd());
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

void test("Partner invoice review UI is explicit, accessible, and never promises a refund", () => {
  const component = read(
    "src/app/partners/components/PartnerInvoiceDisputeManager.tsx",
  );
  const billing = read("src/app/partners/(portal)/billing/page.tsx");
  assert.match(component, /aria-expanded=\{open\}/u);
  assert.match(component, /aria-live="polite"/u);
  assert.match(component, /minLength=\{10\}/u);
  assert.match(component, /maxLength=\{2_000\}/u);
  assert.match(component, /Submitting records a review request only/u);
  assert.match(
    component,
    /It does not change\s+the invoice or initiate a refund/u,
  );
  assert.match(component, /mfa_step_up_required/u);
  assert.match(component, /Verify secure session/u);
  assert.match(component, /sm:grid-cols-2/u);
  assert.match(component, /Load older requests/u);
  assert.match(component, /encodeURIComponent\(cursor\)/u);
  assert.match(billing, /canRequestBillingDisputes/u);
  assert.match(billing, /PartnerInvoiceDisputeManager/u);
});

void test("Staff billing queue explains classification-only outcomes and gates decisions", () => {
  const workspace = read(
    "src/app/team/components/PartnerAdministrationSection.tsx",
  );
  const action = read("src/app/team/actions/partner-administration.ts");
  const manifest = read("src/app/team/action-policy-manifest.ts");
  assert.match(workspace, /id: "billing-disputes"/u);
  assert.match(workspace, /partners\.billing_disputes\.read/u);
  assert.match(workspace, /canDecideBillingDisputes/u);
  assert.match(workspace, /never changes the invoice balance/u);
  assert.match(workspace, /Commercial Manager or Team Owner permission/u);
  assert.match(action, /partners\.billing_disputes\.decide/u);
  assert.match(action, /No provider refund was initiated/u);
  assert.match(
    manifest,
    /partnerBillingDisputeDecisionAction: recentHumanAction/u,
  );
  assert.match(manifest, /"financial"/u);
});

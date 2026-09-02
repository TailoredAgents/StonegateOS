import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manager = readFileSync(
  new URL(
    "../../team/components/PartnerApprovalRuleManager.tsx",
    import.meta.url,
  ),
  "utf8",
);
const actions = readFileSync(
  new URL("../../team/actions/partner-approval-rules.ts", import.meta.url),
  "utf8",
);
const workspace = readFileSync(
  new URL(
    "../../team/components/PartnerAdministrationSection.tsx",
    import.meta.url,
  ),
  "utf8",
);
const manifest = readFileSync(
  new URL("../../team/action-policy-manifest.ts", import.meta.url),
  "utf8",
);

void test("Commercial administration exposes an account-scoped approval-rule manager", () => {
  assert.match(workspace, /<PartnerApprovalRuleManager/u);
  assert.match(workspace, /Manage approval rules/u);
  assert.match(workspace, /includeInactive=true/u);
  assert.match(workspace, /partners\.commercial\.manage/u);
  assert.match(manager, /Every matching active rule applies/u);
  assert.match(manager, /approvals\.decide/u);
  assert.match(manager, /requesters can never\s+approve their own work/u);
  assert.match(manager, /existing requests retain their captured version/u);
});

void test("rule forms are accessible, bounded, and support deactivation without deletion", () => {
  assert.match(manager, /min-h-\[44px\]/u);
  assert.match(manager, /aria-describedby/u);
  assert.match(manager, /name="serviceKeys"/u);
  assert.match(manager, /name="locationIds"/u);
  assert.match(manager, /name="minimumAmount"/u);
  assert.match(manager, /name="maximumAmount"/u);
  assert.match(manager, /name="requesterRoleKeys"/u);
  assert.match(manager, /name="poNumberState"/u);
  assert.match(manager, /name="costCenterState"/u);
  assert.match(manager, /Type CREATE APPROVAL RULE/u);
  assert.match(manager, /Type UPDATE APPROVAL RULE/u);
  assert.match(manager, /deactivate without deleting history/u);
  assert.doesNotMatch(manager, /Delete approval rule/u);
});

void test("server actions enforce local permission, idempotency, CAS, and safe receipts", () => {
  assert.match(actions, /partners\.commercial\.manage/u);
  assert.match(actions, /"Idempotency-Key": input\.idempotencyKey/u);
  assert.match(actions, /"If-Match": input\.expectedVersion/u);
  assert.match(actions, /CREATE APPROVAL RULE/u);
  assert.match(actions, /UPDATE APPROVAL RULE/u);
  assert.match(actions, /readTeamMutationSuccess/u);
  assert.match(actions, /unreadable approval-rule receipt/u);
  assert.match(actions, /existing requests are unchanged/u);
  assert.match(actions, /deactivated without deleting its history/u);
});

void test("both approval-rule server actions are declared in the Team action policy", () => {
  for (const action of [
    "partnerApprovalRuleCreateAction",
    "partnerApprovalRuleUpdateAction",
  ]) {
    assert.match(manifest, new RegExp(action, "u"));
  }
  assert.match(
    manifest,
    /partnerApprovalRuleCreateAction: recentHumanAction\([\s\S]*?"partners\.commercial\.manage"[\s\S]*?"financial"/u,
  );
  assert.match(
    manifest,
    /partnerApprovalRuleUpdateAction: recentHumanAction\([\s\S]*?"partners\.commercial\.manage"[\s\S]*?"financial"/u,
  );
});
